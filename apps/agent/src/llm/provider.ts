/**
 * LLM Provider 工厂 —— 按当前配置创建 Provider 实例。
 *
 * 所有 Provider 实现位于同级目录（openai-compatible.ts / anthropic.ts / openai-response.ts），
 * 通过 getProvider() 工厂方法按 config.llm.provider 路由。
 * Agent 循环及各调用方只依赖本模块导出的函数与 types.ts 中的接口。
 */

import { config } from '../config.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIResponseProvider } from './openai-response.js';
import type { LLMProvider } from './types.js';

export type { AccumulatedToolCall } from './types.js';
export type { LLMProvider, LLMStreamChunk, LLMStreamOptions, LLMFinishReason } from './types.js';

/** 当前支持的 Provider 名称 */
const SUPPORTED_PROVIDERS = ['openai', 'openai-compatible', 'anthropic', 'openai-response'] as const;

/**
 * 校验 LLM 配置；缺失或不支持时抛出清晰错误。
 */
function assertConfigured(): void {
  const { provider, apiKey } = config.llm;
  if (!SUPPORTED_PROVIDERS.includes(provider as (typeof SUPPORTED_PROVIDERS)[number])) {
    throw new Error(
      `未支持的 LLM Provider: "${provider}"。` +
        '支持: openai / openai-compatible / anthropic / openai-response。' +
        '请在项目根目录 .env 设置 AUREVOY_LLM_PROVIDER。',
    );
  }
  if (!apiKey) {
    throw new Error(
      '未配置 LLM API Key。请在项目根目录 .env 设置 AUREVOY_LLM_API_KEY ' +
        '（以及 AUREVOY_LLM_BASE_URL / AUREVOY_LLM_MODEL）。参考 .env.example。',
    );
  }
}

/** 是否已正确配置 LLM（不抛错，供 health 等只读场景使用）。 */
export function isLLMConfigured(): boolean {
  try {
    assertConfigured();
    return true;
  } catch {
    return false;
  }
}

/**
 * 返回用于展示的 Provider 名（不抛错）。
 * 格式: `<provider>:<model>`，例: `openai:gpt-4o-mini` / `anthropic:claude-sonnet-4-20250514`
 * 未配置时返回 'unconfigured'。
 */
export function getProviderName(): string {
  return isLLMConfigured() ? `${config.llm.provider}:${config.llm.model}` : 'unconfigured';
}

let cachedProvider: LLMProvider | null = null;

/**
 * 按配置返回 LLM Provider（进程内缓存）。
 * 未配置时抛出错误——由调用方（Agent 循环）捕获并通过 error 事件上报。
 *
 * 在 config.llm.provider 变更后调用 resetProviderCache() 清空缓存。
 */
export function getProvider(): LLMProvider {
  if (cachedProvider) return cachedProvider;
  assertConfigured();

  const { provider, apiKey, baseUrl, model, temperature } = config.llm;
  const systemPrompt = undefined; // 使用各 Provider 的默认提示

  switch (provider) {
    case 'openai':
    case 'openai-compatible': {
      cachedProvider = new OpenAICompatibleProvider({
        apiKey,
        baseUrl: baseUrl,
        model,
        temperature,
        systemPrompt,
      });
      break;
    }
    case 'anthropic': {
      cachedProvider = new AnthropicProvider({
        apiKey,
        model,
        temperature,
        baseUrl: baseUrl || undefined,
        systemPrompt,
      });
      break;
    }
    case 'openai-response': {
      cachedProvider = new OpenAIResponseProvider({
        apiKey,
        model,
        temperature,
        baseUrl: baseUrl || undefined,
        systemPrompt,
      });
      break;
    }
    default: {
      assertConfigured(); // 兜底（不应到达）
      throw new Error(`Unknown provider: ${provider}`);
    }
  }

  return cachedProvider;
}

/** 设置界面更新 Provider 配置后清空缓存，下一轮任务会用最新运行时配置。 */
export function resetProviderCache(): void {
  cachedProvider = null;
}

/**
 * 手动获取模型列表，供设置页固定保存。
 *
 * - OpenAI 兼容: GET {baseUrl}/models
 * - Anthropic: 返回预置列表（Anthropic 不提供公开模型列表 API）
 * - OpenAI Response: 同 OpenAI 兼容
 */
export async function listProviderModels(): Promise<string[]> {
  assertConfigured();

  const provider = config.llm.provider;

  // Anthropic 没有公开的模型列表 API，返回预置列表
  if (provider === 'anthropic') {
    return getAnthropicDefaultModels();
  }

  // OpenAI 兼容 / Responses API：从 /models 端点获取
  const baseUrl = config.llm.baseUrl.replace(/\/$/, '');
  const url = `${baseUrl}/models`;
  const signal = AbortSignal.timeout(config.llm.timeoutMs);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.llm.apiKey}`,
    },
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`获取模型列表失败 (${res.status}): ${detail.slice(0, 300)}`);
  }

  const json = (await res.json()) as unknown;
  const models = extractModelIds(json);

  return [...new Set(models.filter((model) => model.trim().length > 0))]
    .sort((a, b) => a.localeCompare(b));
}

function extractModelIds(json: unknown): string[] {
  if (Array.isArray(json)) return json.filter((item): item is string => typeof item === 'string');
  if (!json || typeof json !== 'object') return [];
  const record = json as { data?: Array<{ id?: string }>; models?: unknown };
  if (Array.isArray(record.models)) {
    return record.models.filter((item): item is string => typeof item === 'string');
  }
  if (Array.isArray(record.data)) {
    return record.data
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string');
  }
  return [];
}

function getAnthropicDefaultModels(): string[] {
  return [
    'claude-sonnet-4-20250514',
    'claude-sonnet-4-20250514-preview',
    'claude-opus-4-20250514',
    'claude-opus-4-20250514-preview',
    'claude-haiku-4-20250514',
    'claude-opus-4-8-20250630',
    'claude-sonnet-4-6-20250630',
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-6-v2@20250630',
    'claude-opus-4-8-v2@20250630',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022',
    'claude-3-opus-20240229',
  ];
}
