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

/** 运行时配置，可通过环境变量覆盖（开发期通过 apps/agent/.env 注入） */
export const config = {
  /** 日志配置 */
  logging: {
    /** trace | debug | info | warn | error | fatal */
    level: (process.env.AUREVOY_LOG_LEVEL ?? 'info') as
      | 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    /** 文件日志路径（安装版默认 ~/.aurevoy/logs/），空字符串则禁用文件输出 */
    file: process.env.AUREVOY_LOG_FILE ?? resolve(homedir(), '.aurevoy', 'logs', 'aurevoy.log'),
    /** 开发模式美化控制台输出（生产期设 'false'） */
    pretty: process.env.AUREVOY_LOG_PRETTY !== 'false',
  },

  host: process.env.AUREVOY_HOST ?? AGENT_DEFAULT_HOST,
  port: Number(process.env.AUREVOY_PORT ?? AGENT_DEFAULT_PORT),
  /** SQLite 数据文件路径。安装版默认 ~/.aurevoy/aurevoy.sqlite，开发期通过 AUREVOY_DB_PATH 覆盖。 */
  dbPath: process.env.AUREVOY_DB_PATH ?? resolve(homedir(), '.aurevoy', 'aurevoy.sqlite'),
  /**
   * 工具工作区根目录。文件类工具的所有路径都被限制在此目录内（防目录穿越）。
   * 安装版默认 ~/.aurevoy/workspace，开发期通过 AUREVOY_WORKSPACE_DIR 覆盖。
   */
  workspaceDir: process.env.AUREVOY_WORKSPACE_DIR ?? resolve(homedir(), '.aurevoy', 'workspace'),
  /** 允许的前端来源（开发期 Vite + 生产期 Tauri） */
  corsOrigins: (process.env.AUREVOY_CORS_ORIGINS ?? '*')
    .split(',')
    .map((s) => s.trim()),

  /** LLM Provider 配置。未配置 apiKey 时引擎会在执行任务时明确报错（不再回退占位实现）。 */
  llm: {
    /**
     * 提供商标识。支持:
     * - 'openai' / 'openai-compatible' — OpenAI 兼容协议（/chat/completions），支持 OpenAI/DeepSeek/Ollama 等
     * - 'anthropic' — Anthropic Messages API（/v1/messages），原生 Claude
     * - 'openai-response' — OpenAI Responses API（/v1/responses），新一代 API
     */
    provider: (process.env.AUREVOY_LLM_PROVIDER ?? 'openai').toLowerCase(),
    apiKey: process.env.AUREVOY_LLM_API_KEY ?? '',
    /**
     * Provider 端点基础地址：
     * - 'openai' / 'openai-compatible': 不含 /chat/completions，如 https://api.openai.com/v1
     * - 'anthropic': https://api.anthropic.com
     * - 'openai-response': https://api.openai.com/v1
     */
    baseUrl: process.env.AUREVOY_LLM_BASE_URL ?? 'https://api.openai.com/v1',
    model: process.env.AUREVOY_LLM_MODEL ?? 'gpt-4o-mini',
    /** 视觉子模型：消息带图片附件时自动切换此模型（空则用主模型，可能不支持视觉） */
    visionModel: process.env.AUREVOY_LLM_VISION_MODEL ?? '',
    temperature: parseNumber(process.env.AUREVOY_LLM_TEMPERATURE, 0.7),
    /** 单轮 LLM 调用超时（毫秒）；防止半开连接导致任务永久挂起 */
    timeoutMs: parseNumber(process.env.AUREVOY_LLM_TIMEOUT_MS, 120000),
    /** 单轮最大输出 token 数（Anthropic 必填，OpenAI 可选） */
    maxTokens: parseNumber(process.env.AUREVOY_LLM_MAX_TOKENS, 8192),
  },

  agent: {
    /** 等待用户审批的超时（毫秒）；测试可通过环境变量缩短。 */
    approvalTimeoutMs: parseNumber(process.env.AUREVOY_APPROVAL_TIMEOUT_MS, 5 * 60 * 1000),
    /**
     * 会话级短期记忆的上下文字符预算（M4.2）。
     * 单轮喂给 LLM 的历史消息总字符超过此值时触发确定性压缩，避免裸拼接撑爆上下文。
     */
    contextCharBudget: parseNumber(process.env.AUREVOY_CONTEXT_CHAR_BUDGET, 24000),
    /** 压缩时保留逐字的最近消息条数（边界：近窗口逐字，旧内容压缩）。 */
    recentMessageWindow: parseNumber(process.env.AUREVOY_RECENT_MESSAGE_WINDOW, 8),
    /** 被压缩消息的单条内容字符上限（保留可读摘要，引用而非全文）。 */
    compressedMessageCharCap: parseNumber(process.env.AUREVOY_COMPRESSED_MESSAGE_CHAR_CAP, 600),
    /** P1: 侦查阶段最多 LLM 轮次（防止无限侦查）。 */
    maxScoutRounds: parseNumber(process.env.AUREVOY_MAX_SCOUT_ROUNDS, 3),
    /** P1: 是否启用 LLM 驱动规划（关闭时回退纯正则规划，用于调试）。 */
    llmPlanningEnabled: process.env.AUREVOY_LLM_PLANNING_ENABLED !== 'false',
    /** P2: 单个工具调用超时（毫秒），防止单个 hung 工具拖死整个任务。 */
    toolTimeoutMs: parseNumber(process.env.AUREVOY_TOOL_TIMEOUT_MS, 30000),
    /** P3: 单次工具输出字符上限，超出部分截断并标记 _truncated。 */
    toolOutputMaxChars: parseNumber(
      process.env.AUREVOY_TOOL_OUTPUT_MAX_CHARS,
      50000,
    ),
    /** P4: 上下文 token 预算（优先于 contextCharBudget）。未设置时用字符预算/2.5 估算。 */
    contextTokenBudget: parseNumber(
      process.env.AUREVOY_CONTEXT_TOKEN_BUDGET,
      process.env.AUREVOY_CONTEXT_CHAR_BUDGET
        ? Math.round(
            parseNumber(process.env.AUREVOY_CONTEXT_CHAR_BUDGET, 24000) / 2.5,
          )
        : 128000,
    ),
    /** P4: 超过 token 预算的多少比例时自动触发语义压缩（0-1）。默认 0.85。 */
    compactThreshold: parseNumber(
      process.env.AUREVOY_COMPACT_THRESHOLD,
      0.85,
    ),
    /** P4: 压缩时保留的最近消息轮次数（不被压缩的尾部窗口）。 */
    compactKeepRecentTurns: parseNumber(
      process.env.AUREVOY_COMPACT_KEEP_RECENT_TURNS,
      5,
    ),
  },

  /** Skill 模块配置（Agent Skills 标准格式）。
   *  Skill 是目录含 SKILL.md（+可选 scripts/references/assets），
   *  存放在用户/工作区/预装目录下。支持 .aurevoy/skills/ 和 .agents/skills/ 两个路径。 */
  skills: {
    /** 用户级 skill 目录 — .aurevoy/skills（Aurevoy 原生路径）。 */
    userDir: process.env.AUREVOY_SKILLS_USER_DIR ?? resolveUserSkillsDir(),
    /** 用户级 skill 目录 — .agents/skills（跨客户端标准路径）。 */
    agentsUserDir: process.env.AUREVOY_SKILLS_AGENTS_USER_DIR ?? resolveAgentsUserSkillsDir(),
    /** 用户级 skill 目录 — .claude/skills（Claude Code/Desktop 路径）。 */
    claudeUserDir: process.env.AUREVOY_SKILLS_CLAUDE_USER_DIR ?? resolveClaudeUserSkillsDir(),
    /** 用户级 skill 目录 — .codex/skills（Codex CLI 路径）。 */
    codexUserDir: process.env.AUREVOY_SKILLS_CODEX_USER_DIR ?? resolveCodexUserSkillsDir(),
    /** 工作区级 skill 子目录名 — .aurevoy/skills（Aurevoy 原生路径）。 */
    workspaceSubDir: process.env.AUREVOY_SKILLS_WORKSPACE_SUBDIR ?? '.aurevoy/skills',
    /** 工作区级 skill 子目录名 — .agents/skills（跨客户端标准路径）。 */
    agentsWorkspaceSubDir: process.env.AUREVOY_SKILLS_AGENTS_WORKSPACE_SUBDIR ?? '.agents/skills',
    /** 工作区级 skill 子目录名 — .claude/skills（Claude Code 项目级路径）。 */
    claudeWorkspaceSubDir: process.env.AUREVOY_SKILLS_CLAUDE_WORKSPACE_SUBDIR ?? '.claude/skills',
    /** 工作区级 skill 子目录名 — .codex/skills（Codex CLI 项目级路径）。 */
    codexWorkspaceSubDir: process.env.AUREVOY_SKILLS_CODEX_WORKSPACE_SUBDIR ?? '.codex/skills',
    /** 预装 skill 目录（随 Agent 分发，优先级最低，可被用户/工作区覆盖）。 */
    builtinDir: process.env.AUREVOY_SKILLS_BUILTIN_DIR ?? resolveBuiltinSkillsDir(),
  },

  sandbox: {
    /** 高风险命令/代码执行默认关闭；设置界面显式启用前不得开放给模型。 */
    commandExecutionEnabled: process.env.AUREVOY_ENABLE_COMMAND_EXECUTION === 'true',
    commandTimeoutMs: parseNumber(process.env.AUREVOY_COMMAND_TIMEOUT_MS, 30000),
    commandOutputLimitBytes: parseNumber(process.env.AUREVOY_COMMAND_OUTPUT_LIMIT_BYTES, 64 * 1024),
    commandEnvAllowlist: (process.env.AUREVOY_COMMAND_ENV_ALLOWLIST ?? 'PATH,HOME,TMPDIR')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  },

  autoMode: {
    level: 'off' as string,
  },

  network: {
    /**
     * http_fetch 默认拒绝本机/私网地址；这里仅给受控开发或企业内网场景提供显式放行。
     * 匹配按 URL hostname 精确匹配，不支持通配，避免误把任意 DNS 解析结果当成可信目标。
     */
    httpFetchPrivateHostAllowlist: (process.env.AUREVOY_HTTP_FETCH_PRIVATE_HOST_ALLOWLIST ?? '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  },

  /** Python 运行时配置（python-build-standalone，解压即用，不依赖系统 Python）。 */
  python: {
    /** Python 运行时安装目录。默认 ~/.aurevoy/python，可通过环境变量覆盖。 */
    home: process.env.AUREVOY_PYTHON_HOME ?? resolve(homedir(), '.aurevoy', 'python'),
    /** 是否在启动时自动检查并按需下载 Python（默认 true，首次启动需网络 ~40MB）。 */
    autoSetup: process.env.AUREVOY_PYTHON_AUTO_SETUP !== 'false',
    /** 目标 Python 主版本（用于下载与校验）。 */
    version: process.env.AUREVOY_PYTHON_VERSION ?? '3.13',
  },

  /**
   * MCP server 配置。支持 JSON 数组、单个对象、对象映射，以及 Claude Desktop 风格：
   * {"mcpServers":{"name":{"command":"node","args":["server.js"]}}}
   */
  mcpServers: parseMcpServers(process.env.AUREVOY_MCP_SERVERS_JSON),

  /** M8: Embedding Provider 配置。通过 OpenAI 兼容 API 接入（支持 Ollama/LiteLLM/OpenAI 等）。
   *  默认复用 LLM 配置（baseUrl/apiKey），用户可单独覆盖。 */
  embedding: {
    provider: (process.env.AUREVOY_EMBEDDING_PROVIDER ?? 'off') as 'openai' | 'off',
    model: process.env.AUREVOY_EMBEDDING_MODEL ?? 'nomic-embed-text',
    baseUrl: process.env.AUREVOY_EMBEDDING_BASE_URL ?? '',
    apiKey: process.env.AUREVOY_EMBEDDING_API_KEY ?? '',
    timeoutMs: parseNumber(process.env.AUREVOY_EMBEDDING_TIMEOUT_MS, 10000),
  },
};

/** 解析数字环境变量，非法或缺失时回退默认值（避免 NaN 污染配置）。 */
export function parseNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw != null && raw !== '' && !Number.isNaN(n) ? n : fallback;
}

export function parseMcpServers(raw: string | undefined): McpServerConfig[] {
  if (!raw?.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`AUREVOY_MCP_SERVERS_JSON 不是合法 JSON：${message}`);
  }

  return normalizeMcpServerEntries(parsed).map(([fallbackName, value]) =>
    parseMcpServerConfig(fallbackName, value),
  );
}

