import type {
  AgentThinkingLevel,
  AgentToolExecutionMode,
  AutoModeLevel,
  LlmProviderSlot,
  RuntimeSettings,
  TaskBudget,
  UpdateRuntimeSettingsRequest,
} from '@aurevoy/shared';
import { filterChatModelIds } from '@aurevoy/shared';
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
  budgetRunMaxIterations: 'budget.run.maxIterations',
  budgetRunMaxToolCalls: 'budget.run.maxToolCalls',
  budgetRunMaxWallTimeMs: 'budget.run.maxWallTimeMs',
  budgetRunMaxOutputBytes: 'budget.run.maxOutputBytes',
  budgetLifetimeMaxIterations: 'budget.lifetime.maxIterations',
  budgetLifetimeMaxToolCalls: 'budget.lifetime.maxToolCalls',
  budgetLifetimeMaxWallTimeMs: 'budget.lifetime.maxWallTimeMs',
  budgetLifetimeMaxOutputBytes: 'budget.lifetime.maxOutputBytes',
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

/**
 * 持久化中的 provider 槽位（无密钥）。
 * 注意：视觉模型是全局配置（llm.visionModel），不按槽位切换；
 * visionModel 字段仅兼容旧数据读取，写入时固定为空。
 */
interface StoredProviderSlot {
  baseUrl: string;
  model: string;
  /** @deprecated 视觉模型已改为全局，槽位不再维护 */
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
  applyBudgetSetting(entries[SETTING_KEYS.budgetRunMaxIterations], 'run', 'maxIterations');
  applyBudgetSetting(entries[SETTING_KEYS.budgetRunMaxToolCalls], 'run', 'maxToolCalls');
  applyBudgetSetting(entries[SETTING_KEYS.budgetRunMaxWallTimeMs], 'run', 'maxWallTimeMs');
  applyBudgetSetting(entries[SETTING_KEYS.budgetRunMaxOutputBytes], 'run', 'maxOutputBytes');
  applyBudgetSetting(entries[SETTING_KEYS.budgetLifetimeMaxIterations], 'lifetime', 'maxIterations');
  applyBudgetSetting(entries[SETTING_KEYS.budgetLifetimeMaxToolCalls], 'lifetime', 'maxToolCalls');
  applyBudgetSetting(entries[SETTING_KEYS.budgetLifetimeMaxWallTimeMs], 'lifetime', 'maxWallTimeMs');
  applyBudgetSetting(entries[SETTING_KEYS.budgetLifetimeMaxOutputBytes], 'lifetime', 'maxOutputBytes');
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
    budget: {
      run: { ...config.budget.run },
      lifetime: { ...config.budget.lifetime },
    },
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
      // 切换主模型时把该模型并入启用列表（可之后再取消勾选），避免「切换了但菜单/设置看起来没保存」
      if (body.llm.enabledModels === undefined && body.llm.slotEnabledModels === undefined) {
        const enabled = readActiveEnabledModels();
        if (config.llm.model && !enabled.includes(config.llm.model)) {
          settingsStore.set(
            SETTING_KEYS.llmEnabledModels,
            stringifyModelList([config.llm.model, ...enabled]),
          );
        }
      }
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
      // 过滤 embedding / tts 等非对话模型，避免混入主模型目录
      const chatOnly = filterChatModelIds(body.llm.availableModels);
      settingsStore.set(SETTING_KEYS.llmAvailableModels, stringifyModelList(chatOnly));
    }
    if (body.llm.enabledModels !== undefined) {
      // 允许空列表：某 Provider 可以不勾选任何模型进主界面菜单
      patchProviderEnabledModels(config.llm.provider, body.llm.enabledModels);
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

    if (body.llm.removeProvider !== undefined) {
      removeProviderSlot(normalizeProvider(body.llm.removeProvider));
      providerChanged = true;
    }

    if (body.llm.slotEnabledModels !== undefined) {
      patchProviderEnabledModels(
        normalizeProvider(body.llm.slotEnabledModels.provider),
        body.llm.slotEnabledModels.enabledModels,
      );
      providerChanged = true;
    }

    if (body.llm.slotModel !== undefined) {
      patchProviderDefaultModel(
        normalizeProvider(body.llm.slotModel.provider),
        requireNonEmpty(body.llm.slotModel.model, 'slotModel.model'),
      );
      providerChanged = true;
    }

    // 回写激活槽 map，保证与扁平字段一致。
    // removeProvider 自行维护 map；其余 llm 变更（含 model / enabled）都 snapshot 一次。
    // patchProviderEnabledModels 已写入最新 enabled，snapshot 会从扁平字段读回同一份。
    if (body.llm.removeProvider === undefined) {
      if (body.llm.slotEnabledModels !== undefined) {
        // 非激活槽只改了 map；若改的是激活槽，flat 已更新，仍需 snapshot 对齐 map 其它字段
        if (normalizeProvider(body.llm.slotEnabledModels.provider) === config.llm.provider) {
          snapshotActiveProviderSlot();
        }
      } else if (body.llm.slotModel !== undefined) {
        if (normalizeProvider(body.llm.slotModel.provider) === config.llm.provider) {
          snapshotActiveProviderSlot();
        }
      } else {
        snapshotActiveProviderSlot();
      }
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

  if (body.budget?.run) {
    writeBudgetScope('run', body.budget.run);
  }
  if (body.budget?.lifetime) {
    writeBudgetScope('lifetime', body.budget.lifetime);
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
        // 遗留字段：读取兼容，新写入一律清空
        visionModel: '',
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

/** 把当前内存中的激活 provider 配置写入 map + 扁平字段。视觉模型为全局，不写入槽位。 */
function snapshotActiveProviderSlot(): void {
  const provider = config.llm.provider;
  if (!isValidPiProviderId(provider)) return;
  const map = readProviderMap();
  const availableModels = readActiveAvailableModels();
  const enabledModels = readActiveEnabledModels();
  map[provider] = {
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
    visionModel: '',
    availableModels,
    enabledModels,
  };
  writeProviderMap(map);
  // 同步扁平字段（激活视图）
  settingsStore.set(SETTING_KEYS.llmProvider, provider);
  settingsStore.set(SETTING_KEYS.llmBaseUrl, config.llm.baseUrl);
  settingsStore.set(SETTING_KEYS.llmModel, config.llm.model);
  // 全局视觉模型单独持久化，与槽位切换无关
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
 * 视觉模型是全局配置，切换槽位时不改动。
 */
function activateProviderSlot(provider: string): void {
  const map = readProviderMap();
  const slot = map[provider];
  config.llm.provider = provider;
  settingsStore.set(SETTING_KEYS.llmProvider, provider);

  if (slot) {
    config.llm.baseUrl = slot.baseUrl;
    config.llm.model = slot.model || config.llm.model;
    settingsStore.set(SETTING_KEYS.llmBaseUrl, config.llm.baseUrl);
    settingsStore.set(SETTING_KEYS.llmModel, config.llm.model);
    settingsStore.set(SETTING_KEYS.llmAvailableModels, stringifyModelList(slot.availableModels));
    settingsStore.set(SETTING_KEYS.llmEnabledModels, stringifyModelList(filterChatModelIds(slot.enabledModels)));
  } else {
    // 新 provider：保留 model 名可能不适用，清空列表，baseUrl 仅 openai-compatible 需要
    if (provider !== 'openai-compatible') {
      config.llm.baseUrl = '';
      settingsStore.set(SETTING_KEYS.llmBaseUrl, '');
    }
    settingsStore.set(SETTING_KEYS.llmAvailableModels, stringifyModelList([]));
    settingsStore.set(SETTING_KEYS.llmEnabledModels, stringifyModelList([]));
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

/**
 * 更新指定槽位的 enabledModels。
 * - 始终写入 multi-provider map
 * - 若是激活槽，同时写扁平 llm.enabledModels
 * - 允许空数组（表示该 Provider 不在主界面暴露任何模型）
 */
function patchProviderEnabledModels(provider: string, enabledModels: string[]): void {
  if (!isValidPiProviderId(provider)) {
    throw new Error(`无效的 provider: ${provider}`);
  }
  // 注意：不要对「用户显式提交的列表」再强制塞回默认模型
  const nextEnabled = filterChatModelIds(enabledModels);
  const map = readProviderMap();
  const slot = map[provider] ?? emptyProviderSlot();
  // 激活槽的 available/model 以内存为准，避免 map 过期
  if (provider === config.llm.provider) {
    map[provider] = {
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      visionModel: '',
      availableModels: readActiveAvailableModels(),
      enabledModels: nextEnabled,
    };
    settingsStore.set(SETTING_KEYS.llmEnabledModels, stringifyModelList(nextEnabled));
  } else {
    map[provider] = { ...slot, enabledModels: nextEnabled };
  }
  writeProviderMap(map);
}

/**
 * 更新指定槽位的默认 model，不切换激活 provider。
 * 仅改 model 字段，不强制并入 enabled（启用勾选与「默认」解耦）。
 */
function patchProviderDefaultModel(provider: string, model: string): void {
  if (!isValidPiProviderId(provider)) {
    throw new Error(`无效的 provider: ${provider}`);
  }
  const nextModel = requireNonEmpty(model, 'model');

  if (provider === config.llm.provider) {
    config.llm.model = nextModel;
    settingsStore.set(SETTING_KEYS.llmModel, nextModel);
    return;
  }

  const map = readProviderMap();
  const slot = map[provider] ?? emptyProviderSlot();
  map[provider] = {
    ...slot,
    model: nextModel,
  };
  writeProviderMap(map);
}

function emptyProviderSlot(): StoredProviderSlot {
  return {
    baseUrl: '',
    model: '',
    visionModel: '',
    availableModels: [],
    enabledModels: [],
  };
}

/** 删除 provider 槽位与分槽密钥；必要时切换激活 provider。 */
function removeProviderSlot(provider: string): void {
  if (!isValidPiProviderId(provider)) {
    throw new Error(`无效的 provider: ${provider}`);
  }

  const map = readProviderMap();
  // 若删除的是当前激活槽，先快照其它字段到 map（随后删除）
  if (provider === config.llm.provider) {
    snapshotActiveProviderSlot();
  }

  delete map[provider];
  writeProviderMap(map);
  writeProviderApiKey(provider, '');

  if (provider === config.llm.provider) {
    const remaining = Object.keys(map).sort((a, b) => a.localeCompare(b));
    const next = remaining[0] ?? 'openai';
    // 确保回落目标在 map 中有条目；全新 openai 由 activate 创建空槽
    activateProviderSlot(next);
    snapshotActiveProviderSlot();
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
      visionModel: '',
      availableModels: readActiveAvailableModels(),
      enabledModels: readActiveEnabledModels(),
    };
  }

  // 视觉模型为全局：槽位 API 中 visionModel 统一回显全局值，便于旧前端读取
  const globalVision = config.llm.visionModel;

  return Object.entries(map)
    .map(([provider, slot]) => {
      const isActive = provider === active;
      return {
        provider,
        baseUrl: isActive ? config.llm.baseUrl : slot.baseUrl,
        model: isActive ? config.llm.model : slot.model,
        visionModel: globalVision,
        availableModels: isActive
          ? readActiveAvailableModels()
          : filterChatModelIds(slot.availableModels),
        enabledModels: isActive
          ? readActiveEnabledModels()
          : filterChatModelIds(slot.enabledModels),
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
      visionModel: '',
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
  // 读出时再滤一遍，清理历史脏数据（embedding 等）
  return filterChatModelIds(readModelList(SETTING_KEYS.llmAvailableModels));
}

function readActiveEnabledModels(): string[] {
  return filterChatModelIds(readEnabledModelsLegacy());
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

function isValidPiProviderId(provider: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(provider.trim().toLowerCase());
}

function normalizeProvider(provider: string): string {
  const value = provider.trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9-]*$/.test(value)) return value;
  throw new Error(`不支持的 Provider id: "${provider}"。仅允许小写字母、数字和连字符。`);
}

function applyBudgetSetting(
  raw: string | undefined,
  scope: 'run' | 'lifetime',
  key: keyof Required<TaskBudget>,
): void {
  if (raw === undefined || raw.trim() === '') return;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return;
  config.budget[scope][key] = Math.floor(value);
}

function writeBudgetScope(scope: 'run' | 'lifetime', partial: Partial<TaskBudget>): void {
  const bounds: Record<keyof Required<TaskBudget>, { min: number; max: number }> = {
    maxIterations: { min: 1, max: 10_000 },
    maxToolCalls: { min: 1, max: 50_000 },
    maxWallTimeMs: { min: 1_000, max: 24 * 60 * 60 * 1000 },
    maxOutputBytes: { min: 1024, max: 100 * 1024 * 1024 },
  };
  const keyMap: Record<keyof Required<TaskBudget>, string> = scope === 'run'
    ? {
        maxIterations: SETTING_KEYS.budgetRunMaxIterations,
        maxToolCalls: SETTING_KEYS.budgetRunMaxToolCalls,
        maxWallTimeMs: SETTING_KEYS.budgetRunMaxWallTimeMs,
        maxOutputBytes: SETTING_KEYS.budgetRunMaxOutputBytes,
      }
    : {
        maxIterations: SETTING_KEYS.budgetLifetimeMaxIterations,
        maxToolCalls: SETTING_KEYS.budgetLifetimeMaxToolCalls,
        maxWallTimeMs: SETTING_KEYS.budgetLifetimeMaxWallTimeMs,
        maxOutputBytes: SETTING_KEYS.budgetLifetimeMaxOutputBytes,
      };

  for (const key of Object.keys(bounds) as Array<keyof Required<TaskBudget>>) {
    const raw = partial[key];
    if (raw === undefined) continue;
    const value = clampNumber(raw, bounds[key].min, bounds[key].max, `budget.${scope}.${key}`);
    config.budget[scope][key] = Math.floor(value);
    settingsStore.set(keyMap[key], String(config.budget[scope][key]));
  }
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
