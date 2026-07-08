import type {
  AgentThinkingLevel,
  AgentToolExecutionMode,
  AutoModeLevel,
  RuntimeSettings,
  UpdateRuntimeSettingsRequest,
} from '@aurevoy/shared';
import { config, parseMcpServers, parseNumber } from '../config.js';
import { resetPiProviderCache } from '../llm/pi-provider.js';
import { resetEmbeddingCache } from '../embedding/provider.js';
import { settingsStore } from '../store/db.js';
import { resetPythonCache } from './python-runtime.js';

const SETTING_KEYS = {
  llmProvider: 'llm.provider',
  llmApiKey: 'llm.apiKey',
  llmBaseUrl: 'llm.baseUrl',
  llmModel: 'llm.model',
  llmVisionModel: 'llm.visionModel',
  llmAvailableModels: 'llm.availableModels',
  llmEnabledModels: 'llm.enabledModels',
  /** 旧版本字段：曾同时表示”已获取列表”和”主界面可选列表”，现在只作为迁移来源。 */
  llmModelOptions: 'llm.modelOptions',
  llmTemperature: 'llm.temperature',
  llmTimeoutMs: 'llm.timeoutMs',
  llmMaxTokens: 'llm.maxTokens',
  workspaceDir: 'workspaceDir',
  commandExecutionEnabled: 'sandbox.commandExecutionEnabled',
  mcpServersJson: 'mcpServersJson',
  cleanupPolicyDays: 'cleanupPolicyDays',
  autoModeLevel: 'autoMode.level',
  autoModeSafetyEnabled: 'autoMode.safetyEnabled',
  agentThinkingLevel: 'agent.thinkingLevel',
  agentToolExecution: 'agent.toolExecution',
  embeddingProvider: 'embedding.provider',
  embeddingModel: 'embedding.model',
  embeddingBaseUrl: 'embedding.baseUrl',
  embeddingApiKey: 'embedding.apiKey',
  pythonPath: 'python.path',
  searchProvider: 'search.provider',
  searchBaseUrl: 'search.baseUrl',
  searchApiKey: 'search.apiKey',
} as const;

const DEFAULT_CLEANUP_POLICY_DAYS = 30;

export interface SettingsUpdateResult {
  settings: RuntimeSettings;
  mcpChanged: boolean;
}

/** 启动期把 SQLite 中保存的用户设置覆盖到运行时配置。 */
export function loadPersistedSettings(): void {
  const entries = settingsStore.entries();
  const mcpJson = entries[SETTING_KEYS.mcpServersJson];

  // M8: Embedding settings
  if (entries[SETTING_KEYS.embeddingProvider] === 'openai') {
    config.embedding.provider = 'openai';
  }
  if (entries[SETTING_KEYS.embeddingProvider] === 'off') {
    config.embedding.provider = 'off';
  }
  if (entries[SETTING_KEYS.embeddingModel]) {
    config.embedding.model = entries[SETTING_KEYS.embeddingModel];
  }
  if (entries[SETTING_KEYS.embeddingBaseUrl]) {
    config.embedding.baseUrl = entries[SETTING_KEYS.embeddingBaseUrl];
  }
  const embKey = entries[SETTING_KEYS.embeddingApiKey];
  if (embKey) {
    config.embedding.apiKey = embKey;
  }

  // Python 运行时路径（用户手动指定）
  const pythonPathSetting = entries[SETTING_KEYS.pythonPath];
  if (pythonPathSetting) {
    config.python.userPath = pythonPathSetting;
  }

  // Web 搜索配置
  const searchProvider = entries[SETTING_KEYS.searchProvider];
  if (searchProvider === 'duckduckgo_lite' || searchProvider === 'tavily' || searchProvider === 'searxng' || searchProvider === 'custom') {
    config.search.provider = searchProvider;
  }
  if (entries[SETTING_KEYS.searchBaseUrl]) {
    config.search.baseUrl = entries[SETTING_KEYS.searchBaseUrl];
  }
  const searchKey = entries[SETTING_KEYS.searchApiKey];
  if (searchKey) {
    config.search.apiKey = searchKey;
  }

  const envKey = process.env.AUREVOY_LLM_API_KEY?.trim();
  if (envKey) {
    config.llm.apiKey = envKey;
  } else {
    const stored = entries[SETTING_KEYS.llmApiKey];
    if (stored) {
      config.llm.apiKey = stored;
    }
  }

  config.llm.provider = normalizeProvider(entries[SETTING_KEYS.llmProvider] || config.llm.provider);
  config.llm.baseUrl = entries[SETTING_KEYS.llmBaseUrl] || config.llm.baseUrl;
  config.llm.model = entries[SETTING_KEYS.llmModel] || config.llm.model;
  config.llm.visionModel = entries[SETTING_KEYS.llmVisionModel] ?? config.llm.visionModel;
  config.llm.temperature = parseNumber(entries[SETTING_KEYS.llmTemperature], config.llm.temperature);
  config.llm.timeoutMs = parseNumber(entries[SETTING_KEYS.llmTimeoutMs], config.llm.timeoutMs);
  config.llm.maxTokens = parseNumber(entries[SETTING_KEYS.llmMaxTokens], config.llm.maxTokens);
  config.workspaceDir = entries[SETTING_KEYS.workspaceDir] || config.workspaceDir;
  config.sandbox.commandExecutionEnabled =
    entries[SETTING_KEYS.commandExecutionEnabled] === undefined
      ? config.sandbox.commandExecutionEnabled
      : entries[SETTING_KEYS.commandExecutionEnabled] === 'true';
  if (mcpJson !== undefined) config.mcpServers = parseMcpServers(mcpJson);

  const autoModeStored = entries[SETTING_KEYS.autoModeLevel];
  if (autoModeStored === 'auto' || autoModeStored === 'plan') {
    config.autoMode.level = autoModeStored;
  } else if (autoModeStored === 'off' || autoModeStored === 'auto-edit' || autoModeStored === 'full') {
    config.autoMode.level = 'auto';
    settingsStore.set(SETTING_KEYS.autoModeLevel, 'auto');
  } else if (autoModeStored !== undefined) {
    config.autoMode.level = 'auto';
    settingsStore.set(SETTING_KEYS.autoModeLevel, 'auto');
  }

  if (!settingsStore.get('autoMode.migratedV2')) {
    config.autoMode.level = 'auto';
    settingsStore.set(SETTING_KEYS.autoModeLevel, 'auto');
    settingsStore.set('autoMode.migratedV2', 'true');
  }
  const thinkingLevel = normalizeThinkingLevel(entries[SETTING_KEYS.agentThinkingLevel]);
  if (thinkingLevel) config.agent.thinkingLevel = thinkingLevel;
  const toolExecution = normalizeToolExecution(entries[SETTING_KEYS.agentToolExecution]);
  if (toolExecution) config.agent.toolExecution = toolExecution;
}