function normalizeMcpServerEntries(parsed: unknown): Array<[string | undefined, unknown]> {
  if (Array.isArray(parsed)) return parsed.map((item) => [undefined, item]);
  if (!isRecord(parsed)) throw new Error('AUREVOY_MCP_SERVERS_JSON 必须是对象或数组');
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

/** 解析用户级 skill 目录默认路径（~/.aurevoy/skills）。 */
function resolveUserSkillsDir(): string {
  try {
    return resolve(homedir(), '.aurevoy', 'skills');
  } catch {
    return './.aurevoy/skills';
  }
}

/** 解析用户级 .agents/skills 目录（跨客户端标准路径）。 */
function resolveAgentsUserSkillsDir(): string {
  try {
    return resolve(homedir(), '.agents', 'skills');
  } catch {
    return './.agents/skills';
  }
}

/** 解析用户级 .claude/skills 目录（Claude Code/Desktop 路径）。 */
function resolveClaudeUserSkillsDir(): string {
  try {
    return resolve(homedir(), '.claude', 'skills');
  } catch {
    return './.claude/skills';
  }
}

/** 解析用户级 .codex/skills 目录（Codex CLI 路径）。 */
function resolveCodexUserSkillsDir(): string {
  try {
    return resolve(homedir(), '.codex', 'skills');
  } catch {
    return './.codex/skills';
  }
}

/** 解析预装 skill 目录（随 Agent 分发）。 */
function resolveBuiltinSkillsDir(): string {
  // import.meta 在 ESM 中可用；编译后路径指向 dist/，源码在 skills/builtin/
  try {
    const thisDir = resolve(fileURLToPath(import.meta.url), '..');
    return resolve(thisDir, '..', 'skills', 'builtin');
  } catch {
    return './apps/agent/skills/builtin';
  }
}
