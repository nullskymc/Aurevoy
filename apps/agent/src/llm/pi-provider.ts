import {
  getModel,
  type Model as PiModel,
  openAICompletionsApi,
} from '@earendil-works/pi-ai/compat';
import {
  createModels,
  createProvider,
  type Models as PiModels,
  type Provider as PiProvider,
} from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { filterChatModelIds, type PiProviderCatalogEntry } from '@aurevoy/shared';
import { config } from '../config.js';
import { hasStoredCredential } from './credential-store.js';

// ---- Dynamic model discovery via Pi's createProvider + refreshModels ----

let _piModelsCache: PiModels | null = null;

function getPiModels(): PiModels {
  if (_piModelsCache) return _piModelsCache;
  const models = createModels();
  for (const provider of builtinProviders()) {
    models.setProvider(provider);
  }
  models.setProvider(createOpenAICompatProvider());
  _piModelsCache = models;
  return _piModelsCache;
}

function createOpenAICompatProvider() {
  return createProvider({
    id: 'openai-compatible',
    name: 'OpenAI Compatible',
    baseUrl: config.llm.baseUrl,
    auth: { apiKey: { name: 'none', resolve: async () => undefined } },
    models: [],
    refreshModels: async () => {
      const base = config.llm.baseUrl.replace(/\/+$/, '');
      const resp = await fetch(`${base}/models`, {
        headers: config.llm.apiKey ? { Authorization: `Bearer ${config.llm.apiKey}` } : {},
      });
      if (!resp.ok) {
        throw new Error(`Failed to fetch models from ${base}/models: ${resp.status} ${resp.statusText}`);
      }
      const json = (await resp.json()) as { data?: { id: string }[] };
      return (json.data ?? []).map((item) => ({
        id: item.id,
        name: item.id,
        api: 'openai-completions' as const,
        provider: 'openai-compatible',
        baseUrl: config.llm.baseUrl,
        reasoning: false,
        input: ['text', 'image'] as const,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: config.agent.contextTokenBudget,
        maxTokens: config.llm.maxTokens,
      }));
    },
    api: openAICompletionsApi(),
  });
}

// ---- Public API ----

/**
 * 暴露 Pi 对各家 provider 的元数据（协议 apis、鉴权形态、默认 baseUrl）。
 * 前端只做展示/接入，不在 Aurevoy 侧复刻各家协议差异。
 */
