import { createHash } from 'node:crypto';
import { delimiter } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool as McpSdkTool } from '@modelcontextprotocol/sdk/types.js';
import type { DeferredToolSummary, McpServerStatus, ToolRiskLevel } from '@aurevoy/shared';
import {
  config,
  type McpServerConfig,
  type McpStdioServerConfig,
  type McpStreamableHttpServerConfig,
} from '../config.js';
import { unifiedToolRegistry } from './unified-registry.js';
import { getLogger } from '../logging/logger.js';
import { getPythonBinDir, isPythonInstalled } from '../runtime/python-runtime.js';
import { diffMcpToolChanges } from './mcp-tool-diff.js';
import {
  browserToolTier,
  isBrowserMcpServerName,
  isBrowserMcpToolAllowed,
} from './browser-permissions.js';

const mcpLog = getLogger('mcp');

const MCP_TOOL_NAME_PREFIX = 'mcp';
const MAX_TOOL_NAME_LENGTH = 64;
const MAX_MCP_DESCRIPTION_LENGTH = 500;
const SUSPICIOUS_DESCRIPTION_PATTERNS = [
  /ignore (all )?(previous|prior) instructions/i,
  /system prompt/i,
  /developer message/i,
  /reveal (secrets|credentials|api keys?)/i,
  /bypass/i,
  /do not tell/i,
];

interface McpConnection {
  serverName: string;
  client: Client;
}

export interface McpInitSummary {
  configuredServers: number;
  connectedServers: number;
  registeredTools: number;
  failedServers: number;
}

const connections: McpConnection[] = [];
const statuses = new Map<string, McpServerStatus>();

const DEFER_THRESHOLD = 8;

interface DeferredToolEntry {
  name: string;
  description: string;
  serverName: string;
  inputSchema: Record<string, unknown>;
  client: Client;
  originalName: string;
}

const deferredToolIndex = new Map<string, DeferredToolEntry>();

/**
 * 启动期连接已配置的 MCP servers，并把它们暴露的 tools 注册到统一工具注册表。
 * 单个 MCP server 失败不会阻断 Agent 引擎启动，避免可选外部能力拖垮基础功能。
 */
export async function initializeMcpTools(): Promise<McpInitSummary> {
  const enabledServers = config.mcpServers.filter((server) => server.enabled);
  const usedNames = new Set(unifiedToolRegistry.listNames());
  let connectedServers = 0;
  let registeredTools = 0;
  let failedServers = 0;

  const previousStatuses = new Map(statuses);
  statuses.clear();
  for (const server of config.mcpServers) {
    statuses.set(server.name, {
      name: server.name,
      enabled: server.enabled,
      connected: false,
      registeredTools: 0,
    });
  }

  for (const server of enabledServers) {
    try {
      const client = await connectMcpServer(server);
      connections.push({ serverName: server.name, client });
      connectedServers += 1;

      const tools = await listAllTools(client);
      const allowedTools = tools.filter((tool) => isBrowserMcpToolAllowed(
        server.name,
        tool,
        server.browserPermissionProfile,
      ));
      const blockedTools = tools.length - allowedTools.length;
      const shouldDefer = server.deferTools ?? (allowedTools.length > DEFER_THRESHOLD);
      const toolNames = allowedTools.map((tool) => tool.name).sort();
      const toolRisks = Object.fromEntries(
        allowedTools.map((tool) => [tool.name, inferRiskLevel(server, tool)]),
      );
      for (const tool of allowedTools) {
        const registeredName = makeRegistryToolName(server.name, tool.name, usedNames);
        usedNames.add(registeredName);
        unifiedToolRegistry.register(toRegistryTool(server, client, tool, registeredName));
        registeredTools += 1;
        if (shouldDefer) {
          unifiedToolRegistry.setEnabled(registeredName, false);
          deferredToolIndex.set(registeredName, {
            name: registeredName,
            description: sanitizeMcpToolDescription(server, tool),
            serverName: server.name,
            inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
            client,
            originalName: tool.name,
          });
        }
      }
      statuses.set(server.name, {
        name: server.name,
        enabled: true,
        connected: true,
        registeredTools: allowedTools.length,
        blockedTools,
        toolNames,
        toolRisks,
        changes: diffMcpToolChanges(
          previousStatuses.get(server.name)?.toolNames,
          previousStatuses.get(server.name)?.toolRisks,
          toolNames,
          toolRisks,
        ),
      });
      mcpLog.info(
        { server: server.name, transport: server.transport, toolCount: allowedTools.length, blockedTools },
        'MCP server 已连接',
      );
    } catch (err) {
      failedServers += 1;
      const error = formatError(err);
      statuses.set(server.name, {
        name: server.name,
        enabled: true,
        connected: false,
        registeredTools: 0,
        blockedTools: 0,
        toolNames: [],
        toolRisks: {},
        changes: diffMcpToolChanges(
          previousStatuses.get(server.name)?.toolNames,
          previousStatuses.get(server.name)?.toolRisks,
          [],
          {},
        ),
        error,
      });
      mcpLog.warn(
        { server: server.name, transport: server.transport, err: error },
        'MCP server 连接失败',
      );
    }
  }

  return {
    configuredServers: enabledServers.length,
    connectedServers,
    registeredTools,
    failedServers,
  };
}

