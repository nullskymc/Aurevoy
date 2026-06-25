import type { AutoModeLevel, RuntimeSettings, UpdateRuntimeSettingsRequest } from '@aurevoy/shared';
import { config, parseMcpServers, parseNumber } from '../config.js';
import { resetProviderCache } from '../llm/provider.js';
import { resetEmbeddingCache } from '../embedding/provider.js';
import { settingsStore } from '../store/db.js';

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
  embeddingProvider: 'embedding.provider',
  embeddingModel: 'embedding.model',
  embeddingBaseUrl: 'embedding.baseUrl',
  embeddingApiKey: 'embedding.apiKey',
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
    autoModeLevel: readAutoModeLevel(),
    autoModeSafetyEnabled: readAutoModeSafetyEnabled(),
    dbPath: config.dbPath,
    embedding: {
      provider: config.embedding.provider,
      model: config.embedding.model,
      baseUrl: config.embedding.baseUrl,
      apiKeyConfigured: config.embedding.apiKey.trim().length > 0,
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
      config.llm.baseUrl = validateBaseUrl(body.llm.baseUrl);
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
    const valid = (['off', 'plan', 'auto-edit', 'full'] as const).includes(body.autoModeLevel as never);
    if (valid) settingsStore.set(SETTING_KEYS.autoModeLevel, body.autoModeLevel);
  }

  if (body.autoModeSafetyEnabled !== undefined) {
    settingsStore.set(SETTING_KEYS.autoModeSafetyEnabled, String(body.autoModeSafetyEnabled));
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

  if (providerChanged) resetProviderCache();
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

type NormalizedProvider = 'openai' | 'anthropic' | 'openai-response';

function normalizeProvider(provider: string): NormalizedProvider {
  const value = provider.trim().toLowerCase();
  if (value === 'openai' || value === 'openai-compatible') return 'openai';
  if (value === 'anthropic') return 'anthropic';
  if (value === 'openai-response') return 'openai-response';
  throw new Error(
    `不支持的 Provider: "${provider}"。支持: openai / openai-compatible / anthropic / openai-response`,
  );
}

function validateBaseUrl(raw: string): string {
  const value = requireNonEmpty(raw, 'baseUrl').replace(/\/$/, '');
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

function readAutoModeLevel(): AutoModeLevel {
  const stored = settingsStore.get(SETTING_KEYS.autoModeLevel);
  if (stored === 'off' || stored === 'plan' || stored === 'auto-edit' || stored === 'full') return stored;
  return 'off';
}

function readAutoModeSafetyEnabled(): boolean {
  const stored = settingsStore.get(SETTING_KEYS.autoModeSafetyEnabled);
  return stored === undefined ? true : stored !== 'false';
}
