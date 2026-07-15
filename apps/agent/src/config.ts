import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { AGENT_DEFAULT_HOST, AGENT_DEFAULT_PORT, type ToolRiskLevel } from '@aurevoy/shared';

export interface McpServerConfig {
  name: string;
  transport: 'stdio';
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled: boolean;
  /** MCP 工具缺省风险等级；不填时按 tool annotations 推断，兜底为 caution。 */
  riskLevel?: ToolRiskLevel;
}

/**
 * 运行时配置。
 *
 * **环境变量只承担运维/进程面**（监听、路径、日志、CORS）。
 * LLM / MCP / 搜索 / embedding / 预算 / 沙箱开关等产品配置走
 * SQLite 设置页（`runtime/settings`），此处仅为代码默认值。
 */
export const config = {
  /** 日志（运维） */
  logging: {
    level: (process.env.AUREVOY_LOG_LEVEL ?? 'info') as
      | 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    file: process.env.AUREVOY_LOG_FILE ?? resolve(homedir(), '.aurevoy', 'logs', 'aurevoy.log'),
    pretty: process.env.AUREVOY_LOG_PRETTY !== 'false',
  },

  host: process.env.AUREVOY_HOST ?? AGENT_DEFAULT_HOST,
  port: Number(process.env.AUREVOY_PORT ?? AGENT_DEFAULT_PORT),
  dbPath: process.env.AUREVOY_DB_PATH ?? resolve(homedir(), '.aurevoy', 'aurevoy.sqlite'),
  workspaceDir: process.env.AUREVOY_WORKSPACE_DIR ?? resolve(homedir(), '.aurevoy', 'workspace'),
  corsOrigins: (process.env.AUREVOY_CORS_ORIGINS ?? '*')
    .split(',')
    .map((s) => s.trim()),

  /**
   * LLM 默认值（未配置设置时）。
   * 真源：设置页 / SQLite 分槽；密钥与 OAuth 在 CredentialStore。
   */
  llm: {
    provider: 'openai',
    apiKey: '',
    baseUrl: '',
    model: '',
    temperature: 0.7,
    timeoutMs: 120_000,
    maxTokens: 8192,
  },

  agent: {
    approvalTimeoutMs: 5 * 60 * 1000,
    thinkingLevel: 'off' as 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
    toolExecution: 'parallel' as 'sequential' | 'parallel',
    subagentMaxConcurrency: 4,
    contextCharBudget: 1_000_000,
    recentMessageWindow: 8,
    compressedMessageCharCap: 600,
    maxScoutRounds: 3,
    llmPlanningEnabled: true,
    toolTimeoutMs: 30_000,
    toolOutputMaxChars: 50_000,
    contextTokenBudget: 400_000,
    compactThreshold: 0.85,
    compactKeepRecentTurns: 5,
  },

  skills: {
    userDir: resolveUserSkillsDir(),
    agentsUserDir: resolveAgentsUserSkillsDir(),
    claudeUserDir: resolveClaudeUserSkillsDir(),
    codexUserDir: resolveCodexUserSkillsDir(),
    workspaceSubDir: '.aurevoy/skills',
    agentsWorkspaceSubDir: '.agents/skills',
    claudeWorkspaceSubDir: '.claude/skills',
    codexWorkspaceSubDir: '.codex/skills',
    builtinDir: resolveBuiltinSkillsDir(),
  },

  sandbox: {
    /** 默认关；由设置页启用 */
    commandExecutionEnabled: false,
    commandTimeoutMs: 30_000,
    commandOutputLimitBytes: 64 * 1024,
    commandEnvAllowlist: ['PATH', 'HOME', 'TMPDIR'],
  },

  autoMode: {
    level: 'auto' as string,
  },

  budget: {
    run: {
      maxIterations: 120,
      maxToolCalls: 300,
      maxWallTimeMs: 45 * 60 * 1000,
      maxOutputBytes: 2 * 1024 * 1024,
    },
    lifetime: {
      maxIterations: 500,
      maxToolCalls: 1500,
      maxWallTimeMs: 3 * 60 * 60 * 1000,
      maxOutputBytes: 10 * 1024 * 1024,
    },
  },

  network: {
    httpFetchPrivateHostAllowlist: [] as string[],
  },

  python: {
    venvDir: resolve(homedir(), '.aurevoy', 'venv'),
    userPath: '',
  },

  /** MCP：仅设置页 JSON；启动默认空 */
  mcpServers: [] as McpServerConfig[],

  embedding: {
    provider: 'off' as 'openai' | 'off',
    model: 'nomic-embed-text',
    baseUrl: '',
    apiKey: '',
    timeoutMs: 10_000,
  },

  search: {
    provider: 'duckduckgo_lite' as 'duckduckgo_lite' | 'tavily' | 'searxng' | 'custom',
    baseUrl: '',
    apiKey: '',
  },
};

