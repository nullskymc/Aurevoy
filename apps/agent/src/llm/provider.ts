import type { Message, MessageRole } from '@aurevoy/shared';
import { config } from '../config.js';

/** LLM 流式输出的增量片段 */
export interface LLMChunk {
  delta: string;
  done: boolean;
}

/**
 * LLM Provider 抽象。
 *
 * 接入 OpenAI / Anthropic / 本地模型时，只需实现此接口并在
 * `getProvider()` 中按配置返回对应实现，Agent 循环无需改动。
 */
export interface LLMProvider {
  readonly name: string;
  /** 以流式方式生成回复 */
  stream(messages: Message[]): AsyncIterable<LLMChunk>;
}

/** Aurevoy 的默认系统提示，给模型一个产品人格。 */
const DEFAULT_SYSTEM_PROMPT =
  '你是 Aurevoy，一个面向个人用户的通用 AI Agent。你理解用户目标、拆解任务并推动其完成。' +
  '回答应清晰、可执行，并在合适时给出下一步建议。使用用户所用的语言作答。';

interface OpenAIProviderOptions {
  apiKey: string;
  /** 不含 /chat/completions 的基础地址，如 https://api.openai.com/v1 */
  baseUrl: string;
  model: string;
  temperature: number;
  systemPrompt?: string;
}

/**
 * OpenAI 兼容的流式 Provider。
 *
 * 通过原生 fetch 调用 `/chat/completions` 并解析 SSE 流。
 * 凡是兼容 OpenAI Chat Completions 协议的服务都可用：
 * OpenAI、DeepSeek、Moonshot、本地 Ollama（/v1）、vLLM、LM Studio 等。
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;

  constructor(private readonly opts: OpenAIProviderOptions) {
    this.name = `openai:${opts.model}`;
  }

  async *stream(messages: Message[]): AsyncIterable<LLMChunk> {
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const payloadMessages = [
      { role: 'system', content: this.opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
      ...messages
        .filter((m) => m.role !== 'tool')
        .map((m) => ({ role: toOpenAIRole(m.role), content: m.content })),
    ];

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: this.opts.model,
        temperature: this.opts.temperature,
        stream: true,
        messages: payloadMessages,
      }),
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`LLM 请求失败 (${res.status}): ${detail.slice(0, 300)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // 最后一段可能是不完整的行，留到下一轮
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice('data:'.length).trim();
        if (data === '[DONE]') {
          yield { delta: '', done: true };
          return;
        }
        try {
          const json = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield { delta, done: false };
        } catch {
          // 跨 chunk 截断的 JSON，忽略本行（下一轮 buffer 会补全）
        }
      }
    }

    yield { delta: '', done: true };
  }
}

function toOpenAIRole(role: MessageRole): 'system' | 'user' | 'assistant' {
  if (role === 'system') return 'system';
  if (role === 'assistant') return 'assistant';
  return 'user';
}

/** 当前支持的 Provider 类型。后续接入新厂商时在此扩展。 */
const SUPPORTED_PROVIDERS = ['openai', 'openai-compatible'] as const;

/**
 * 校验 LLM 配置；缺失或不支持时抛出清晰错误。
 * 不在此静默回退到占位实现——未配置必须显式失败，避免污染真实结果。
 */
function assertConfigured(): void {
  const { provider, apiKey } = config.llm;
  if (!SUPPORTED_PROVIDERS.includes(provider as (typeof SUPPORTED_PROVIDERS)[number])) {
    throw new Error(
      `未支持的 LLM Provider: "${provider}"。请在项目根目录 .env 设置 ` +
        `AUREVOY_LLM_PROVIDER=openai（兼容 OpenAI/DeepSeek/Ollama 等）。`,
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
 * 未配置时返回 'unconfigured'，供 `/api/health` 安全使用。
 */
export function getProviderName(): string {
  return isLLMConfigured() ? `openai:${config.llm.model}` : 'unconfigured';
}

let cachedProvider: LLMProvider | null = null;

/**
 * 按配置返回 LLM Provider（进程内缓存，环境在启动时固定）。
 * 未配置时**抛出错误**——由调用方（Agent 循环）捕获并通过 error 事件上报。
 */
export function getProvider(): LLMProvider {
  if (cachedProvider) return cachedProvider;

  assertConfigured();

  const { apiKey, baseUrl, model, temperature } = config.llm;
  cachedProvider = new OpenAICompatibleProvider({ apiKey, baseUrl, model, temperature });
  return cachedProvider;
}
