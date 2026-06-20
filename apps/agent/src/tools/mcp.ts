import { createHash } from 'node:crypto';
import { delimiter } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool as McpSdkTool } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerStatus, ToolDescriptor, ToolRiskLevel } from '@aurevoy/shared';
import { config, type McpServerConfig } from '../config.js';
import { toolRegistry } from './registry.js';
import { getLogger } from '../logging/logger.js';
import { getPythonBinDir, isPythonInstalled } from '../runtime/python-runtime.js';

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

/**
 * 启动期连接已配置的 MCP servers，并把它们暴露的 tools 注册到统一 ToolRegistry。
 * 单个 MCP server 失败不会阻断 Agent 引擎启动，避免可选外部能力拖垮基础功能。
 */
export async function initializeMcpTools(): Promise<McpInitSummary> {
  const enabledServers = config.mcpServers.filter((server) => server.enabled);
  const usedNames = new Set(toolRegistry.listAll().map((tool) => tool.name));
  let connectedServers = 0;
  let registeredTools = 0;
  let failedServers = 0;

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
      const client = await connectStdioServer(server);
      connections.push({ serverName: server.name, client });
      connectedServers += 1;

      const tools = await listAllTools(client);
      for (const tool of tools) {
        const registeredName = makeRegistryToolName(server.name, tool.name, usedNames);
        usedNames.add(registeredName);
        toolRegistry.register(toRegistryTool(server, client, tool, registeredName));
        registeredTools += 1;
      }
      statuses.set(server.name, {
        name: server.name,
        enabled: true,
        connected: true,
        registeredTools: tools.length,
      });
      mcpLog.info({ server: server.name, toolCount: tools.length }, 'MCP server 已连接');
    } catch (err) {
      failedServers += 1;
      const error = formatError(err);
      statuses.set(server.name, {
        name: server.name,
        enabled: true,
        connected: false,
        registeredTools: 0,
        error,
      });
      mcpLog.warn({ server: server.name, err: error }, 'MCP server 连接失败');
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
}

export async function reloadMcpTools(): Promise<McpInitSummary> {
  await closeMcpTools();
  toolRegistry.unregisterMcpTools();
  return initializeMcpTools();
}

export function getMcpStatuses(): McpServerStatus[] {
  return config.mcpServers.map(
    (server) =>
      statuses.get(server.name) ?? {
        name: server.name,
        enabled: server.enabled,
        connected: false,
        registeredTools: 0,
      },
  );
}

async function connectStdioServer(server: McpServerConfig): Promise<Client> {
  const client = new Client({
    name: 'aurevoy-agent',
    version: '0.1.0',
  });

  client.onerror = (error) => {
    mcpLog.warn({ server: server.name, err: error.message }, 'MCP server 运行时错误');
  };
  client.onclose = () => {
    mcpLog.info({ server: server.name }, 'MCP server 连接已关闭');
  };

  const transport = new StdioClientTransport(toStdioParameters(server));
  await client.connect(transport);
  return client;
}

function toStdioParameters(server: McpServerConfig): StdioServerParameters {
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
  const descriptor: ToolDescriptor = {
    name: registeredName,
    description: sanitizeMcpToolDescription(server, mcpTool),
    inputSchema: mcpTool.inputSchema,
    riskLevel: inferRiskLevel(server, mcpTool),
    source: { type: 'mcp', serverName: server.name, originalName: mcpTool.name },
  };

  return {
    descriptor,
    async execute(args: Record<string, unknown>) {
      const result = await client.callTool({
        name: mcpTool.name,
        arguments: args,
      });
      if (isMcpErrorResult(result)) throw new Error(formatMcpToolError(result));
      return {
        server: server.name,
        tool: mcpTool.name,
        result,
      };
    },
  };
}

function inferRiskLevel(server: McpServerConfig, tool: McpSdkTool): ToolRiskLevel {
  if (server.riskLevel) return server.riskLevel;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