export function listPiProviderCatalog(): PiProviderCatalogEntry[] {
  const entries = builtinProviders().map((provider) => toCatalogEntry(provider));
  // 自定义 OpenAI 兼容端：Aurevoy 合成，不在 Pi 内置列表
  entries.push({
    id: 'openai-compatible',
    name: 'OpenAI Compatible / Custom',
    defaultBaseUrl: '',
    apis: ['openai-completions'],
    supportsApiKey: true,
    apiKeyLabel: 'API key',
    supportsOauth: false,
    modelCount: 0,
    requiresBaseUrl: true,
    custom: true,
  });
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function toCatalogEntry(provider: PiProvider): PiProviderCatalogEntry {
  const models = provider.getModels();
  const apis = [...new Set(models.map((model) => model.api).filter(Boolean))].sort();
  return {
    id: provider.id,
    name: provider.name || provider.id,
    defaultBaseUrl: (provider.baseUrl ?? '').replace(/\/+$/, ''),
    apis: apis.length > 0 ? apis : [fallbackApiForProvider(provider.id)],
    supportsApiKey: Boolean(provider.auth.apiKey),
    apiKeyLabel: provider.auth.apiKey?.name,
    supportsOauth: Boolean(provider.auth.oauth),
    oauthLabel: provider.auth.oauth?.name,
    modelCount: models.length,
    requiresBaseUrl: false,
    custom: false,
  };
}

export function getPiProviderName(): string {
  return isPiLLMConfigured() ? `${config.llm.provider}:${config.llm.model}` : 'unconfigured';
}

export function isPiLLMConfigured(): boolean {
  if (!isValidPiProviderId(config.llm.provider)) return false;
  if (config.llm.apiKey?.trim()) return true;
  // OAuth / 分槽凭证（CredentialStore）
  return hasStoredCredential(config.llm.provider);
}

export function assertPiLLMConfigured(): void {
  if (!isValidPiProviderId(config.llm.provider)) {
    throw new Error(`未支持的 Provider id: "${config.llm.provider}"。仅允许小写字母、数字和连字符。`);
  }
  if (!isPiLLMConfigured()) {
    throw new Error(
      '未配置 LLM 凭证。请在设置中为当前 Provider 配置 API Key，或使用订阅登录。',
    );
  }
}

/**
 * 运行时模型端点：设置/环境里的 baseUrl 优先于 Pi 内置 catalog。
 * 多 Provider 槽位会把用户网关写进 config.llm.baseUrl；若仍用 catalog 默认
 * api.openai.com 等地址，会导致请求打到错误端点，usage 也拿不到。
 */
export function resolveModelBaseUrl(modelBaseUrl?: string): string {
  const configured = config.llm.baseUrl?.trim().replace(/\/+$/, '');
  if (configured) return configured;
  return (modelBaseUrl ?? '').replace(/\/+$/, '');
}

/**
 * 第三方网关通常只有 chat/completions：把官方 OpenAI Responses 降级为 completions。
 *
 * 注意：
 * - `openai-codex-responses` 必须走 chatgpt.com Codex 协议，**绝不能**降级，
 *   否则会打到 /backend-api/chat/completions 并被 Cloudflare 403。
 * - chatgpt.com 是 Codex 官方端点，不是「第三方网关」。
 */
export function resolveModelApi(api: string | undefined, baseUrl: string, provider: string): string {
  const resolved = api || fallbackApiForProvider(provider);
  // Codex 订阅协议：始终保留
  if (resolved === 'openai-codex-responses' || provider === 'openai-codex') {
    return 'openai-codex-responses';
  }
  // 仅对「真·OpenAI Responses」在非官方主机上降级
  if (resolved === 'openai-responses' && !isOfficialOpenAIHost(baseUrl) && !isCodexHost(baseUrl)) {
    return 'openai-completions';
  }
  return resolved;
}

export function createPiModel(modelOverride?: string): PiModel<any> {
  const provider = normalizePiProvider(config.llm.provider);
  const modelId = modelOverride?.trim() || config.llm.model;
  const builtin = (getModel as (provider: string, model: string) => PiModel<any> | undefined)(
    provider,
    modelId,
  );
  if (builtin) {
    const baseUrl = resolveModelBaseUrl(builtin.baseUrl);
    const withBaseUrl = {
      ...builtin,
      baseUrl,
      api: resolveModelApi(builtin.api, baseUrl, provider) as typeof builtin.api,
    };
    // 确保 DeepSeek / Qwen builtin 模型在 compat 缺失时仍有 reasoning_content 重放字段
    const needCompat = (
      withBaseUrl.provider === 'deepseek' ||
      withBaseUrl.provider === 'qwen' ||
      provider === 'deepseek' ||
      provider === 'qwen'
    );
    if (needCompat && !(isRecord(withBaseUrl.compat) && withBaseUrl.compat.requiresReasoningContentOnAssistantMessages === true)) {
      return {
        ...withBaseUrl,
        compat: {
          ...(isRecord(withBaseUrl.compat) ? withBaseUrl.compat : {}),
          requiresReasoningContentOnAssistantMessages: true,
        },
      };
    }
    return withBaseUrl;
  }
  const baseUrl = resolveModelBaseUrl();
  const api = resolveModelApi(fallbackApiForProvider(provider), baseUrl, provider);
  const openAICompat = api === 'openai-completions'
    ? openAICompletionsFallbackCompat(provider, baseUrl, modelId)
    : undefined;
  return {
    id: modelId,
    name: modelId,
    api,
    provider,
    baseUrl,
    reasoning: openAICompat?.reasoning ?? false,
    ...(openAICompat?.thinkingLevelMap ? { thinkingLevelMap: openAICompat.thinkingLevelMap } : {}),
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.agent.contextTokenBudget,
    maxTokens: config.llm.maxTokens,
    ...(openAICompat?.compat ? { compat: openAICompat.compat } : {}),
  };
}

export async function listPiProviderModels(): Promise<string[]> {
  const normalized = normalizePiProvider(config.llm.provider);
  const models = getPiModels();

  if (normalized === 'openai-compatible' && config.llm.baseUrl) {
    try {
      await models.refresh('openai-compatible');
    } catch {
      // refresh failed — fall through to static catalog / fallback
    }
  }

  const ids = filterChatModelIds(models.getModels(normalized).map((m) => m.id).filter(Boolean));
  if (ids.length > 0) return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  // 回退：当前主模型即使像 embedding 也保留，避免空列表卡死配置
  const fallback = config.llm.model.trim();
  return fallback ? [fallback] : [];
}

export function resetPiProviderCache(): void {
  _piModelsCache = null;
}

function isValidPiProviderId(provider: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(provider.trim().toLowerCase());
}

function normalizePiProvider(provider: string): string {
  if (provider === 'anthropic') return 'anthropic';
  if (provider === 'openai-response' || provider === 'openai') return 'openai';
  if (provider === 'openai-compatible') return inferOpenAICompatibleProvider(config.llm.baseUrl);
  return provider;
}

function fallbackApiForProvider(provider: string): string {
  switch (provider) {
    case 'anthropic':
      return 'anthropic-messages';
    case 'google':
      return 'google-generative-ai';
    case 'google-vertex':
      return 'google-vertex';
    case 'mistral':
      return 'mistral-conversations';
    case 'amazon-bedrock':
      return 'bedrock-converse-stream';
    case 'azure-openai-responses':
      return 'azure-openai-responses';
    case 'openai-codex':
      return 'openai-codex-responses';
    case 'openai-response':
      return 'openai-responses';
    default:
      return 'openai-completions';
  }
}

function inferOpenAICompatibleProvider(baseUrl: string): string {
  const host = safeHost(baseUrl);
  if (host.includes('deepseek')) return 'deepseek';
  if (host.includes('openrouter')) return 'openrouter';
  if (host.includes('api.openai.com')) return 'openai';
  return 'openai-compatible';
}

function openAICompletionsFallbackCompat(provider: string, baseUrl: string, model: string): {
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
} {
  const host = safeHost(baseUrl);
  const modelId = model.toLowerCase();
  const isDeepSeekStyle =
    provider === 'deepseek' ||
    host.includes('deepseek') ||
    host.includes('xiaomimimo') ||
    modelId.includes('deepseek') ||
    modelId.includes('mimo') ||
    modelId.includes('r1');
  const isQwenStyle =
    host.includes('dashscope') ||
    host.includes('aliyuncs') ||
    modelId.includes('qwen');

  if (!isDeepSeekStyle && !isQwenStyle) {
    return { reasoning: false };
  }

  return {
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: null },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: isQwenStyle ? 'qwen-chat-template' : 'deepseek',
    },
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isOfficialOpenAIHost(baseUrl: string): boolean {
  const host = safeHost(baseUrl);
  return host === 'api.openai.com' || host.endsWith('.openai.azure.com');
}

/** ChatGPT / Codex 订阅官方主机（backend-api） */
function isCodexHost(baseUrl: string): boolean {
  const host = safeHost(baseUrl);
  return host === 'chatgpt.com' || host.endsWith('.chatgpt.com');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
