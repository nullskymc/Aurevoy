/**
 * Anthropic Messages API Provider.
 *
 * 通过原生 fetch 调用 Anthropic Claude 系列模型的 /v1/messages 端点。
 * 协议差异：
 * - system prompt 为独立顶层参数而非 system 角色消息
 * - content 始终为 block 数组
 * - tool_use/tool_result 以 content block 形式表达
 * - 认证使用 x-api-key 头
 * - 必填 max_tokens
 * - SSE 事件格式与 OpenAI 不同
 */

import type { Message, TokenUsage, ToolDescriptor } from '@aurevoy/shared';
import { promises as fs } from 'node:fs';
import { config } from '../config.js';
import type {
  LLMProvider,
  LLMStreamChunk,
  LLMStreamOptions,
  LLMFinishReason,
  AccumulatedToolCall,
  BaseProviderOptions,
} from './types.js';

interface AnthropicProviderOptions extends BaseProviderOptions {
  baseUrl?: string;
}

/** Anthropic native content block types */
interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicImageSource {
  type: 'base64';
  media_type: string;
  data: string;
}

interface AnthropicImageBlock {
  type: 'image';
  source: AnthropicImageSource;
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

/** Anthropic 上游流式事件 */
interface AnthropicMessageStart {
  type: 'message_start';
  message: {
    id: string;
    model: string;
    role: 'assistant';
    content: AnthropicContentBlock[];
    stop_reason: string | null;
    stop_sequence: string | null;
    usage: { input_tokens: number; output_tokens: number };
  };
}

interface AnthropicContentBlockStart {
  type: 'content_block_start';
  index: number;
  content_block: AnthropicTextBlock | ({ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> });
}

interface AnthropicContentBlockDelta {
  type: 'content_block_delta';
  index: number;
  delta:
    | { type: 'text_delta'; text: string }
    | { type: 'input_json_delta'; partial_json: string };
}

interface AnthropicContentBlockStop {
  type: 'content_block_stop';
  index: number;
}

interface AnthropicMessageDelta {
  type: 'message_delta';
  delta: { stop_reason: string | null; stop_sequence: string | null };
  usage: { output_tokens: number };
}

interface AnthropicMessageStop {
  type: 'message_stop';
}

interface AnthropicPing {
  type: 'ping';
}

type AnthropicStreamEvent =
  | AnthropicMessageStart
  | AnthropicContentBlockStart
  | AnthropicContentBlockDelta
  | AnthropicContentBlockStop
  | AnthropicMessageDelta
  | AnthropicMessageStop
  | AnthropicPing;

/** Anthropic 请求体 */
interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: AnthropicContentBlock[];
  }>;
  tools?: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
  tool_choice?: { type: 'auto' | 'any' | 'none' };
  stream?: boolean;
  temperature?: number;
}

// ---- 图片处理 ----

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

async function readImageAsBase64(filePath: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(filePath);
    if (buf.length > MAX_IMAGE_BYTES) return null;
    return buf.toString('base64');
  } catch {
    return null;
  }
}

// ---- Anthropic Provider ----

/**
 * Anthropic Messages API Provider。
 *
 * 支持 Claude 系列模型（Claude 3.5 Sonnet、Claude 4 Sonnet/Opus 等）。
 * 兼容流式与非流式场景，支持工具调用、图片理解。
 */