/** 解析数字（设置页 / 测试补丁用）；非法或缺失时回退默认值。 */
export function parseNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw != null && raw !== '' && !Number.isNaN(n) ? n : fallback;
}

/**
 * 回归脚本在 import config 后调用，注入 LLM/沙箱等产品配置。
 * 生产路径不使用：产品配置只来自设置页。
 */
export function applyTestProductConfig(patch: {
  llm?: Partial<typeof config.llm>;
  agent?: Partial<typeof config.agent>;
  sandbox?: Partial<typeof config.sandbox>;
  embedding?: Partial<typeof config.embedding>;
  search?: Partial<typeof config.search>;
  network?: Partial<typeof config.network>;
  skills?: Partial<typeof config.skills>;
  mcpServers?: McpServerConfig[];
}): void {
  if (patch.llm) Object.assign(config.llm, patch.llm);
  if (patch.agent) Object.assign(config.agent, patch.agent);
  if (patch.sandbox) Object.assign(config.sandbox, patch.sandbox);
  if (patch.embedding) Object.assign(config.embedding, patch.embedding);
  if (patch.search) Object.assign(config.search, patch.search);
  if (patch.network) Object.assign(config.network, patch.network);
  if (patch.skills) Object.assign(config.skills, patch.skills);
  if (patch.mcpServers) config.mcpServers = patch.mcpServers;
}

/**
 * 仅回归脚本：`AUREVOY_TEST_BOOTSTRAP=1` 时从 env 灌产品配置。
 * 正式运行忽略这些变量，避免与设置页 / OAuth 冲突。
 */