export function readRuntimeSettings(): RuntimeSettings {
  return {
    llm: {
      provider: config.llm.provider as RuntimeSettings['llm']['provider'],
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      visionModel: config.llm.visionModel,
      availableModels: readModelList(SETTING_KEYS.llmAvailableModels),
      enabledModels: readEnabledModels(),
      temperature: config.llm.temperature,
      timeoutMs: config.llm.timeoutMs,
      maxTokens: config.llm.maxTokens,
      apiKeyConfigured: config.llm.apiKey.trim().length > 0,
    },
    workspaceDir: config.workspaceDir,
    commandExecutionEnabled: config.sandbox.commandExecutionEnabled,
    mcpServersJson: settingsStore.get(SETTING_KEYS.mcpServersJson) ?? stringifyMcpServers(),
    cleanupPolicyDays: readCleanupPolicyDays(),
    autoModeLevel: config.autoMode.level as AutoModeLevel,
    autoModeSafetyEnabled: readAutoModeSafetyEnabled(),
    agentThinkingLevel: config.agent.thinkingLevel,
    agentToolExecution: config.agent.toolExecution,
    dbPath: config.dbPath,
    embedding: {
      provider: config.embedding.provider,
      model: config.embedding.model,
      baseUrl: config.embedding.baseUrl,
      apiKeyConfigured: config.embedding.apiKey.trim().length > 0,
    },
    pythonPath: config.python.userPath,
    search: {
      provider: config.search.provider,
      baseUrl: config.search.baseUrl,
      apiKeyConfigured: config.search.apiKey.trim().length > 0,
    },
  };
}

