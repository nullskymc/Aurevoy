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

/** Aurevoy 的默认系统提示，给真实模型一个产品人格。 */
const DEFAULT_SYSTEM_PROMPT =
  '你是 Aurevoy，一个面向个人用户的通用 AI Agent。你理解用户目标、拆解任务并推动其完成。' +
  '回答应清晰、可执行，并在合适时给出下一步建议。使用用户所用的语言作答。';

/**
 * Mock Provider —— 无需任何 API Key 即可运行整条链路，用于开发期验证
 * "创建任务 → 规划 → 流式输出 → 完成" 的端到端流程。
 */
export class MockProvider implements LLMProvider {
  readonly name = 'mock';

  async *stream(messages: Message[]): AsyncIterable<LLMChunk> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const goal = lastUser?.content ?? '任务';
    const reply = `（Mock 引擎）我已理解你的目标：「${goal}」。这是一个占位回复，接入真实 LLM Provider 后这里会变成真正的推理与执行结果。`;
    for (const ch of reply) {
      await delay(15);
      yield { delta: ch, done: false };
    }
    yield { delta: '', done: true };
  }
}

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let cachedProvider: LLMProvider | null = null;

/**
 * 按配置返回 LLM Provider（进程内缓存，环境在启动时固定）。
 *
 * - provider=openai 且配置了 apiKey → OpenAI 兼容 Provider；
 * - 其余情况（含缺少 Key）→ 回退 Mock，保证链路始终可用。
 */
export function getProvider(): LLMProvider {
  if (cachedProvider) return cachedProvider;

  const { provider, apiKey, baseUrl, model, temperature } = config.llm;

  if (provider === 'openai' || provider === 'openai-compatible') {
    if (!apiKey) {
      console.warn(
        '[Aurevoy] 已选择 openai provider 但缺少 AUREVOY_LLM_API_KEY，回退到 Mock。',
      );
      cachedProvider = new MockProvider();
    } else {
      cachedProvider = new OpenAICompatibleProvider({ apiKey, baseUrl, model, temperature });
    }
  } else {
    cachedProvider = new MockProvider();
  }

  return cachedProvider;
}
