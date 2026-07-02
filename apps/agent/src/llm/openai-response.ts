/**
 * OpenAI Responses API Provider（v2 /responses 端点）。
 *
 * OpenAI 新一代 API，将 Chat Completions 与 Assistants 统一为 /v1/responses。
 * 协议差异：
 * - input 替代 messages
 * - instructions 替代 system 角色消息
 * - output 数组替代 choices
 * - function_call 以 output item 形式表达而非 tool_calls 字段
 *
 * @see https://platform.openai.com/docs/api-reference/responses
 */

import type { Message, TokenUsage } from '@aurevoy/shared';
import { config } from '../config.js';
import type {
  LLMProvider,
  LLMStreamChunk,
  LLMStreamOptions,
  LLMFinishReason,
  AccumulatedToolCall,
  BaseProviderOptions,
} from './types.js';

interface OpenAIResponseProviderOptions extends BaseProviderOptions {
  baseUrl?: string;
}

// ---- Responses API 类型 ----

interface ResponseInputItem {
  type: 'message';
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string;
}

interface ResponseOutputItem {
  type: 'message' | 'function_call' | 'file_search_call' | 'web_search_call';
  id?: string;
  role?: string;
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  status?: string;
  // function_call specific
  name?: string;
  arguments?: string;
  call_id?: string;
}

interface ResponseStreamEvent {
  type: string;
  // response.output_item.added
  item?: ResponseOutputItem;
  // response.content_part.added
  part?: { type: string; text?: string };
  // response.output_text.delta
  delta?: string;
  // response.function_call_arguments.delta
  partial_json?: string;
  // response.completed
  response?: {
    id: string;
    status: string;
    output: ResponseOutputItem[];
    usage?: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      input_tokens_details?: { cached_tokens?: number };
      output_tokens_details?: { reasoning_tokens?: number };
    };
  };
}

// ---- Provider ----

/**
 * OpenAI Responses API Provider。
 *
 * 提供 OpenAI 新一代 API 的支持，适用于 GPT-4o 系列等模型。
 * 注意：Responses API 仍在演进中，部分特性可能变化。
 */
export class OpenAIResponseProvider implements LLMProvider {
  readonly name: string;
  private readonly baseUrl: string;

  constructor(private readonly opts: OpenAIResponseProviderOptions) {
    this.name = `openai-response:${opts.model}`;
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  }

  async *stream(messages: Message[], options?: LLMStreamOptions): AsyncIterable<LLMStreamChunk> {
    const instructions = this.extractInstructions(messages);
    const input = this.toInputItems(messages);
    const tools = options?.tools?.length ? toResponseTools(options.tools) : undefined;

    const signal = combineSignal(options?.signal, config.llm.timeoutMs);

    const body: Record<string, unknown> = {
      model: this.opts.model,
      input,
      temperature: options?.temperature ?? this.opts.temperature,
      stream: true,
      ...(tools ? { tools, tool_choice: options?.toolChoice ?? 'auto' } : {}),
    };
    if (instructions) body.instructions = instructions;

    const res = await fetch(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`OpenAI Responses API 请求失败 (${res.status}): ${detail.slice(0, 300)}`) as Error & {
        status?: number;
      };
      err.status = res.status;
      throw err;
    }

