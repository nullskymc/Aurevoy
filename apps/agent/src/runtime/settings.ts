import type {
  AgentThinkingLevel,
  AgentToolExecutionMode,
  AutoModeLevel,
  LlmProviderSlot,
  RuntimeSettings,
  TaskBudget,
  UpdateRuntimeSettingsRequest,
} from '@aurevoy/shared';
import { config, parseMcpServers, parseNumber } from '../config.js';
import { listPiProviderCatalog, resetPiProviderCache } from '../llm/pi-provider.js';
import { resetEmbeddingCache } from '../embedding/provider.js';
import type { PiProviderCatalogEntry } from '@aurevoy/shared';
import {
  clearProviderCredential,
  hasApiKeyCredential,
  hasOauthCredential,
  writeApiKeyCredential,
} from '../llm/credential-store.js';
import {
  deleteLlmProvider,
  ensureLlmSchemaMigrated,
  ensureProviderRow,
  getAvailableModelIds,
  getDefaultModelId,
  getEnabledModelIds,
  getImageInputModelIds,
  getLlmProvider,
  listLlmProviders,
  readLlmCredential,
  readLlmGlobal,
  replaceAvailableModels,
  setDefaultModel,
  setEnabledModels,
  setImageInputModels,
  upsertLlmProvider,
  writeLlmGlobal,
} from '../llm/llm-store.js';
import { settingsStore } from '../store/db.js';
import { resetPythonCache } from './python-runtime.js';