export async function closeMcpTools(): Promise<void> {
  await Promise.allSettled(connections.map(({ client }) => client.close()));
  connections.length = 0;
  deferredToolIndex.clear();
}

export async function reloadMcpTools(): Promise<McpInitSummary> {
  await closeMcpTools();
  unifiedToolRegistry.unregisterBySource('mcp');
  return initializeMcpTools();
}

/** 连接测试只建立临时客户端并枚举工具，不注册到运行时，也不修改 MCP 设置。 */
export async function testMcpServer(server: McpServerConfig): Promise<{
  ok: boolean;
  connected: boolean;
  registeredTools: number;
  blockedTools?: number;
  latencyMs: number;
  error?: string;
}> {
  const startedAt = Date.now();
  let client: Client | undefined;
  try {
    client = await connectMcpServer(server);
    const tools = await listAllTools(client);
    const allowedTools = tools.filter((tool) => isBrowserMcpToolAllowed(
      server.name,
      tool,
      server.browserPermissionProfile,
    ));
    return {
      ok: true,
      connected: true,
      registeredTools: allowedTools.length,
      blockedTools: tools.length - allowedTools.length,
      latencyMs: Math.max(0, Date.now() - startedAt),
    };
  } catch (error) {
    return {
      ok: false,
      connected: false,
      registeredTools: 0,
      blockedTools: 0,
      latencyMs: Math.max(0, Date.now() - startedAt),
      error: redactMcpError(error),
    };
  } finally {
    await client?.close().catch(() => undefined);
  }
}

export function getMcpStatuses(): McpServerStatus[] {
  return config.mcpServers.map(
    (server) =>
      statuses.get(server.name) ?? {
        name: server.name,
        enabled: server.enabled,
        connected: false,
        registeredTools: 0,
        blockedTools: 0,
        toolNames: [],
        toolRisks: {},
      },
  );
}

export function getDeferredToolSummaries(): DeferredToolSummary[] {
  return [...deferredToolIndex.values()].map(({ name, description, serverName }) => ({
    name,
    description,
    serverName,
  }));
}

export function getDeferredToolSchema(toolName: string): Record<string, unknown> | undefined {
  return deferredToolIndex.get(toolName)?.inputSchema;
}

export async function executeDeferredTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const entry = deferredToolIndex.get(toolName);
  if (!entry) throw new Error(`延迟工具 "${toolName}" 不存在或已卸载`);
  const result = await entry.client.callTool({ name: entry.originalName, arguments: args });
  if (isRecord(result) && result.isError === true) throw new Error(formatMcpToolError(result));
  return result;
}

async function connectMcpServer(server: McpServerConfig): Promise<Client> {
  if (server.transport === 'streamable-http') {
    return connectStreamableHttpServer(server);
  }
  return connectStdioServer(server);
}

function createMcpClient(serverName: string): Client {
  const client = new Client({
    name: 'aurevoy-agent',
    version: '0.1.0',
  });

  client.onerror = (error) => {
    mcpLog.warn({ server: serverName, err: error.message }, 'MCP server 运行时错误');
  };
  client.onclose = () => {
    mcpLog.info({ server: serverName }, 'MCP server 连接已关闭');
  };
  return client;
}

async function connectStdioServer(server: McpStdioServerConfig): Promise<Client> {
  const client = createMcpClient(server.name);
  const transport = new StdioClientTransport(toStdioParameters(server));
  await client.connect(transport);
  return client;
}

async function connectStreamableHttpServer(server: McpStreamableHttpServerConfig): Promise<Client> {
  const client = createMcpClient(server.name);
  const url = new URL(server.url);
  const headers = server.headers ? { ...server.headers } : undefined;
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: headers ? { headers } : undefined,
  });
  await client.connect(transport);
  return client;
}