    yield* this.parseStream(res, signal);
  }

  /** 提取 instructions（Responses API 不使用 system 角色消息） */
  private extractInstructions(messages: Message[]): string {
    const parts: string[] = [];
    for (const msg of messages) {
      if (msg.role === 'system' && msg.content.trim()) {
        parts.push(msg.content.trim());
      }
    }
    return parts.join('\n\n');
  }

  /** 将 Message[] 转为 Responses API input 格式 */
  private toInputItems(messages: Message[]): ResponseInputItem[] {
    return messages
      .filter((m) => m.role !== 'system')
      .filter((m) => m.content.trim() || m.toolCalls?.length)
      .map((m) => ({
        type: 'message' as const,
        role: m.role === 'tool' ? 'user' : (m.role as 'user' | 'assistant'),
        content: m.content || '',
      }));
  }

  /** 解析 Responses API SSE 流 */
  private async *parseStream(
    res: Response,
    signal: AbortSignal,
  ): AsyncIterable<LLMStreamChunk> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    let textBuffer = '';
    let toolCalls: AccumulatedToolCall[] = [];
    let toolCallAccumulator = new ResponseToolCallAccumulator();
    let finishReason: LLMFinishReason | null = null;
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
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice('data:'.length).trim();
        if (!data || data === '[DONE]') continue;

        let event: ResponseStreamEvent;
        try {
          event = JSON.parse(data) as ResponseStreamEvent;
        } catch {
          continue;
        }

        switch (event.type) {
          case 'response.output_text.delta': {
            if (event.delta) {
              textBuffer += event.delta;
              yield { textDelta: event.delta, done: false, toolCallsSnapshot: toolCallAccumulator.snapshot() };
            }
            break;
          }
          case 'response.function_call_arguments.delta': {
            if (event.partial_json) {
              toolCallAccumulator.addDelta(event.partial_json);
            }
            break;
          }
          case 'response.output_item.added': {
            if (event.item?.type === 'function_call') {
              toolCallAccumulator.startNew({
                id: event.item.call_id ?? event.item.id ?? '',
                name: event.item.name ?? '',
              });
            }
            break;
          }
          case 'response.completed': {
            if (event.response) {
              finishReason = this.mapFinishReason(event.response.status);
              if (event.response.usage) {
                const details = event.response.usage.input_tokens_details;
                tokenUsage = {
                  promptTokens: event.response.usage.input_tokens,
                  completionTokens: event.response.usage.output_tokens,
                  totalTokens: event.response.usage.total_tokens,
                  ...(details && typeof details.cached_tokens === 'number'
                    ? { cacheReadTokens: details.cached_tokens }
                    : {}),
                };
              }
              // 从 response output 提取完整的 tool calls
              const outputToolCalls = this.extractToolCalls(event.response.output);
              if (outputToolCalls.length > 0) {
                toolCalls = outputToolCalls;
              } else {
                toolCalls = toolCallAccumulator.snapshot();
              }
            }
            break;
          }
        }
      }
    }

    yield {
      done: true,
      finishReason: finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      toolCallsSnapshot: toolCalls,
      tokenUsage,
    };
  }

  private mapFinishReason(status: string): LLMFinishReason {
    switch (status) {
      case 'completed':
        return 'stop';
      case 'incomplete':
        return 'length';
      case 'failed':
        return 'content_filter';
      default:
        return 'stop';
    }
  }

  private extractToolCalls(output: ResponseOutputItem[]): AccumulatedToolCall[] {
    const result: AccumulatedToolCall[] = [];
    let index = 0;
    for (const item of output) {
      if (item.type === 'function_call') {
        result.push({
          index: index++,
          id: item.call_id ?? item.id ?? `fc_${index}`,
          function: {
            name: item.name ?? '',
            arguments: item.arguments ?? '{}',
          },
        });
      }
    }
    return result;
  }
}

// ---- 工具函数 ----

/** 简易 tool call 累积器（Responses API 的 function_call 是完整对象而非分片 delta） */
class ResponseToolCallAccumulator {
  private calls: AccumulatedToolCall[] = [];
  private current: { name: string; args: string } | null = null;

  startNew(meta: { id: string; name: string }): void {
    if (this.current) {
      this.flushCurrent(meta.id);
    }
    this.current = { name: meta.name, args: '' };
  }

  addDelta(partialJson: string): void {
    if (this.current) {
      this.current.args += partialJson;
    }
  }

  flushCurrent(id: string): void {
    if (!this.current) return;
    this.calls.push({
      index: this.calls.length,
      id,
      function: { name: this.current.name, arguments: this.current.args || '{}' },
    });
    this.current = null;
  }

  snapshot(): AccumulatedToolCall[] {
    return [...this.calls];
  }
}

function toResponseTools(descriptors: import('@aurevoy/shared').ToolDescriptor[]) {
  return descriptors.map((d) => ({
    type: 'function' as const,
    name: d.name,
    description: d.description,
    parameters: d.inputSchema,
  }));
}

function combineSignal(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([external, timeout]) : timeout;
}