if (process.env.AUREVOY_TEST_BOOTSTRAP === '1') {
  applyTestProductConfig({
    llm: {
      provider: (process.env.AUREVOY_LLM_PROVIDER ?? config.llm.provider).toLowerCase(),
      apiKey: process.env.AUREVOY_LLM_API_KEY ?? config.llm.apiKey,
      baseUrl: process.env.AUREVOY_LLM_BASE_URL ?? config.llm.baseUrl,
      model: process.env.AUREVOY_LLM_MODEL ?? config.llm.model,
      temperature: parseNumber(process.env.AUREVOY_LLM_TEMPERATURE, config.llm.temperature),
      timeoutMs: parseNumber(process.env.AUREVOY_LLM_TIMEOUT_MS, config.llm.timeoutMs),
      maxTokens: parseNumber(process.env.AUREVOY_LLM_MAX_TOKENS, config.llm.maxTokens),
    },
    agent: {
      approvalTimeoutMs: parseNumber(process.env.AUREVOY_APPROVAL_TIMEOUT_MS, config.agent.approvalTimeoutMs),
      thinkingLevel: parseAgentThinkingLevel(process.env.AUREVOY_AGENT_THINKING_LEVEL),
      toolExecution: parseAgentToolExecution(process.env.AUREVOY_AGENT_TOOL_EXECUTION),
      subagentMaxConcurrency: Math.max(
        1,
        Math.floor(parseNumber(process.env.AUREVOY_SUBAGENT_MAX_CONCURRENCY, config.agent.subagentMaxConcurrency)),
      ),
      contextCharBudget: parseNumber(process.env.AUREVOY_CONTEXT_CHAR_BUDGET, config.agent.contextCharBudget),
      recentMessageWindow: parseNumber(process.env.AUREVOY_RECENT_MESSAGE_WINDOW, config.agent.recentMessageWindow),
      compressedMessageCharCap: parseNumber(
        process.env.AUREVOY_COMPRESSED_MESSAGE_CHAR_CAP,
        config.agent.compressedMessageCharCap,
      ),
      maxScoutRounds: parseNumber(process.env.AUREVOY_MAX_SCOUT_ROUNDS, config.agent.maxScoutRounds),
      llmPlanningEnabled: process.env.AUREVOY_LLM_PLANNING_ENABLED !== 'false',
      toolTimeoutMs: parseNumber(process.env.AUREVOY_TOOL_TIMEOUT_MS, config.agent.toolTimeoutMs),
      toolOutputMaxChars: parseNumber(process.env.AUREVOY_TOOL_OUTPUT_MAX_CHARS, config.agent.toolOutputMaxChars),
      contextTokenBudget: parseNumber(
        process.env.AUREVOY_CONTEXT_TOKEN_BUDGET,
        process.env.AUREVOY_CONTEXT_CHAR_BUDGET
          ? Math.round(parseNumber(process.env.AUREVOY_CONTEXT_CHAR_BUDGET, 24000) / 2.5)
          : config.agent.contextTokenBudget,
      ),
      compactThreshold: parseNumber(process.env.AUREVOY_COMPACT_THRESHOLD, config.agent.compactThreshold),
      compactKeepRecentTurns: parseNumber(
        process.env.AUREVOY_COMPACT_KEEP_RECENT_TURNS,
        config.agent.compactKeepRecentTurns,
      ),
    },
    sandbox: {
      commandExecutionEnabled: process.env.AUREVOY_ENABLE_COMMAND_EXECUTION === 'true',
      commandTimeoutMs: parseNumber(process.env.AUREVOY_COMMAND_TIMEOUT_MS, config.sandbox.commandTimeoutMs),
      commandOutputLimitBytes: parseNumber(
        process.env.AUREVOY_COMMAND_OUTPUT_LIMIT_BYTES,
        config.sandbox.commandOutputLimitBytes,
      ),
      commandEnvAllowlist: (process.env.AUREVOY_COMMAND_ENV_ALLOWLIST ?? 'PATH,HOME,TMPDIR')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    },
    embedding: {
      provider: (process.env.AUREVOY_EMBEDDING_PROVIDER ?? config.embedding.provider) as 'openai' | 'off',
      model: process.env.AUREVOY_EMBEDDING_MODEL ?? config.embedding.model,
      baseUrl: process.env.AUREVOY_EMBEDDING_BASE_URL ?? config.embedding.baseUrl,
      apiKey: process.env.AUREVOY_EMBEDDING_API_KEY ?? config.embedding.apiKey,
      timeoutMs: parseNumber(process.env.AUREVOY_EMBEDDING_TIMEOUT_MS, config.embedding.timeoutMs),
    },
    search: {
      provider: (process.env.AUREVOY_SEARCH_PROVIDER ?? config.search.provider) as typeof config.search.provider,
      baseUrl: process.env.AUREVOY_SEARCH_BASE_URL ?? config.search.baseUrl,
      apiKey: process.env.AUREVOY_SEARCH_API_KEY ?? config.search.apiKey,
    },
    network: {
      httpFetchPrivateHostAllowlist: (process.env.AUREVOY_HTTP_FETCH_PRIVATE_HOST_ALLOWLIST ?? '')
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    },
    skills: {
      userDir: process.env.AUREVOY_SKILLS_USER_DIR ?? config.skills.userDir,
      agentsUserDir: process.env.AUREVOY_SKILLS_AGENTS_USER_DIR ?? config.skills.agentsUserDir,
      claudeUserDir: process.env.AUREVOY_SKILLS_CLAUDE_USER_DIR ?? config.skills.claudeUserDir,
      codexUserDir: process.env.AUREVOY_SKILLS_CODEX_USER_DIR ?? config.skills.codexUserDir,
      workspaceSubDir: process.env.AUREVOY_SKILLS_WORKSPACE_SUBDIR ?? config.skills.workspaceSubDir,
      agentsWorkspaceSubDir:
        process.env.AUREVOY_SKILLS_AGENTS_WORKSPACE_SUBDIR ?? config.skills.agentsWorkspaceSubDir,
      claudeWorkspaceSubDir:
        process.env.AUREVOY_SKILLS_CLAUDE_WORKSPACE_SUBDIR ?? config.skills.claudeWorkspaceSubDir,
      codexWorkspaceSubDir:
        process.env.AUREVOY_SKILLS_CODEX_WORKSPACE_SUBDIR ?? config.skills.codexWorkspaceSubDir,
      builtinDir: process.env.AUREVOY_SKILLS_BUILTIN_DIR ?? config.skills.builtinDir,
    },
    mcpServers: parseMcpServers(process.env.AUREVOY_MCP_SERVERS_JSON),
  });
  if (process.env.AUREVOY_BUDGET_RUN_MAX_ITERATIONS) {
    config.budget.run.maxIterations = parseNumber(
      process.env.AUREVOY_BUDGET_RUN_MAX_ITERATIONS,
      config.budget.run.maxIterations,
    );
  }
  if (process.env.AUREVOY_PYTHON_PATH) config.python.userPath = process.env.AUREVOY_PYTHON_PATH;
  if (process.env.AUREVOY_PYTHON_VENV_DIR) config.python.venvDir = process.env.AUREVOY_PYTHON_VENV_DIR;
}