function toStdioParameters(server: McpStdioServerConfig): StdioServerParameters {
  const params: StdioServerParameters = {
    command: server.command,
    args: server.args,
  };
  if (server.cwd) params.cwd = server.cwd;
  const pythonInstalled = isPythonInstalled();
  const baseEnv = server.env ? getDefaultEnvironment() : undefined;
  if (pythonInstalled || server.env) {
    const env = { ...(baseEnv ?? getDefaultEnvironment()) };
    if (pythonInstalled) {
      env.PATH = `${getPythonBinDir()}${delimiter}${env.PATH ?? ''}`;
    }
    params.env = { ...env, ...(server.env ?? {}) };
  }
  return params;
}

async function listAllTools(client: Client): Promise<McpSdkTool[]> {
  const tools: McpSdkTool[] = [];
  let cursor: string | undefined;
  do {
    const response = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...response.tools);
    cursor = response.nextCursor;
  } while (cursor);
  return tools;
}

function toRegistryTool(
  server: McpServerConfig,
  client: Client,
  mcpTool: McpSdkTool,
  registeredName: string,
) {
  return {
    name: registeredName,
    description: sanitizeMcpToolDescription(server, mcpTool),
    inputSchema: mcpTool.inputSchema,
    riskLevel: inferRiskLevel(server, mcpTool),
    executionPolicy: { parallelizable: false, requiresExplicitApproval: true },
    source: { type: 'mcp' as const, serverName: server.name, originalName: mcpTool.name },
    async execute(args: Record<string, unknown>) {
      const result = await client.callTool({
        name: mcpTool.name,
        arguments: args,
      });
      if (isMcpErrorResult(result)) throw new Error(formatMcpToolError(result));
      return {
        untrusted: true,
        server: server.name,
        tool: mcpTool.name,
        result,
      };
    },
  };
}

function inferRiskLevel(server: McpServerConfig, tool: McpSdkTool): ToolRiskLevel {
  if (server.riskLevel) return server.riskLevel;
  if (isBrowserMcpServerName(server.name)) {
    const tier = browserToolTier(tool);
    if (tier === 'read_only') return 'safe';
    if (tier === 'submit') return 'dangerous';
    return 'caution';
  }
  if (tool.annotations?.destructiveHint) return 'dangerous';
  if (tool.annotations?.readOnlyHint && !tool.annotations.openWorldHint) return 'safe';
  return 'caution';
}

function sanitizeMcpToolDescription(server: McpServerConfig, tool: McpSdkTool): string {
  const fallback = `MCP tool "${tool.name}" from server "${server.name}"`;
  const raw = tool.description ?? tool.title ?? fallback;
  const compact = raw.replace(/\s+/g, ' ').trim();
  const suspicious = SUSPICIOUS_DESCRIPTION_PATTERNS.some((pattern) => pattern.test(compact));
  const truncated =
    compact.length > MAX_MCP_DESCRIPTION_LENGTH
      ? `${compact.slice(0, MAX_MCP_DESCRIPTION_LENGTH)}…`
      : compact;
  if (!suspicious) return truncated || fallback;
  return `[MCP 描述已净化：疑似 prompt injection，原描述未注入模型上下文] ${fallback}`;
}

function makeRegistryToolName(serverName: string, toolName: string, usedNames: Set<string>): string {
  const raw = `${MCP_TOOL_NAME_PREFIX}_${serverName}_${toolName}`;
  const sanitized = sanitizeToolName(raw);
  let candidate = shrinkToolName(sanitized, raw);
  let counter = 2;
  while (usedNames.has(candidate)) {
    const suffix = `_${counter}`;
    candidate = shrinkToolName(`${sanitized}${suffix}`, `${raw}${suffix}`);
    counter += 1;
  }
  return candidate;
}

function sanitizeToolName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_');
  return sanitized.replace(/^_+|_+$/g, '') || `${MCP_TOOL_NAME_PREFIX}_tool`;
}

function shrinkToolName(value: string, hashSource: string): string {
  if (value.length <= MAX_TOOL_NAME_LENGTH) return value;
  const hash = createHash('sha1').update(hashSource).digest('hex').slice(0, 8);
  return `${value.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

function isMcpErrorResult(result: unknown): boolean {
  return isRecord(result) && result.isError === true;
}

function formatMcpToolError(result: unknown): string {
  if (!isRecord(result)) return 'MCP 工具执行失败';
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((item) => (isRecord(item) && typeof item.text === 'string' ? item.text : undefined))
    .filter((item): item is string => Boolean(item))
    .join('\n');
  return text || 'MCP 工具执行失败';
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function redactMcpError(err: unknown): string {
  return formatError(err)
    .replace(/((?:authorization|api[_-]?key|token|secret|password|cookie)\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
    .slice(0, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
