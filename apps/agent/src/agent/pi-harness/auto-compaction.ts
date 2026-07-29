import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  generateSummary,
  shouldCompact,
  type AgentMessage,
} from '@earendil-works/pi-agent-core';
import type { Model as PiModel, Models as PiModels } from '@earendil-works/pi-ai/compat';
import type { Message as PiMessage } from '@earendil-works/pi-ai/compat';
import { config } from '../../config.js';
import { compactPiMessagesCacheAware } from './context-compaction.js';

export interface AutoCompactionNotice {
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  /** 被折叠进摘要的较早消息条数。 */
  summarizedCount: number;
}

export interface InlineAutoCompactorDeps {
  models: PiModels;
  model: PiModel<any>;
  signal: AbortSignal;
  /** 只有真正生成了一次新摘要时才回调（缓存命中不回调，避免每轮刷事件）。 */
  onCompacted: (info: AutoCompactionNotice) => void;
  /** 失败降级等诊断轨迹。 */
  trace: (summary: string, data?: unknown) => void;
}

/**
 * 阈值触发的内联 LLM 自动压缩。
 *
 * 关键约束：harness.compact() 要求 idle phase，无法在 prompt() 运行中调用，
 * 因此不走 session-tree 重写，而是在 context 钩子里把「较早历史」替换为一条
 * LLM 摘要消息返回给 provider——会话存储仍是原文，只影响本次发送的上下文。
 * 与既有确定性 Snip+Microcompact 同一「不改存储」语义，可叠加。
 *
 * 记忆（memo）：消息是 append-only 增长；当折叠边界不变时复用上一次摘要，
 * 仅当新消息把边界向后推移才重新生成，避免每轮重复一次 LLM 摘要。
 */
export function createInlineAutoCompactor(deps: InlineAutoCompactorDeps): {
  apply: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
} {
  let memo: { boundaryKey: string; summary: string } | null = null;

  async function apply(messages: AgentMessage[]): Promise<AgentMessage[]> {
    // 先做确定性 Snip+Microcompact（保持缓存前缀字节稳定）。
    const snipped = compactPiMessagesCacheAware(messages as PiMessage[]) as AgentMessage[];
    if (!config.agent.autoCompact) {
      memo = null;
      return snipped;
    }

    const contextWindow = contextWindowOf(deps.model);
    const settings = {
      enabled: true,
      reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      keepRecentTokens: DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
    };
    const estimate = estimateContextTokens(snipped);
    if (!shouldCompact(estimate.tokens, contextWindow, settings)) {
      memo = null;
      return snipped;
    }

    const cut = findAutoCompactCutIndex(snipped, config.agent.compactKeepRecentTurns);
    if (cut <= 0 || cut >= snipped.length) {
      // 全是近端回合或无从折叠：退回确定性裁剪，不注入摘要。
      memo = null;
      return snipped;
    }

    const prefix = snipped.slice(0, cut);
    const tail = snipped.slice(cut);
    const boundaryKey = `${cut}:${messageKey(snipped[cut])}:${messageKey(snipped[cut - 1])}`;

    let summary: string;
    if (memo && memo.boundaryKey === boundaryKey) {
      summary = memo.summary;
    } else {
      const result = await generateSummary(
        prefix,
        deps.models,
        deps.model,
        DEFAULT_COMPACTION_SETTINGS.reserveTokens,
        deps.signal,
        undefined,
        memo?.summary,
        undefined,
        undefined,
      );
      if (!result.ok) {
        deps.trace(
          `自动压缩的 LLM 摘要失败，退回确定性裁剪：${result.error.message}`,
          { tokensBefore: estimate.tokens, contextWindow },
        );
        memo = null;
        return snipped;
      }
      summary = result.value;
      memo = { boundaryKey, summary };
    }

    const summaryMessage = {
      role: 'user',
      content: `[对话历史摘要 — 已折叠 ${prefix.length} 条较早消息，完整记录仍保留]\n${summary}`,
      timestamp: Date.now(),
    } as unknown as AgentMessage;
    const resultMessages = [summaryMessage, ...tail];
    deps.onCompacted({
      summary,
      tokensBefore: estimate.tokens,
      tokensAfter: estimateContextTokens(resultMessages).tokens,
      summarizedCount: prefix.length,
    });
    return resultMessages;
  }

  return { apply };
}

/**
 * 手动 /compact 与运行外摘要的底层：对一组 Pi 消息生成一段 LLM 摘要。
 * 失败返回 null，由调用方决定如何降级（绝不用截断冒充摘要）。
 */
export async function summarizePiMessages(
  messages: AgentMessage[],
  models: PiModels,
  model: PiModel<any>,
  signal: AbortSignal | undefined,
  instructions?: string,
): Promise<string | null> {
  const result = await generateSummary(
    messages,
    models,
    model,
    DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    signal,
    instructions,
    undefined,
    undefined,
    undefined,
  );
  return result.ok ? result.value : null;
}

function contextWindowOf(model: PiModel<any>): number {
  const window = (model as { contextWindow?: number }).contextWindow;
  return typeof window === 'number' && window > 0 ? window : config.agent.contextTokenBudget;
}

/**
 * 选「折叠边界」：保留最近 keepRecentTurns 个用户回合为 verbatim 尾部，更早的进摘要。
 * 尾部不得以孤儿 toolResult 开头（其配对 assistant 调用仍在被折叠的更早部分）。
 */
function findAutoCompactCutIndex(messages: AgentMessage[], keepRecentTurns: number): number {
  let userSeen = 0;
  let cut = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      userSeen++;
      if (userSeen > keepRecentTurns) {
        cut = i + 1;
        break;
      }
    }
  }
  if (cut <= 0) return 0;
  while (cut < messages.length && messages[cut].role === 'toolResult') cut++;
  return cut;
}

/** 折叠边界消息的稳定指纹：边界不变即可复用旧摘要（append-only 增长下前缀不变）。 */
function messageKey(message: AgentMessage): string {
  const timestamp = 'timestamp' in message ? String(message.timestamp) : '';
  const role = message.role;
  const length = 'content' in message ? stableContentLength(message.content) : 0;
  return `${role}:${timestamp}:${length}`;
}

function stableContentLength(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      'type' in block &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      total += ((block as { text: string }).text).length;
    } else {
      total += 1;
    }
  }
  return total;
}
