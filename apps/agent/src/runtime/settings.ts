import type {
  AgentThinkingLevel,
  AgentToolExecutionMode,
  AutoModeLevel,
  LlmProviderSlot,
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
  /** 遗留全局 API Key；迁移后按 provider 分槽 `llm.apiKey.<id>` 存储，此项仅作回退。 */
  llmApiKey: 'llm.apiKey',
  llmBaseUrl: 'llm.baseUrl',
  llmModel: 'llm.model',
  llmVisionModel: 'llm.visionModel',
  llmAvailableModels: 'llm.availableModels',
  llmEnabledModels: 'llm.enabledModels',
  /** 旧版本字段：曾同时表示”已获取列表”和”主界面可选列表”，现在只作为迁移来源。 */
  llmModelOptions: 'llm.modelOptions',
  /** 多 provider 槽位 map：providerId → StoredProviderSlot（不含密钥） */
  llmProviders: 'llm.providers',
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

/** 持久化中的 provider 槽位（无密钥）。 */
interface StoredProviderSlot {
  baseUrl: string;
  model: string;
  visionModel: string;
  availableModels: string[];
  enabledModels: string[];
}

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

  // 解析 API Key：环境变量 > 分槽 key > 遗留全局 key
  const envKey = process.env.AUREVOY_LLM_API_KEY?.trim();
  if (envKey) {
    config.llm.apiKey = envKey;
  } else {
    config.llm.apiKey = readProviderApiKey(config.llm.provider) || entries[SETTING_KEYS.llmApiKey] || '';
  }

  // 迁移：把当前扁平配置写入多 provider map，并把遗留 key 归到当前 provider 槽
  migrateLegacyProviderSlots();

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
  const activeProvider = config.llm.provider;
  const availableModels = readActiveAvailableModels();
  const enabledModels = readActiveEnabledModels();
  return {
    llm: {
      provider: activeProvider as RuntimeSettings['llm']['provider'],
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      visionModel: config.llm.visionModel,
      availableModels,
      enabledModels,
      temperature: config.llm.temperature,
      timeoutMs: config.llm.timeoutMs,
      maxTokens: config.llm.maxTokens,
      apiKeyConfigured: config.llm.apiKey.trim().length > 0,
      providers: listProviderSlots(),
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
    // 1) 若请求切换 provider：先快照当前槽位，再激活目标槽位（恢复其 key/baseUrl/model 等）
    if (body.llm.provider !== undefined) {
      const nextProvider = normalizeProvider(body.llm.provider);
      if (nextProvider !== config.llm.provider) {
        snapshotActiveProviderSlot();
        activateProviderSlot(nextProvider);
        providerChanged = true;
      } else {
        config.llm.provider = nextProvider;
        settingsStore.set(SETTING_KEYS.llmProvider, config.llm.provider);
      }
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
      writeProviderApiKey(config.llm.provider, body.llm.apiKey);
      // 同步遗留全局 key，兼容旧读取路径
      if (body.llm.apiKey.trim().length > 0) {
        settingsStore.set(SETTING_KEYS.llmApiKey, body.llm.apiKey, true);
      } else {
        settingsStore.delete(SETTING_KEYS.llmApiKey);
      }
      providerChanged = true;
    }

    // 任何 llm 写入都回写当前激活槽位，保证 multi-provider map 与扁平字段一致
    snapshotActiveProviderSlot();
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

// ---- Multi-provider slot helpers ----

function providerApiKeyKey(provider: string): string {
  return `llm.apiKey.${provider}`;
}

function readProviderApiKey(provider: string): string {
  return settingsStore.get(providerApiKeyKey(provider)) ?? '';
}

function writeProviderApiKey(provider: string, apiKey: string): void {
  const key = providerApiKeyKey(provider);
  if (apiKey.trim().length > 0) {
    settingsStore.set(key, apiKey, true);
  } else {
    settingsStore.delete(key);
  }
}

function readProviderMap(): Record<string, StoredProviderSlot> {
  const raw = settingsStore.get(SETTING_KEYS.llmProviders);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, StoredProviderSlot> = {};
    for (const [provider, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isValidPiProviderId(provider)) continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const slot = value as Partial<StoredProviderSlot>;
      result[provider] = {
        baseUrl: typeof slot.baseUrl === 'string' ? slot.baseUrl : '',
        model: typeof slot.model === 'string' ? slot.model : '',
        visionModel: typeof slot.visionModel === 'string' ? slot.visionModel : '',
        availableModels: Array.isArray(slot.availableModels)
          ? slot.availableModels.filter((m): m is string => typeof m === 'string')
          : [],
        enabledModels: Array.isArray(slot.enabledModels)
          ? slot.enabledModels.filter((m): m is string => typeof m === 'string')
          : [],
      };
    }
    return result;
  } catch {
    return {};
  }
}

function writeProviderMap(map: Record<string, StoredProviderSlot>): void {
  settingsStore.set(SETTING_KEYS.llmProviders, JSON.stringify(map));
}

/** 把当前内存中的激活 provider 配置写入 map + 扁平字段。 */
function snapshotActiveProviderSlot(): void {
  const provider = config.llm.provider;
  if (!isValidPiProviderId(provider)) return;
  const map = readProviderMap();
  const availableModels = readActiveAvailableModels();
  const enabledModels = ensureCurrentModelEnabled(readActiveEnabledModels());
  map[provider] = {
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
    visionModel: config.llm.visionModel,
    availableModels,
    enabledModels,
  };
  writeProviderMap(map);
  // 同步扁平字段（激活视图）
  settingsStore.set(SETTING_KEYS.llmProvider, provider);
  settingsStore.set(SETTING_KEYS.llmBaseUrl, config.llm.baseUrl);
  settingsStore.set(SETTING_KEYS.llmModel, config.llm.model);
  if (config.llm.visionModel) {
    settingsStore.set(SETTING_KEYS.llmVisionModel, config.llm.visionModel);
  } else {
    settingsStore.delete(SETTING_KEYS.llmVisionModel);
  }
  settingsStore.set(SETTING_KEYS.llmAvailableModels, stringifyModelList(availableModels));
  settingsStore.set(SETTING_KEYS.llmEnabledModels, stringifyModelList(enabledModels));
}

/**
 * 激活指定 provider 槽位：加载其 baseUrl/model/lists/key 到 config 与扁平设置。
 * 目标槽位不存在时仍切换 provider id，字段保持合理默认。
 */
function activateProviderSlot(provider: string): void {
  const map = readProviderMap();
  const slot = map[provider];
  config.llm.provider = provider;
  settingsStore.set(SETTING_KEYS.llmProvider, provider);

  if (slot) {
    config.llm.baseUrl = slot.baseUrl;
    config.llm.model = slot.model || config.llm.model;
    config.llm.visionModel = slot.visionModel;
    settingsStore.set(SETTING_KEYS.llmBaseUrl, config.llm.baseUrl);
    settingsStore.set(SETTING_KEYS.llmModel, config.llm.model);
    if (config.llm.visionModel) {
      settingsStore.set(SETTING_KEYS.llmVisionModel, config.llm.visionModel);
    } else {
      settingsStore.delete(SETTING_KEYS.llmVisionModel);
    }
    settingsStore.set(SETTING_KEYS.llmAvailableModels, stringifyModelList(slot.availableModels));
    settingsStore.set(
      SETTING_KEYS.llmEnabledModels,
      stringifyModelList(ensureCurrentModelEnabled(slot.enabledModels)),
    );
  } else {
    // 新 provider：保留 model 名可能不适用，清空列表，baseUrl 仅 openai-compatible 需要
    if (provider !== 'openai-compatible') {
      config.llm.baseUrl = '';
      settingsStore.set(SETTING_KEYS.llmBaseUrl, '');
    }
    settingsStore.set(SETTING_KEYS.llmAvailableModels, stringifyModelList([]));
    settingsStore.set(SETTING_KEYS.llmEnabledModels, stringifyModelList(ensureCurrentModelEnabled([])));
  }

  // 切换密钥：分槽 key > 遗留全局 key（仅当目标就是迁移前的 provider）
  const slottedKey = readProviderApiKey(provider);
  if (slottedKey) {
    config.llm.apiKey = slottedKey;
  } else {
    // 环境变量始终优先
    const envKey = process.env.AUREVOY_LLM_API_KEY?.trim();
    if (envKey) {
      config.llm.apiKey = envKey;
    } else {
      // 无分槽 key 时清空，避免误用其他 provider 的 key
      config.llm.apiKey = '';
    }
  }
}

function listProviderSlots(): LlmProviderSlot[] {
  const map = readProviderMap();
  // 确保当前激活 provider 一定出现在列表中
  const active = config.llm.provider;
  if (isValidPiProviderId(active) && !map[active]) {
    map[active] = {
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      visionModel: config.llm.visionModel,
      availableModels: readActiveAvailableModels(),
      enabledModels: readActiveEnabledModels(),
    };
  }

  return Object.entries(map)
    .map(([provider, slot]) => {
      const isActive = provider === active;
      return {
        provider,
        baseUrl: isActive ? config.llm.baseUrl : slot.baseUrl,
        model: isActive ? config.llm.model : slot.model,
        visionModel: isActive ? config.llm.visionModel : slot.visionModel,
        availableModels: isActive ? readActiveAvailableModels() : slot.availableModels,
        enabledModels: isActive ? readActiveEnabledModels() : slot.enabledModels,
        apiKeyConfigured: isActive
          ? config.llm.apiKey.trim().length > 0
          : readProviderApiKey(provider).trim().length > 0
            || (process.env.AUREVOY_LLM_API_KEY?.trim().length ?? 0) > 0,
      } satisfies LlmProviderSlot;
    })
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

/** 首次启动或升级：把扁平配置灌进 multi-provider map。 */
function migrateLegacyProviderSlots(): void {
  const map = readProviderMap();
  const provider = config.llm.provider;
  if (!isValidPiProviderId(provider)) return;

  if (!map[provider]) {
    map[provider] = {
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      visionModel: config.llm.visionModel,
      availableModels: readModelList(SETTING_KEYS.llmAvailableModels),
      enabledModels: readEnabledModelsLegacy(),
    };
    writeProviderMap(map);
  }

  // 遗留全局 key → 分槽（仅当该槽尚无 key）
  const legacyKey = settingsStore.get(SETTING_KEYS.llmApiKey);
  if (legacyKey && !readProviderApiKey(provider)) {
    writeProviderApiKey(provider, legacyKey);
  }
}

function readActiveAvailableModels(): string[] {
  return readModelList(SETTING_KEYS.llmAvailableModels);
}

function readActiveEnabledModels(): string[] {
  return readEnabledModelsLegacy();
}

function readEnabledModelsLegacy(): string[] {
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

function isValidPiProviderId(provider: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(provider.trim().toLowerCase());
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