const SETTING_KEYS = {
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

  config.workspaceDir = entries[SETTING_KEYS.workspaceDir] || config.workspaceDir;
  config.sandbox.commandExecutionEnabled =
    entries[SETTING_KEYS.commandExecutionEnabled] === undefined
      ? config.sandbox.commandExecutionEnabled
      : entries[SETTING_KEYS.commandExecutionEnabled] === 'true';
  if (mcpJson !== undefined) config.mcpServers = parseMcpServers(mcpJson);

  // LLM：正式表为真相源（含从旧 app_settings 的一次性迁移）
  ensureLlmSchemaMigrated();
  const global = readLlmGlobal();
  config.llm.temperature = global.temperature;
  config.llm.timeoutMs = global.timeoutMs;
  config.llm.maxTokens = global.maxTokens;
  if (isValidPiProviderId(global.activeProvider)) {
    activateProviderSlot(global.activeProvider);
  }

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

function safeListPiProviderCatalog(): PiProviderCatalogEntry[] {
  try {
    return listPiProviderCatalog();
  } catch {
    return [];
  }
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
      availableModels,
      enabledModels,
      imageInputModels: getImageInputModelIds(activeProvider),
      temperature: config.llm.temperature,
      timeoutMs: config.llm.timeoutMs,
      maxTokens: config.llm.maxTokens,
      apiKeyConfigured: hasApiKeyCredential(activeProvider),
      oauthConfigured: hasOauthCredential(activeProvider),
      providers: listProviderSlots(),
      /** provider 元数据；失败时回空，由前端 fallback。 */
      providerCatalog: safeListPiProviderCatalog(),
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
    ensureLlmSchemaMigrated();
    // 切换 provider 时若前端 draft 误带上一槽 baseUrl，丢弃该字段，避免污染新槽。
    let ignoreIncomingBaseUrl = false;
    const targetForConnection = body.llm.provider !== undefined
      ? normalizeProvider(body.llm.provider)
      : config.llm.provider;

    // 1) 切换激活 provider（只改指针 + 加载目标槽到内存）
    if (body.llm.provider !== undefined) {
      const nextProvider = normalizeProvider(body.llm.provider);
      if (nextProvider !== config.llm.provider) {
        const previousBaseUrl = config.llm.baseUrl.trim();
        activateProviderSlot(nextProvider);
        providerChanged = true;

        if (body.llm.baseUrl !== undefined) {
          const incoming = String(body.llm.baseUrl).trim().replace(/\/+$/, '');
          const prev = previousBaseUrl.replace(/\/+$/, '');
          const slotBase = (getLlmProvider(nextProvider)?.baseUrl ?? '').trim().replace(/\/+$/, '');
          if (
            nextProvider !== 'openai-compatible'
            && incoming.length > 0
            && incoming === prev
            && incoming !== slotBase
          ) {
            ignoreIncomingBaseUrl = true;
          }
        }
      }
    }

    // 连接字段：始终写「当前激活」槽（兼容旧 API）；slot* 字段可写任意槽
    const active = config.llm.provider;

    if (body.llm.baseUrl !== undefined && !ignoreIncomingBaseUrl) {
      const baseUrl = validateBaseUrl(body.llm.baseUrl, active === 'openai-compatible');
      config.llm.baseUrl = baseUrl;
      upsertLlmProvider(active, { baseUrl });
      providerChanged = true;
    }
    if (body.llm.model !== undefined) {
      const model = requireNonEmpty(body.llm.model, 'model');
      setDefaultModel(active, model);
      config.llm.model = model;
      // 切换主模型时并入启用列表
      if (body.llm.enabledModels === undefined && body.llm.slotEnabledModels === undefined) {
        const enabled = getEnabledModelIds(active);
        if (!enabled.includes(model)) {
          setEnabledModels(active, [model, ...enabled]);
        }
      }
      providerChanged = true;
    }
    if (body.llm.availableModels !== undefined) {
      replaceAvailableModels(active, body.llm.availableModels, { source: 'remote' });
      providerChanged = true;
    }
    if (body.llm.enabledModels !== undefined) {
      setEnabledModels(active, body.llm.enabledModels);
      providerChanged = true;
    }
    if (body.llm.temperature !== undefined) {
      config.llm.temperature = clampNumber(body.llm.temperature, 0, 2, 'temperature');
      writeLlmGlobal({ temperature: config.llm.temperature });
      providerChanged = true;
    }
    if (body.llm.timeoutMs !== undefined) {
      config.llm.timeoutMs = clampNumber(body.llm.timeoutMs, 1000, 10 * 60 * 1000, 'timeoutMs');
      writeLlmGlobal({ timeoutMs: config.llm.timeoutMs });
      providerChanged = true;
    }
    if (body.llm.maxTokens !== undefined) {
      config.llm.maxTokens = clampNumber(body.llm.maxTokens, 256, 65536, 'maxTokens');
      writeLlmGlobal({ maxTokens: config.llm.maxTokens });
      // 同时记到当前 provider 槽（可选覆盖）
      upsertLlmProvider(active, { maxTokens: config.llm.maxTokens });
      providerChanged = true;
    }
    if (body.llm.apiKey !== undefined) {
      // 只写当前激活 provider 的凭证表（与其它 provider 完全隔离）
      config.llm.apiKey = body.llm.apiKey;
      void writeApiKeyCredential(active, body.llm.apiKey, {
        force: body.llm.apiKey.trim().length > 0,
      });
      providerChanged = true;
    }

    if (body.llm.removeProvider !== undefined) {
      removeProviderSlot(normalizeProvider(body.llm.removeProvider));
      providerChanged = true;
    }

    if (body.llm.slotEnabledModels !== undefined) {
      const pid = normalizeProvider(body.llm.slotEnabledModels.provider);
      setEnabledModels(pid, body.llm.slotEnabledModels.enabledModels);
      if (pid === config.llm.provider) {
        // 内存无列表缓存，read 时直接查表
      }
      providerChanged = true;
    }

    if (body.llm.slotImageInputModels !== undefined) {
      const pid = normalizeProvider(body.llm.slotImageInputModels.provider);
      setImageInputModels(pid, body.llm.slotImageInputModels.imageInputModels);
      providerChanged = true;
    }

    if (body.llm.slotAvailableModels !== undefined) {
      const pid = normalizeProvider(body.llm.slotAvailableModels.provider);
      replaceAvailableModels(pid, body.llm.slotAvailableModels.availableModels, {
        source: 'custom',
      });
      providerChanged = true;
    }

    if (body.llm.slotModel !== undefined) {
      const pid = normalizeProvider(body.llm.slotModel.provider);
      const model = requireNonEmpty(body.llm.slotModel.model, 'slotModel.model');
      setDefaultModel(pid, model);
      if (pid === config.llm.provider) {
        config.llm.model = model;
      }
      providerChanged = true;
    }

    // 保证激活指针与内存一致
    writeLlmGlobal({
      activeProvider: config.llm.provider,
      temperature: config.llm.temperature,
      timeoutMs: config.llm.timeoutMs,
      maxTokens: config.llm.maxTokens,
    });
    void targetForConnection;
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

// ---- Multi-provider slot helpers (llm_* tables) ----

/**
 * 激活指定 provider：只改内存 config + llm_global.active_provider。
 * 凭证/目录从正式表读取，绝不从其它槽回填。
 */
function activateProviderSlot(provider: string): void {
  if (!isValidPiProviderId(provider)) {
    throw new Error(`无效的 provider: ${provider}`);
  }
  ensureProviderRow(provider);
  const slot = getLlmProvider(provider);
  const global = readLlmGlobal();

  config.llm.provider = provider;
  config.llm.baseUrl = slot?.baseUrl ?? (provider === 'openai-compatible' ? config.llm.baseUrl : '');
  config.llm.model = getDefaultModelId(provider) || slot?.defaultModel || '';
  if (slot?.maxTokens != null) {
    config.llm.maxTokens = slot.maxTokens;
  } else {
    config.llm.maxTokens = global.maxTokens;
  }
  config.llm.temperature = global.temperature;
  config.llm.timeoutMs = global.timeoutMs;

  // 鉴权：只读本 provider 凭证
  const cred = readLlmCredential(provider);
  if (cred?.type === 'api_key') {
    config.llm.apiKey = String((cred as { key?: string }).key ?? '');
  } else {
    // oauth 不进 config.llm.apiKey（避免 sk 路径误用 JWT）
    config.llm.apiKey = '';
  }

  writeLlmGlobal({ activeProvider: provider });
}

/** 删除 provider 行（级联凭证与模型）；必要时切换激活。 */
function removeProviderSlot(provider: string): void {
  if (!isValidPiProviderId(provider)) {
    throw new Error(`无效的 provider: ${provider}`);
  }
  const wasActive = provider === config.llm.provider;
  deleteLlmProvider(provider);
  void clearProviderCredential(provider);

  if (wasActive) {
    const remaining = listLlmProviders()
      .map((p) => p.providerId)
      .sort((a, b) => a.localeCompare(b));
    const next = remaining[0] ?? 'openai';
    activateProviderSlot(next);
  }
}

function listProviderSlots(): LlmProviderSlot[] {
  ensureLlmSchemaMigrated();
  const active = config.llm.provider;
  let providers = listLlmProviders();
  if (isValidPiProviderId(active) && !providers.some((p) => p.providerId === active)) {
    ensureProviderRow(active);
    providers = listLlmProviders();
  }

  return providers
    .map((slot) => {
      const provider = slot.providerId;
      const isActive = provider === active;
      return {
        provider,
        baseUrl: isActive ? config.llm.baseUrl : slot.baseUrl,
        model: isActive ? config.llm.model : (getDefaultModelId(provider) || slot.defaultModel),
        availableModels: getAvailableModelIds(provider),
        enabledModels: getEnabledModelIds(provider),
        imageInputModels: getImageInputModelIds(provider),
        apiKeyConfigured: hasApiKeyCredential(provider),
        oauthConfigured: hasOauthCredential(provider),
      } satisfies LlmProviderSlot;
    })
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

function readActiveAvailableModels(): string[] {
  return getAvailableModelIds(config.llm.provider);
}

function readActiveEnabledModels(): string[] {
  return getEnabledModelIds(config.llm.provider);
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
