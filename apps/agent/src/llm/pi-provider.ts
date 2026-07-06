import {
  getModel,
  getModels,
  type Model as PiModel,
} from '@earendil-works/pi-ai/compat';
import { config } from '../config.js';

export function getPiProviderName(): string {
  return isPiLLMConfigured() ? `${config.llm.provider}:${config.llm.model}` : 'unconfigured';
}

export function isPiLLMConfigured(): boolean {
  return !!config.llm.apiKey && isValidPiProviderId(config.llm.provider);
}

export function assertPiLLMConfigured(): void {
  if (!isValidPiProviderId(config.llm.provider)) {
    throw new Error(`未支持的 Provider id: "${config.llm.provider}"。仅允许小写字母、数字和连字符。`);
  }
  if (!config.llm.apiKey) {
    throw new Error(
      '未配置 LLM API Key。请在项目根目录 .env 设置 AUREVOY_LLM_API_KEY ' +
        '（以及 AUREVOY_LLM_BASE_URL / AUREVOY_LLM_MODEL）。参考 .env.example。',
    );
  }
}

export function createPiModel(): PiModel<any> {
  const provider = normalizePiProvider(config.llm.provider);
  const builtin = (getModel as (provider: string, model: string) => PiModel<any> | undefined)(
    provider,
    config.llm.model,
  );
  if (builtin) {
    const withBaseUrl = config.llm.provider === 'openai-compatible'
      ? { ...builtin, baseUrl: config.llm.baseUrl || builtin.baseUrl }
      : builtin;
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
  const api = fallbackApiForProvider(provider);
  const openAICompat = api === 'openai-completions'
    ? openAICompletionsFallbackCompat(provider, config.llm.baseUrl, config.llm.model)
    : undefined;
  return {
    id: config.llm.model,
    name: config.llm.model,
    api,
    provider,
    baseUrl: config.llm.baseUrl,
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
  const provider = normalizePiProvider(config.llm.provider);
  const models = (getModels as (provider?: string) => readonly PiModel<any>[])(provider)
    .map((model) => model.id)
    .filter(Boolean);
  if (models.length > 0) return [...new Set(models)].sort((a, b) => a.localeCompare(b));
  return config.llm.model.trim() ? [config.llm.model.trim()] : [];
}

export function resetPiProviderCache(): void {
  // Pi compat model lookup is stateless for Aurevoy's current env-driven setup.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