export function updateRuntimeSettings(body: UpdateRuntimeSettingsRequest): SettingsUpdateResult {
  let providerChanged = false;
  let mcpChanged = false;

  if (body.llm) {
    if (body.llm.provider !== undefined) {
      config.llm.provider = normalizeProvider(body.llm.provider);
      settingsStore.set(SETTING_KEYS.llmProvider, config.llm.provider);
      providerChanged = true;
    }
    if (body.llm.baseUrl !== undefined) {
      config.llm.baseUrl = validateBaseUrl(body.llm.baseUrl, config.llm.provider === 'openai-compatible');
      settingsStore.set(SETTING_KEYS.llmBaseUrl, config.llm.baseUrl);
      providerChanged = true;
    }
    if (body.llm.model !== undefined) {
      config.llm.model = requireNonEmpty(body.llm.model, 'model');
      settingsStore.set(SETTING_KEYS.llmModel, config.llm.model);
      providerChanged = true;
    }
    if (body.llm.visionModel !== undefined) {
      config.llm.visionModel = body.llm.visionModel.trim();
      if (config.llm.visionModel) {
        settingsStore.set(SETTING_KEYS.llmVisionModel, config.llm.visionModel);
      } else {
        settingsStore.delete(SETTING_KEYS.llmVisionModel);
      }
    }
    if (body.llm.availableModels !== undefined) {
      settingsStore.set(SETTING_KEYS.llmAvailableModels, stringifyModelList(body.llm.availableModels));
    }
    if (body.llm.enabledModels !== undefined) {
      settingsStore.set(SETTING_KEYS.llmEnabledModels, stringifyModelList(ensureCurrentModelEnabled(body.llm.enabledModels)));
    }
    if (body.llm.temperature !== undefined) {
      config.llm.temperature = clampNumber(body.llm.temperature, 0, 2, 'temperature');
      settingsStore.set(SETTING_KEYS.llmTemperature, String(config.llm.temperature));
      providerChanged = true;
    }
    if (body.llm.timeoutMs !== undefined) {
      config.llm.timeoutMs = clampNumber(body.llm.timeoutMs, 1000, 10 * 60 * 1000, 'timeoutMs');
      settingsStore.set(SETTING_KEYS.llmTimeoutMs, String(config.llm.timeoutMs));
      providerChanged = true;
    }
    if (body.llm.maxTokens !== undefined) {
      config.llm.maxTokens = clampNumber(body.llm.maxTokens, 256, 65536, 'maxTokens');
      settingsStore.set(SETTING_KEYS.llmMaxTokens, String(config.llm.maxTokens));
      providerChanged = true;
    }
    if (body.llm.apiKey !== undefined) {
      config.llm.apiKey = body.llm.apiKey;
      if (body.llm.apiKey.trim().length > 0) {
        settingsStore.set(SETTING_KEYS.llmApiKey, body.llm.apiKey, true);
      } else {
        settingsStore.delete(SETTING_KEYS.llmApiKey);
      }
      providerChanged = true;
    }
  }

  if (body.workspaceDir !== undefined) {
    config.workspaceDir = requireNonEmpty(body.workspaceDir, 'workspaceDir');
    settingsStore.set(SETTING_KEYS.workspaceDir, config.workspaceDir);
  }

  if (body.commandExecutionEnabled !== undefined) {
    config.sandbox.commandExecutionEnabled = body.commandExecutionEnabled;
    settingsStore.set(SETTING_KEYS.commandExecutionEnabled, String(body.commandExecutionEnabled));
  }

  if (body.autoModeLevel !== undefined) {
    const valid = (['auto', 'plan'] as const).includes(body.autoModeLevel as never);
    if (valid) {
      settingsStore.set(SETTING_KEYS.autoModeLevel, body.autoModeLevel);
      config.autoMode.level = body.autoModeLevel;
    }
  }

  if (body.autoModeSafetyEnabled !== undefined) {
    settingsStore.set(SETTING_KEYS.autoModeSafetyEnabled, String(body.autoModeSafetyEnabled));
  }

  if (body.agentThinkingLevel !== undefined) {
    const value = normalizeThinkingLevel(body.agentThinkingLevel);
    if (!value) throw new Error('agentThinkingLevel 非法');
    config.agent.thinkingLevel = value;
    settingsStore.set(SETTING_KEYS.agentThinkingLevel, value);
  }

  if (body.agentToolExecution !== undefined) {
    const value = normalizeToolExecution(body.agentToolExecution);
    if (!value) throw new Error('agentToolExecution 非法');
    config.agent.toolExecution = value;
    settingsStore.set(SETTING_KEYS.agentToolExecution, value);
  }

  if (body.mcpServersJson !== undefined) {
    const parsed = parseMcpServers(body.mcpServersJson);
    config.mcpServers = parsed;
    settingsStore.set(SETTING_KEYS.mcpServersJson, body.mcpServersJson.trim());
    mcpChanged = true;
  }

  if (body.cleanupPolicyDays !== undefined) {
    const days = clampNumber(body.cleanupPolicyDays, 1, 3650, 'cleanupPolicyDays');
    settingsStore.set(SETTING_KEYS.cleanupPolicyDays, String(days));
  }

  // M8: Embedding settings（OpenAI 兼容 API）
  if (body.embedding) {
    if (body.embedding.provider === 'openai' || body.embedding.provider === 'off') {
      config.embedding.provider = body.embedding.provider;
      settingsStore.set(SETTING_KEYS.embeddingProvider, config.embedding.provider);
    }
    if (body.embedding.model !== undefined) {
      config.embedding.model = body.embedding.model;
      settingsStore.set(SETTING_KEYS.embeddingModel, config.embedding.model);
    }
    if (body.embedding.baseUrl !== undefined) {
      config.embedding.baseUrl = body.embedding.baseUrl;
      settingsStore.set(SETTING_KEYS.embeddingBaseUrl, config.embedding.baseUrl);
    }
    if (body.embedding.apiKey !== undefined) {
      config.embedding.apiKey = body.embedding.apiKey;
      if (body.embedding.apiKey.trim().length > 0) {
        settingsStore.set(SETTING_KEYS.embeddingApiKey, body.embedding.apiKey, true);
      } else {
        settingsStore.delete(SETTING_KEYS.embeddingApiKey);
      }
    }
    resetEmbeddingCache();
  }

  if (body.pythonPath !== undefined) {
    config.python.userPath = body.pythonPath.trim();
    if (config.python.userPath) {
      settingsStore.set(SETTING_KEYS.pythonPath, config.python.userPath);
    } else {
      settingsStore.delete(SETTING_KEYS.pythonPath);
    }
    // 用户修改了 Python 路径，清除系统检测缓存以便下次重新判定
    resetPythonCache();
  }

  // Web 搜索配置
  if (body.search) {
    if (body.search.provider === 'duckduckgo_lite' || body.search.provider === 'tavily' || body.search.provider === 'searxng' || body.search.provider === 'custom') {
      config.search.provider = body.search.provider;
      settingsStore.set(SETTING_KEYS.searchProvider, config.search.provider);
    }
    if (body.search.baseUrl !== undefined) {
      config.search.baseUrl = body.search.baseUrl;
      settingsStore.set(SETTING_KEYS.searchBaseUrl, config.search.baseUrl);
    }
    if (body.search.apiKey !== undefined) {
      config.search.apiKey = body.search.apiKey;
      if (body.search.apiKey.trim().length > 0) {
        settingsStore.set(SETTING_KEYS.searchApiKey, body.search.apiKey, true);
      } else {
        settingsStore.delete(SETTING_KEYS.searchApiKey);
      }
    }
  }

  if (providerChanged) resetPiProviderCache();
  return { settings: readRuntimeSettings(), mcpChanged };
}

