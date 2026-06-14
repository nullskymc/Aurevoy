import type { Message, MessageRole, TokenUsage, ToolDescriptor } from '@aurevoy/shared';
import { config } from '../config.js';
import { ToolCallAccumulator, type AccumulatedToolCall, type ToolCallDelta } from '../agent/tool-call-accumulator.js';

export type { AccumulatedToolCall };

/** finish_reason 归一化取值 */
export type LLMFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter';

/**
 * 流式响应的单个 chunk —— 可能是文本 delta、reasoning delta，也可能是 tool_calls 累积。
 */
export interface LLMStreamChunk {
  /** 文本增量 */
  textDelta?: string;
  /** DeepSeek reasoning_content 增量（仅本次新增，非全量累积） */
  reasoningContentDelta?: string;
  /** 本轮是否结束 */
  done: boolean;
  /** finish_reason，仅 done=true 时有值 */
  finishReason?: LLMFinishReason;
  /** 累积中的 tool_calls 快照；done=true 时为完整结果 */
  toolCallsSnapshot?: AccumulatedToolCall[];
  /** Provider 返回的 usage；不支持时缺省。 */
  tokenUsage?: TokenUsage | null;
}

export interface LLMStreamOptions {
  /** 可用工具列表（OpenAI tools 由本层转换） */
  tools?: ToolDescriptor[];
  /** 工具选择策略 */
  toolChoice?: 'auto' | 'none' | 'required';
  /** 取消信号 */
  signal?: AbortSignal;
  /** 覆盖采样温度 */
  temperature?: number;
}

/**
 * LLM Provider 抽象。
 *
 * 接入新厂商时实现此接口并在 `getProvider()` 中按配置返回，Agent 循环无需改动。
 */
export interface LLMProvider {
  readonly name: string;
  /** 流式生成回复，支持工具调用 */
  stream(messages: Message[], options?: LLMStreamOptions): AsyncIterable<LLMStreamChunk>;
}

/** Aurevoy 的默认系统提示，给模型一个产品人格。 */
const DEFAULT_SYSTEM_PROMPT =
  '你是 Aurevoy，一个面向个人用户的通用 AI Agent。你理解用户目标、拆解任务并推动其完成。' +
  '当需要实时信息或执行操作时，调用提供给你的工具；信息足够时直接给出清晰、可执行的最终回答。' +
  '使用用户所用的语言作答。';

interface OpenAIProviderOptions {
  apiKey: string;
  /** 不含 /chat/completions 的基础地址，如 https://api.openai.com/v1 */
  baseUrl: string;
  model: string;
  temperature: number;
  systemPrompt?: string;
}

/** 上游 OpenAI 兼容消息格式 */
interface OpenAIChatMessage {
  role: string;
  content: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
  reasoning_content?: string;
}

/** 上游响应中 assistant 消息（非流式） */
interface OpenAIResponseMessage {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ToolCallDelta[];
}

/** 上游流式 delta */
interface OpenAIDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ToolCallDelta[];
}

/** 上游单个 choice（流式与非流式共用） */
interface OpenAIChoice {
  delta?: OpenAIDelta;
  message?: OpenAIResponseMessage;
  finish_reason?: string | null;
}

/** 上游 /chat/completions 响应载荷（流式单帧或非流式整体） */
interface OpenAIPayload {
  choices?: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
}

interface OpenAIModelListPayload {
  data?: Array<{ id?: string }>;
}

