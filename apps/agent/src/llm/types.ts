/**
 * LLM Provider 抽象层 — 核心类型。
 *
 * 定义所有 Provider 共用的接口与归一化类型。
 * Agent 循环只依赖此文件定义的接口，不关心具体厂商协议。
 */

import type { Message, TokenUsage, ToolDescriptor } from '@aurevoy/shared';
import type { AccumulatedToolCall } from '../agent/tool-call-accumulator.js';

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
  /** 可用工具列表（各 Provider 自行转换为厂商格式） */
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
 * 接入新厂商时实现此接口并在 `getProvider()` 中注册，Agent 循环无需改动。
 */
export interface LLMProvider {
  readonly name: string;
  /** 流式生成回复，支持工具调用 */
  stream(messages: Message[], options?: LLMStreamOptions): AsyncIterable<LLMStreamChunk>;
}

/** Provider 实例化参数（所有厂商的公共字段） */
export interface BaseProviderOptions {
  apiKey: string;
  model: string;
  temperature: number;
  /** 厂商特定的系统消息（缺省使用全局默认） */
  systemPrompt?: string;
  /** 单轮最大输出 token 数（Anthropic 必需，OpenAI 可选） */
  maxTokens?: number;
}
