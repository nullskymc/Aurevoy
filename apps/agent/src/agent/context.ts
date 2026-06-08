import type { MemoryEntry, Message } from '@aurevoy/shared';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

/**
 * 会话级短期记忆 —— 上下文窗口管理（M4.2）。
 *
 * 目标：把任务的完整消息历史压缩成"喂给 LLM 的上下文窗口"，而不是裸拼接全部历史。
 * 原则（确定性、可解释、可审计）：
 *  - 用户消息（用户约束/目标）始终逐字保留——它们是任务的边界条件，且通常很短。
 *  - 最近 N 条消息逐字保留（近窗口边界），保证最新工具结果与思考可见。
 *  - 更早的 assistant/tool 内容若超预算则**就地截断为摘要**（保留引用，不删除消息），
 *    从而既压缩体积，又不破坏 OpenAI 的 assistant→tool 配对契约与消息顺序。
 *
 * 该模块只产出"本轮请求用"的消息副本；任务真实历史 `task.messages` 不被修改。
 */

export interface ContextWindowOptions {
  /** 历史消息总字符预算 */
  charBudget: number;
  /** 逐字保留的最近消息条数 */
  recentWindow: number;
  /** 被压缩消息的单条内容字符上限 */
  compressedCharCap: number;
}

export interface ContextWindowResult {
  /** 实际发送给 LLM 的消息（system 由 provider 另行前置） */
  messages: Message[];
  /** 是否发生了压缩 */
  compressed: boolean;
  /** 压缩前历史总字符 */
  originalChars: number;
  /** 压缩后历史总字符 */
  finalChars: number;
  /** 历史消息总条数 */
  totalMessages: number;
  /** 被截断压缩的消息条数 */
  compressedCount: number;
}

function defaultOptions(): ContextWindowOptions {
  return {
    charBudget: config.agent.contextCharBudget,
    recentWindow: config.agent.recentMessageWindow,
    compressedCharCap: config.agent.compressedMessageCharCap,
  };
}

function contentChars(message: Message): number {
  let n = message.content?.length ?? 0;
  if (message.reasoningContent) n += message.reasoningContent.length;
  // tool_calls 的参数也占用上下文
  if (message.toolCalls?.length) {
    for (const tc of message.toolCalls) n += tc.function.arguments?.length ?? 0;
  }
  return n;
}

function totalChars(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + contentChars(m), 0);
}

/** 把一段内容截断为带摘要标记的压缩内容；空内容原样返回。 */
function compressContent(content: string, cap: number): string {
  if (!content || content.length <= cap) return content;
  const kept = content.slice(0, cap);
  const folded = content.length - cap;
  return `${kept}\n…[此处省略 ${folded} 个字符；上下文压缩，完整内容见任务轨迹]`;
}

/**
 * 构建本轮 LLM 请求的上下文窗口。
 *
 * @param history 任务完整消息历史（user/assistant/tool，不含 system）
 */
export function buildContextWindow(
  history: Message[],
  options: Partial<ContextWindowOptions> = {},
): ContextWindowResult {
  const opts = { ...defaultOptions(), ...options };
  const originalChars = totalChars(history);
  const totalMessages = history.length;

  if (originalChars <= opts.charBudget) {
    return {
      messages: history,
      compressed: false,
      originalChars,
      finalChars: originalChars,
      totalMessages,
      compressedCount: 0,
    };
  }

  // 近窗口边界：最后 recentWindow 条逐字保留
  const recentStart = Math.max(0, history.length - opts.recentWindow);
  let compressedCount = 0;

  const messages = history.map((message, index) => {
    const inRecentWindow = index >= recentStart;
    // 用户约束与近窗口逐字保留
    if (inRecentWindow || message.role === 'user') return message;

    const compressedContentText = compressContent(message.content ?? '', opts.compressedCharCap);
    const reasoningCompressed = message.reasoningContent
      ? compressContent(message.reasoningContent, opts.compressedCharCap)
      : message.reasoningContent;

    const changed =
      compressedContentText !== message.content || reasoningCompressed !== message.reasoningContent;
    if (!changed) return message;

    compressedCount += 1;
    // 浅拷贝 + 截断内容；保留 toolCalls / toolCallId / role 等结构，确保配对契约不被破坏
    return {
      ...message,
      content: compressedContentText,
      ...(message.reasoningContent ? { reasoningContent: reasoningCompressed } : {}),
    };
  });

  return {
    messages,
    compressed: compressedCount > 0,
    originalChars,
    finalChars: totalChars(messages),
    totalMessages,
    compressedCount,
  };
}

/** 注入上下文的记忆条数上限（防止记忆膨胀挤占预算）。 */
const MAX_INJECTED_MEMORIES = 50;

const CATEGORY_LABEL: Record<MemoryEntry['category'], string> = {
  preference: '偏好',
  directory: '常用目录',
  model: '模型偏好',
  habit: '习惯',
  fact: '事实',
  other: '其他',
};

/**
 * 把启用的长期记忆构建为一条 system 消息，注入到 LLM 上下文最前面。
 * 已禁用的记忆不会出现在这里（启停的真实效果）。无启用记忆时返回 null。
 */
export function buildMemorySystemMessage(memories: MemoryEntry[]): Message | null {
  const enabled = memories.filter((m) => m.enabled).slice(0, MAX_INJECTED_MEMORIES);
  if (enabled.length === 0) return null;

  const lines = enabled.map((m) => `- (${CATEGORY_LABEL[m.category]}) ${m.content}`);
  const content =
    '[关于用户的长期记忆]\n' +
    '以下是用户确认或你此前记录并启用的长期记忆，作为背景参考；' +
    '若与当前对话中的明确信息冲突，以当前对话为准：\n' +
    lines.join('\n');

  return {
    id: randomUUID(),
    role: 'system',
    content,
    createdAt: new Date().toISOString(),
  };
}
