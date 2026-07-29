import type { Message as PiMessage } from '@earendil-works/pi-ai/compat';
import {
  compactToolResult,
  TOOLS_KEEP_VERBATIM,
  TOOLS_WITH_LARGE_OUTPUT,
} from '../context.js';

/** 从 Pi 消息历史中建立工具调用 ID 到工具名的映射。 */
function buildPiToolNameMap(messages: PiMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (
        isRecord(block) &&
        block.type === 'toolCall' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
      ) {
        map.set(block.id, block.name);
      }
    }
  }
  return map;
}

/** 将 Pi content block 数组拼成纯文本，供确定性压缩判断使用。 */
function piMessageText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') return block.text;
    return '';
  }).join('');
}

/** 移除空工具结果，以及只包含这些空结果的配对 assistant 消息。 */
function snipPiToolResults(messages: PiMessage[]): PiMessage[] {
  const toolNameMap = buildPiToolNameMap(messages);
  const snipToolResultIndices = new Set<number>();

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== 'toolResult') continue;
    const toolName = message.toolName ?? toolNameMap.get(message.toolCallId ?? '');
    if (toolName && TOOLS_KEEP_VERBATIM.has(toolName)) continue;

    const text = piMessageText(message.content).trim();
    if (!text || text === '{}' || text === '{"ok":true}' || text === 'null' || text === 'undefined') {
      snipToolResultIndices.add(index);
    }
  }

  if (snipToolResultIndices.size === 0) return messages;

  const snipAssistantIndices = new Set<number>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;

    const callIds = message.content.flatMap((block) =>
      isRecord(block) && block.type === 'toolCall' && typeof block.id === 'string'
        ? [block.id]
        : [],
    );
    if (callIds.length === 0) continue;

    const callIdSet = new Set(callIds);
    let allSnipped = true;
    let anyFound = false;
    for (let resultIndex = index + 1; resultIndex < messages.length; resultIndex++) {
      const result = messages[resultIndex];
      if (result.role !== 'toolResult') break;
      if (result.toolCallId && callIdSet.has(result.toolCallId)) {
        anyFound = true;
        if (!snipToolResultIndices.has(resultIndex)) {
          allSnipped = false;
          break;
        }
      }
    }
    if (anyFound && allSnipped) snipAssistantIndices.add(index);
  }

  const removedIndices = new Set([...snipToolResultIndices, ...snipAssistantIndices]);
  return messages.filter((_, index) => !removedIndices.has(index));
}

/** 对大输出工具的结果做结构化、确定性的微压缩。 */
function microcompactPiToolResults(messages: PiMessage[]): PiMessage[] {
  let changed = false;
  const result = messages.map((message) => {
    if (message.role !== 'toolResult') return message;
    const toolName = message.toolName ?? '';
    if (!TOOLS_WITH_LARGE_OUTPUT.has(toolName)) return message;

    const text = piMessageText(message.content);
    if (!text || text.includes('"_compacted":true') || text.includes('"_compacted": true')) return message;

    const compacted = compactToolResult(toolName, text);
    if (compacted === null || compacted === text) return message;

    changed = true;
    return {
      ...message,
      content: [{ type: 'text' as const, text: compacted }],
    };
  });
  return changed ? result : messages;
}

/**
 * 对完整 Pi 历史执行确定性 Snip + Microcompact。
 * 原始会话不被改写，因此后续轮次仍能保持已发送前缀的字节稳定。
 */
export function compactPiMessagesCacheAware(messages: PiMessage[]): PiMessage[] {
  return microcompactPiToolResults(snipPiToolResults(messages));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