export class AnthropicProvider implements LLMProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;

  constructor(private readonly opts: AnthropicProviderOptions) {
    this.name = `anthropic:${opts.model}`;
    this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.maxTokens = opts.maxTokens ?? 8192;
  }

  async *stream(messages: Message[], options?: LLMStreamOptions): AsyncIterable<LLMStreamChunk> {
    const anthropicMessages = await this.toAnthropicMessages(messages);
    const systemPrompt = this.extractSystemPrompt(messages, this.opts.systemPrompt);

    const tools = options?.tools?.length ? toAnthropicTools(options.tools) : undefined;

    const body: AnthropicRequestBody = {
      model: this.opts.model,
      max_tokens: this.maxTokens,
      temperature: options?.temperature ?? this.opts.temperature,
      messages: anthropicMessages,
      stream: true,
    };

    // 非 auto 时映射 tool_choice
    if (options?.toolChoice && options.toolChoice !== 'auto') {
      body.tool_choice = options.toolChoice === 'none'
        ? { type: 'none' }
        : { type: 'any' };
    }

    if (systemPrompt) body.system = systemPrompt;
    if (tools) body.tools = tools;

    const signal = combineSignal(options?.signal, config.llm.timeoutMs);

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.opts.apiKey,
        'anthropic-version': '2023-06-01',
        ...(tools ? { 'anthropic-beta': 'tools-2024-04-04' } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      const maskedKey = this.opts.apiKey
        ? `****${this.opts.apiKey.slice(-4)}`
        : '(未设置)';
      const hint =
        res.status === 401
          ? `（key 以 ${maskedKey} 结尾；请检查 API Key）`
          : '';
      const err = new Error(`Anthropic API 请求失败 (${res.status}): ${detail.slice(0, 300)}${hint}`) as Error & {
        status?: number;
      };
      err.status = res.status;
      throw err;
    }

    yield* this.parseStream(res, signal);
  }

  /** 提取 system prompt —— Anthropic 要求 system 为顶层参数而非消息 */
  private extractSystemPrompt(messages: Message[], override?: string): string {
    if (override) return override;

    const systemParts: string[] = [];
    for (const msg of messages) {
      if (msg.role === 'system' && msg.content.trim()) {
        systemParts.push(msg.content.trim());
      }
    }
    return systemParts.join('\n\n');
  }

  /** 将 Aurevoy Message[] 转为 Anthropic messages（仅 user/assistant） */
  private async toAnthropicMessages(
    messages: Message[],
  ): Promise<AnthropicRequestBody['messages']> {
    // 过滤 system 消息（已在 extractSystemPrompt 处理）
    const filtered = messages.filter((m) => m.role !== 'system');
    const result: AnthropicRequestBody['messages'] = [];

    for (const msg of filtered) {
      if (!msg.content.trim() && !msg.toolCalls?.length && !msg.toolCallId) continue;

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        // Assistant 带工具调用：混合文本 + tool_use blocks
        const blocks: AnthropicContentBlock[] = [];
        if (msg.content.trim()) {
          blocks.push({ type: 'text', text: msg.content });
        }
        // 处理 reasoningContent 附加文本中
        if (msg.reasoningContent) {
          blocks.push({ type: 'text', text: msg.reasoningContent });
        }
        for (const tc of msg.toolCalls) {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            parsed = {};
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: parsed,
          });
        }
        result.push({ role: 'assistant', content: blocks });
      } else if (msg.role === 'tool' && msg.toolCallId) {
        // Tool 结果
        result.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.toolCallId,
              content: msg.content || '(empty)',
            },
          ],
        });
      } else if (msg.role === 'assistant') {
        // 纯文本 assistant 消息
        const text = msg.content.trim() + (msg.reasoningContent ? `\n\n${msg.reasoningContent}` : '');
        if (text.trim()) {
          result.push({ role: 'assistant', content: [{ type: 'text', text }] });
        }
      } else if (msg.role === 'user') {
        // 用户消息：可能带图片
        const blocks = await this.toUserContentBlocks(msg);
        if (blocks.length > 0) {
          result.push({ role: 'user', content: blocks });
        }
      }
    }

    return result;
  }

  /** 用户消息内容块（文本 + 图片） */
  private async toUserContentBlocks(msg: Message): Promise<AnthropicContentBlock[]> {
    const blocks: AnthropicContentBlock[] = [];
    const images = (msg.attachments ?? []).filter((a) => a.type === 'image');

    if (msg.content.trim()) {
      blocks.push({ type: 'text', text: msg.content });
    } else if (images.length === 0) {
      return []; // 空消息
    }

    for (const att of images) {
      const b64 = await readImageAsBase64(att.path);
      if (b64) {
        const mediaType = att.mimeType || 'image/png';
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: b64 },
        });
      } else {
        blocks.push({
          type: 'text',
          text: `\n[图片 "${att.name}" 无法读取或过大（>20MB）]`,
        });
      }
    }

    return blocks;
  }

  /** 解析 Anthropic SSE 流 */
  private async *parseStream(
    res: Response,
    signal: AbortSignal,
  ): AsyncIterable<LLMStreamChunk> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finishReason: string | null = null;
    let tokenUsage: TokenUsage | null = null;

    // 用于累积 tool_use 的 partial_json（按 index）
    const toolJsonBuffers = new Map<number, string>();
    const toolMeta = new Map<number, { id: string; name: string }>();

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
      // Anthropic SSE: 事件块由 \n\n 分隔
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';

      for (const block of blocks) {
        const event = this.parseEvent(block);
        if (!event) continue;

        switch (event.type) {
          case 'message_start': {
            if (event.message.usage) {
              tokenUsage = toTokenUsage(event.message.usage.input_tokens, event.message.usage.output_tokens, event.message.usage as Record<string, unknown>);
            }
            break;
          }
          case 'content_block_start': {
            if (event.content_block.type === 'tool_use') {
              toolMeta.set(event.index, {
                id: event.content_block.id,
                name: event.content_block.name,
              });
              // 初始 input 可能是 {} 或部分 JSON
              const initialInput = JSON.stringify(event.content_block.input);
              if (initialInput !== '{}') {
                toolJsonBuffers.set(event.index, initialInput);
              } else {
                toolJsonBuffers.set(event.index, '');
              }
            }
            break;
          }
          case 'content_block_delta': {
            if (event.delta.type === 'text_delta') {
              yield {
                textDelta: event.delta.text,
                done: false,
              };
            } else if (event.delta.type === 'input_json_delta') {
              // 累积 partial JSON
              const existing = toolJsonBuffers.get(event.index) ?? '';
              toolJsonBuffers.set(event.index, existing + event.delta.partial_json);
            }
            break;
          }
          case 'content_block_stop': {
            // 检查是否有 tool_use 在此 index 结束
            if (toolMeta.has(event.index)) {
              const meta = toolMeta.get(event.index)!;
              const rawJson = toolJsonBuffers.get(event.index) ?? '{}';
              let parsed: Record<string, unknown> = {};
              try {
                parsed = JSON.parse(rawJson) as Record<string, unknown>;
              } catch {
                parsed = {};
              }
              // tool_use 完成时不立即 yield——由 message_delta 的 toolCallsSnapshot 带出
              // 但需要将累积结果存入 meta 供后续使用
              toolMeta.set(event.index, { ...meta, input: parsed } as never);
            }
            break;
          }
          case 'message_delta': {
            finishReason = event.delta.stop_reason;
            if (event.usage) {
              tokenUsage = toTokenUsage(undefined, event.usage.output_tokens, event.usage as Record<string, unknown>);
            }
            break;
          }
          case 'message_stop': {
            // 结束：组装 tool_calls
            const toolCalls: AccumulatedToolCall[] = [];
            for (const [idx, meta] of toolMeta) {
              const rawJson = toolJsonBuffers.get(idx) ?? '{}';
              let argumentsStr = '{}';
              try {
                // 尝试验证 JSON，用原始字符串
                JSON.parse(rawJson);
                argumentsStr = rawJson || '{}';
              } catch {
                argumentsStr = '{}';
              }
              toolCalls.push({
                index: idx,
                id: meta.id,
                function: {
                  name: meta.name,
                  arguments: argumentsStr,
                },
              });
            }
            // 按 index 排序
            toolCalls.sort((a, b) => a.index - b.index);

            yield {
              done: true,
              finishReason: normalizeAnthropicFinish(finishReason, toolCalls.length > 0),
              toolCallsSnapshot: toolCalls,
              tokenUsage,
            };
            // 清理
            toolJsonBuffers.clear();
            toolMeta.clear();
            return; // 流结束
          }
          // ping：忽略
        }
      }
    }

    // 如果流意外结束（没有 message_stop）
    finishReason = finishReason ?? 'stop';
    yield {
      done: true,
      finishReason: 'stop',
      toolCallsSnapshot: [],
      tokenUsage,
    };
  }

  /** 解析单条 Anthropic SSE 事件 */
  private parseEvent(block: string): AnthropicStreamEvent | null {
    const lines = block.split('\n');
    let eventType = '';
    let dataLine = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('event:')) {
        eventType = trimmed.slice('event:'.length).trim();
      } else if (trimmed.startsWith('data:')) {
        dataLine = trimmed.slice('data:'.length).trim();
      }
    }

    if (!dataLine) return null;

    try {
      const parsed = JSON.parse(dataLine) as Record<string, unknown>;

      // 根据 event 类型或 data.type 判断
      const type = eventType || (parsed.type as string);

      switch (type) {
        case 'message_start':
          return parsed as unknown as AnthropicMessageStart;
        case 'content_block_start':
          return parsed as unknown as AnthropicContentBlockStart;
        case 'content_block_delta':
          return parsed as unknown as AnthropicContentBlockDelta;
        case 'content_block_stop':
          return parsed as unknown as AnthropicContentBlockStop;
        case 'message_delta':
          return parsed as unknown as AnthropicMessageDelta;
        case 'message_stop':
          return { type: 'message_stop' };
        case 'ping':
          return { type: 'ping' };
        default:
          return null;
      }
    } catch {
      return null;
    }
  }
}