export function readCleanupPolicyDays(): number {
  return parseNumber(settingsStore.get(SETTING_KEYS.cleanupPolicyDays), DEFAULT_CLEANUP_POLICY_DAYS);
}

function readEnabledModels(): string[] {
  const explicit = settingsStore.get(SETTING_KEYS.llmEnabledModels);
  if (explicit !== undefined) return parseModelList(explicit);
  return readModelList(SETTING_KEYS.llmModelOptions);
}

function readModelList(key: string): string[] {
  const raw = settingsStore.get(key);
  if (!raw) return [];
  return parseModelList(raw);
}

function parseModelList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

function stringifyModelList(models: string[]): string {
  const unique = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
  return JSON.stringify(unique);
}

function ensureCurrentModelEnabled(models: string[]): string[] {
  const currentModel = config.llm.model.trim();
  if (!currentModel) return models;
  return models.includes(currentModel) ? models : [currentModel, ...models];
}

function normalizeProvider(provider: string): string {
  const value = provider.trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9-]*$/.test(value)) return value;
  throw new Error(`不支持的 Provider id: "${provider}"。仅允许小写字母、数字和连字符。`);
}

function normalizeThinkingLevel(value: unknown): AgentThinkingLevel | null {
  return value === 'off' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
    ? value
    : null;
}

function normalizeToolExecution(value: unknown): AgentToolExecutionMode | null {
  return value === 'sequential' || value === 'parallel' ? value : null;
}

function validateBaseUrl(raw: string, required: boolean): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    if (required) throw new Error('openai-compatible provider 必须填写 baseUrl');
    return '';
  }

  const value = trimmed.replace(/\/$/, '');
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid protocol');
    return value;
  } catch {
    throw new Error('baseUrl 必须是 http/https URL');
  }
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} 不能为空`);
  return trimmed;
}

function clampNumber(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} 必须是有效数字`);
  return Math.min(max, Math.max(min, value));
}

function stringifyMcpServers(): string {
  if (config.mcpServers.length === 0) return '';
  return JSON.stringify({ mcpServers: Object.fromEntries(config.mcpServers.map((s) => [s.name, s])) }, null, 2);
}

function readAutoModeSafetyEnabled(): boolean {
  const stored = settingsStore.get(SETTING_KEYS.autoModeSafetyEnabled);
  return stored === undefined ? true : stored !== 'false';
}