/**
 * OpenAI 兼容的流式 Provider。
 *
 * 通过原生 fetch 调用 `/chat/completions` 并解析 SSE 流，支持 function calling。
 * 兼容 OpenAI、DeepSeek、Moonshot、Ollama（/v1）、vLLM、LM Studio 等。
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  /** 是否为 Ollama 端点（流式 tool_calls 不稳定，带 tools 时改用非流式） */
  private readonly isOllama: boolean;

  constructor(private readonly opts: OpenAIProviderOptions) {
    this.name = `openai:${opts.model}`;
    const bu = opts.baseUrl.toLowerCase();
    this.isOllama = bu.includes('ollama') || bu.includes(':11434');
  }

  async *stream(messages: Message[], options?: LLMStreamOptions): AsyncIterable<LLMStreamChunk> {
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const tools = options?.tools?.length ? toOpenAITools(options.tools) : undefined;
    const payloadMessages: OpenAIChatMessage[] = [
      { role: 'system', content: this.opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
      ...messages.map(toOpenAIMessage),
    ];

    // Ollama 带 tools 时关闭 streaming（其流式 tool_calls 不稳定）
    const useStream = !(this.isOllama && tools);

    // 组合用户取消信号与单轮超时，防止半开连接导致任务永久挂起
    const signal = combineSignal(options?.signal, config.llm.timeoutMs);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: this.opts.model,
        temperature: options?.temperature ?? this.opts.temperature,
        stream: useStream,
        ...(useStream ? { stream_options: { include_usage: true } } : {}),
        messages: payloadMessages,
        ...(tools ? { tools, tool_choice: options?.toolChoice ?? 'auto' } : {}),
      }),
      signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      const maskedKey = this.opts.apiKey
        ? `****${this.opts.apiKey.slice(-4)}`
        : '(未设置)';
      const hint =
        res.status === 401
          ? `（请求 URL: ${url}，key 以 ${maskedKey} 结尾；请检查 AUREVOY_LLM_API_KEY 和 AUREVOY_LLM_BASE_URL）`
          : '';
      const err = new Error(`LLM 请求失败 (${res.status}): ${detail.slice(0, 300)}${hint}`) as Error & {
        status?: number;
      };
      err.status = res.status;
      throw err;
    }

    if (!useStream) {
      yield* this.parseNonStream(res);
      return;
    }
    yield* this.parseStream(res, signal);
  }

  /** 解析 SSE 流式响应 */
  private async *parseStream(
    res: Response,
    signal: AbortSignal,
  ): AsyncIterable<LLMStreamChunk> {
    const accumulator = new ToolCallAccumulator();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finishReason: string | null = null;
    let tokenUsage: TokenUsage | null = null;

    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        // 传播取消/超时的真实原因（AbortError 或 TimeoutError）
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('The operation was aborted.', 'AbortError');
      }
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // 最后一段可能不完整，留到下轮

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice('data:'.length).trim();
        if (data === '[DONE]') continue;

        let json: OpenAIPayload;
        try {
          json = JSON.parse(data) as OpenAIPayload;
        } catch {
          continue; // 跨 chunk 截断，忽略本行
        }

        if (json.usage) tokenUsage = normalizeUsage(json.usage);
        const choice = json.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};

        const reasoningDelta = delta.reasoning_content ?? undefined;

        if (Array.isArray(delta.tool_calls)) {
          accumulator.process(delta.tool_calls);
        }

        if (delta.content || reasoningDelta) {
          yield {
            textDelta: delta.content ?? undefined,
            reasoningContentDelta: reasoningDelta ?? undefined,
            done: false,
            toolCallsSnapshot: accumulator.snapshot(),
          };
        }

        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }

    yield {
      done: true,
      finishReason: normalizeFinish(finishReason, accumulator.hasAny()),
      toolCallsSnapshot: accumulator.snapshot(),
      tokenUsage,
    };
  }

  /** 解析非流式响应（Ollama 带 tools 时） */
  private async *parseNonStream(res: Response): AsyncIterable<LLMStreamChunk> {
    const json = (await res.json()) as OpenAIPayload;
    const choice = json.choices?.[0];
    const msg = choice?.message ?? {};
    const accumulator = new ToolCallAccumulator();

    if (Array.isArray(msg.tool_calls)) {
      accumulator.process(
        msg.tool_calls.map((tc, i) => ({
          index: tc.index ?? i,
          id: tc.id,
          type: tc.type,
          function: { name: tc.function?.name, arguments: tc.function?.arguments },
        })),
      );
    }

    if (msg.content) {
      yield { textDelta: msg.content, done: false };
    }
    if (msg.reasoning_content) {
      yield { reasoningContentDelta: msg.reasoning_content, done: false };
    }

    yield {
      done: true,
      finishReason: normalizeFinish(choice?.finish_reason ?? null, accumulator.hasAny()),
      toolCallsSnapshot: accumulator.snapshot(),
      tokenUsage: normalizeUsage(json.usage),
    };
  }
}

/** 把 Aurevoy Message 转为 OpenAI 兼容消息格式 */
function toOpenAIMessage(msg: Message): OpenAIChatMessage {
  const out: OpenAIChatMessage = {
    role: toOpenAIRole(msg.role),
    content: msg.content,
  };
  // assistant 携带 tool_calls；OpenAI 要求此时 content 可为 null
  if (msg.role === 'assistant' && msg.toolCalls?.length) {
    out.tool_calls = msg.toolCalls;
    if (!out.content) out.content = null;
  }
  // tool 结果消息需要 tool_call_id
  if (msg.role === 'tool' && msg.toolCallId) {
    out.tool_call_id = msg.toolCallId;
  }
  // DeepSeek reasoning_content 回传（思考模式多轮必需）
  if (msg.reasoningContent) {
    out.reasoning_content = msg.reasoningContent;
  }
  return out;
}

function toOpenAIRole(role: MessageRole): string {
  switch (role) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'system':
      return 'system';
    case 'tool':
      return 'tool';
    default:
      return 'user';
  }
}

/** 把工具描述转为 OpenAI tools 格式 */
function toOpenAITools(descriptors: ToolDescriptor[]) {
  return descriptors.map((d) => ({
    type: 'function' as const,
    function: {
      name: d.name,
      description: d.description,
      parameters: d.inputSchema,
    },
  }));
}

/** 组合用户取消信号与单轮超时信号（任一触发即中断 fetch） */
function combineSignal(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([external, timeout]) : timeout;
}

const VALID_FINISH: readonly string[] = ['stop', 'tool_calls', 'length', 'content_filter'];

function normalizeFinish(reason: string | null, hasToolCalls: boolean): LLMFinishReason {
  if (reason && VALID_FINISH.includes(reason)) return reason as LLMFinishReason;
  // 某些提供商在非流式或降级时不给 finish_reason，用是否有 tool_calls 兜底
  return hasToolCalls ? 'tool_calls' : 'stop';
}

function normalizeUsage(usage: OpenAIPayload['usage']): TokenUsage | null {
  if (!usage) return null;
  const out: TokenUsage = {};
  if (typeof usage.prompt_tokens === 'number') out.promptTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === 'number') out.completionTokens = usage.completion_tokens;
  if (typeof usage.total_tokens === 'number') out.totalTokens = usage.total_tokens;
  return Object.keys(out).length > 0 ? out : null;
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

/** 从当前 OpenAI-compatible Provider 手动获取模型列表，供设置页固定保存。 */
export async function listProviderModels(): Promise<string[]> {
  assertConfigured();
  const url = `${config.llm.baseUrl.replace(/\/$/, '')}/models`;
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
  const record = json as OpenAIModelListPayload & { models?: unknown };
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

/** 设置界面更新 Provider 配置后清空缓存，下一轮任务会用最新运行时配置。 */
export function resetProviderCache(): void {
  cachedProvider = null;
}
