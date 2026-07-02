/**
 * OpenAI 兼容 Provider（/chat/completions 端点）。
 *
 * 通过原生 fetch 调用兼容 OpenAI 协议的所有服务：
 * - OpenAI
 * - DeepSeek（支持 reasoning_content）
 * - Moonshot
 * - Ollama（/v1 端点）
 * - vLLM
 * - LM Studio
 */

import type { Message, MessageRole, TokenUsage, ToolDescriptor } from '@aurevoy/shared';
import { promises as fs } from 'node:fs';
import { config } from '../config.js';
import { ToolCallAccumulator, type ToolCallDelta } from '../agent/tool-call-accumulator.js';
import type {
  LLMProvider,
  LLMStreamChunk,
  LLMStreamOptions,
  LLMFinishReason,
  BaseProviderOptions,
} from './types.js';

/** Aurevoy 默认系统提示 */
export const DEFAULT_SYSTEM_PROMPT =
  '你是 Aurevoy，一个面向个人用户的通用 AI Agent。你理解用户目标、拆解任务并推动其完成。' +
  '当需要实时信息或执行操作时，调用提供给你的工具；信息足够时直接给出清晰、可执行的最终回答。' +
  '使用用户所用的语言作答。';

interface OpenAIProviderOptions extends BaseProviderOptions {
  /** 不含 /chat/completions 的基础地址，如 https://api.openai.com/v1 */
  baseUrl: string;
}

/** OpenAI 多模态 content block 类型 */
interface OpenAITextBlock {
  type: 'text';
  text: string;
}

interface OpenAIImageUrlBlock {
  type: 'image_url';
  image_url: {
    url: string; // data:image/...;base64,... 或 https:// URL
    detail?: 'low' | 'high' | 'auto';
  };
}

type OpenAIContentBlock = OpenAITextBlock | OpenAIImageUrlBlock;

/** 消息是否含有图片附件 */
function hasImageAttachments(msg: Message): boolean {
  return (msg.attachments ?? []).some((a) => a.type === 'image');
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

async function readImageAsBase64(filePath: string, mimeType: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(filePath);
    if (buf.length > MAX_IMAGE_BYTES) return null;
    const b64 = buf.toString('base64');
    return `data:${mimeType};base64,${b64}`;
  } catch {
    return null;
  }
}

/** 上游 OpenAI 兼容消息格式 */
interface OpenAIChatMessage {
  role: string;
  content: string | null | OpenAIContentBlock[];
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

/**
 * OpenAI 兼容的流式 Provider。
 *
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

    // 视觉子模型：本轮消息含图片 + 配置了 visionModel → 切换模型 + 注入图片
    const needsVision = messages.some((m) => hasImageAttachments(m));
    const includeImages = needsVision && config.llm.visionModel.trim().length > 0;
    const effectiveModel = includeImages ? config.llm.visionModel : this.opts.model;

    const payloadMessages: OpenAIChatMessage[] = [
      { role: 'system', content: this.opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
      ...(await Promise.all(messages.map((m) => toOpenAIMessage(m, includeImages)))),
    ];

    // Ollama 带 tools 时关闭 streaming（其流式 tool_calls 不稳定）
    const useStream = !(this.isOllama && tools);

    // 组合用户取消信号与单轮超时
    const signal = combineSignal(options?.signal, config.llm.timeoutMs);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: effectiveModel,
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
          continue;
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

// ---- 消息转换 ----

/** 把 Aurevoy Message 转为 OpenAI 兼容消息格式 */
async function toOpenAIMessage(
  msg: Message,
  includeImages: boolean,
): Promise<OpenAIChatMessage> {
  const out: OpenAIChatMessage = {
    role: toOpenAIRole(msg.role),
    content: msg.content,
  };

  // 用户消息 + 图片附件 → 多模态 content 数组
  if (msg.role === 'user' && hasImageAttachments(msg)) {
    if (includeImages) {
      const blocks: OpenAIContentBlock[] = [];

      if (msg.content.trim()) {
        blocks.push({ type: 'text', text: msg.content });
      } else {
        blocks.push({ type: 'text', text: '请看以下图片：' });
      }

      for (const att of msg.attachments ?? []) {
        if (att.type !== 'image') continue;
        const dataUrl = await readImageAsBase64(att.path, att.mimeType);
        if (dataUrl) {
          blocks.push({
            type: 'image_url',
            image_url: { url: dataUrl, detail: 'auto' },
          });
        } else {
          blocks.push({
            type: 'text',
            text: `\n[图片 "${att.name}" 无法读取或过大（>20MB）]`,
          });
        }
      }

      out.content = blocks;
    } else {
      // 文本模型：将图片附件转为文字引用
      const imageNames = (msg.attachments ?? [])
        .filter((a) => a.type === 'image')
        .map((a) => a.name)
        .join('、');
      const prefix = msg.content.trim()
        ? `${msg.content}\n\n[用户附带了图片: ${imageNames}]`
        : `[用户附带了图片: ${imageNames}]`;
      out.content = prefix;
    }
  }

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
    case 'user': return 'user';
    case 'assistant': return 'assistant';
    case 'system': return 'system';
    case 'tool': return 'tool';
    default: return 'user';
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

// ---- 工具函数 ----

/** 组合用户取消信号与单轮超时信号 */
function combineSignal(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([external, timeout]) : timeout;
}

const VALID_FINISH: readonly string[] = ['stop', 'tool_calls', 'length', 'content_filter'];

function normalizeFinish(reason: string | null, hasToolCalls: boolean): LLMFinishReason {
  if (reason && VALID_FINISH.includes(reason)) return reason as LLMFinishReason;
  return hasToolCalls ? 'tool_calls' : 'stop';
}

function normalizeUsage(usage: OpenAIPayload['usage']): TokenUsage | null {
  if (!usage) return null;
  const out: TokenUsage = {};
  if (typeof usage.prompt_tokens === 'number') out.promptTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === 'number') out.completionTokens = usage.completion_tokens;
  if (typeof usage.total_tokens === 'number') out.totalTokens = usage.total_tokens;
  
  // 尝试多种可能的 cache 字段位置
  const usageObj = usage as Record<string, unknown>;
  
  // OpenAI 标准格式：prompt_tokens_details.cached_tokens
  const promptDetails = usageObj.prompt_tokens_details as Record<string, unknown> | undefined;
  if (promptDetails && typeof promptDetails.cached_tokens === 'number') {
    out.cacheReadTokens = promptDetails.cached_tokens;
  }
  
  // 备选：直接在 usage 下的 cached_tokens 或 cache_read_tokens
  if (out.cacheReadTokens === undefined) {
    if (typeof usageObj.cached_tokens === 'number') {
      out.cacheReadTokens = usageObj.cached_tokens;
    } else if (typeof usageObj.cache_read_tokens === 'number') {
      out.cacheReadTokens = usageObj.cache_read_tokens;
    }
  }
  
  // cache write tokens (较少见，但某些 provider 可能返回)
  const cacheWrite = usageObj.cache_creation_tokens ?? usageObj.cache_write_tokens;
  if (typeof cacheWrite === 'number') {
    out.cacheWriteTokens = cacheWrite;
  }
  
  return Object.keys(out).length > 0 ? out : null;
}