function parseAgentThinkingLevel(value: string | undefined): typeof config.agent.thinkingLevel {
  if (value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') {
    return value;
  }
  return 'off';
}

function parseAgentToolExecution(value: string | undefined): typeof config.agent.toolExecution {
  return value === 'sequential' ? 'sequential' : 'parallel';
}

export function parseMcpServers(raw: string | undefined): McpServerConfig[] {
  if (!raw?.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`MCP servers JSON 不是合法 JSON：${message}`);
  }

  return normalizeMcpServerEntries(parsed).map(([fallbackName, value]) =>
    parseMcpServerConfig(fallbackName, value),
  );
}

function normalizeMcpServerEntries(parsed: unknown): Array<[string | undefined, unknown]> {
  if (Array.isArray(parsed)) return parsed.map((item) => [undefined, item]);
  if (!isRecord(parsed)) throw new Error('MCP servers JSON 必须是对象或数组');
  if (typeof parsed.command === 'string') return [[undefined, parsed]];
  if (isRecord(parsed.mcpServers)) return Object.entries(parsed.mcpServers);
  return Object.entries(parsed);
}

function parseMcpServerConfig(
  fallbackName: string | undefined,
  value: unknown,
): McpServerConfig {
  if (!isRecord(value)) throw new Error(`MCP server 配置必须是对象：${fallbackName ?? '<unnamed>'}`);

  const name = readOptionalString(value.name) ?? fallbackName;
  if (!name?.trim()) throw new Error('MCP server 缺少 name');

  const transport = readOptionalString(value.transport) ?? 'stdio';
  if (transport !== 'stdio') {
    throw new Error(`MCP server "${name}" 暂只支持 stdio transport`);
  }

  const command = readOptionalString(value.command);
  if (!command) throw new Error(`MCP server "${name}" 缺少 command`);

  return {
    name,
    transport,
    command,
    args: readStringArray(value.args, `${name}.args`),
    cwd: readOptionalString(value.cwd),
    env: readStringRecord(value.env, `${name}.env`),
    enabled: value.enabled !== false,
    riskLevel: readRiskLevel(value.riskLevel, `${name}.riskLevel`),
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function readStringArray(value: unknown, label: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`MCP 配置 ${label} 必须是字符串数组`);
  }
  return value;
}

function readStringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value == null) return undefined;
  if (!isRecord(value)) throw new Error(`MCP 配置 ${label} 必须是对象`);
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== 'string')) {
    throw new Error(`MCP 配置 ${label} 的值必须都是字符串`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function readRiskLevel(value: unknown, label: string): ToolRiskLevel | undefined {
  if (value == null) return undefined;
  if (value === 'safe' || value === 'caution' || value === 'dangerous') return value;
  throw new Error(`MCP 配置 ${label} 必须是 safe/caution/dangerous`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveUserSkillsDir(): string {
  try {
    return resolve(homedir(), '.aurevoy', 'skills');
  } catch {
    return './.aurevoy/skills';
  }
}

function resolveAgentsUserSkillsDir(): string {
  try {
    return resolve(homedir(), '.agents', 'skills');
  } catch {
    return './.agents/skills';
  }
}

function resolveClaudeUserSkillsDir(): string {
  try {
    return resolve(homedir(), '.claude', 'skills');
  } catch {
    return './.claude/skills';
  }
}

function resolveCodexUserSkillsDir(): string {
  try {
    return resolve(homedir(), '.codex', 'skills');
  } catch {
    return './.codex/skills';
  }
}

function resolveBuiltinSkillsDir(): string {
  try {
    const thisDir = resolve(fileURLToPath(import.meta.url), '..');
    return resolve(thisDir, '..', 'skills', 'builtin');
  } catch {
    return './apps/agent/skills/builtin';
  }
}