// ---- 工具函数 ----

/** 把工具描述转为 Anthropic tools 格式 */
function toAnthropicTools(descriptors: ToolDescriptor[]) {
  return descriptors.map((d) => ({
    name: d.name,
    description: d.description,
    input_schema: d.inputSchema as Record<string, unknown>,
  }));
}

/** 组合用户取消信号与单轮超时信号 */
function combineSignal(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([external, timeout]) : timeout;
}

const ANTHROPIC_FINISH_MAP: Record<string, LLMFinishReason> = {
  end_turn: 'stop',
  tool_use: 'tool_calls',
  max_tokens: 'length',
  stop_sequence: 'stop',
  content_filter: 'content_filter',
};

function normalizeAnthropicFinish(reason: string | null, hasToolCalls: boolean): LLMFinishReason {
  if (reason && ANTHROPIC_FINISH_MAP[reason]) return ANTHROPIC_FINISH_MAP[reason];
  return hasToolCalls ? 'tool_calls' : 'stop';
}

function toTokenUsage(inputTokens?: number, outputTokens?: number, usage?: Record<string, unknown>): TokenUsage | null {
  const out: TokenUsage = {};
  if (typeof inputTokens === 'number') out.promptTokens = inputTokens;
  if (typeof outputTokens === 'number') out.completionTokens = outputTokens;
  if (typeof inputTokens === 'number' && typeof outputTokens === 'number') {
    out.totalTokens = inputTokens + outputTokens;
  }
  if (usage && typeof usage === 'object') {
    const cacheRead = usage.cache_read_input_tokens;
    const cacheWrite = usage.cache_creation_input_tokens;
    if (typeof cacheRead === 'number') out.cacheReadTokens = cacheRead;
    if (typeof cacheWrite === 'number') out.cacheWriteTokens = cacheWrite;
  }
  return Object.keys(out).length > 0 ? out : null;
}
