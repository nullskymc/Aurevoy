import type { Message } from '@aurevoy/shared';

/** 以 SQLite 耐久消息为前缀真相，并补入 runtime 尚未落库的唯一消息。 */
export function mergeDurableTaskMessages(durable: Message[], memory: Message[]): Message[] {
  const memoryById = new Map(memory.map((message) => [message.id, message]));
  const durableIds = new Set(durable.map((message) => message.id));
  const merged = durable.map((message) => {
    const runtimeMessage = memoryById.get(message.id);
    return runtimeMessage ? mergeMessageEnrichment(message, runtimeMessage) : message;
  });

  return [
    ...merged,
    ...memory.filter((message) => !durableIds.has(message.id)),
  ];
}

/**
 * SQLite 是消息顺序与正文的耐久基线，但 runtime 可能在同一消息上追加富内容块。
 * 这里只合并明确的追加型字段，避免旧 runtime 实例覆盖 HTTP 路径刚写入的正文。
 */
function mergeMessageEnrichment(durable: Message, memory: Message): Message {
  if (!durable.contentBlocks && !memory.contentBlocks) return durable;

  const contentBlocks = mergeContentBlocks(durable.contentBlocks, memory.contentBlocks);
  return contentBlocks.length > 0
    ? { ...durable, contentBlocks }
    : { ...durable, contentBlocks: undefined };
}

/** 按 block id 去重，runtime 的同 id 更新优先，保持 SQLite 原有顺序。 */
function mergeContentBlocks(
  durable: Message['contentBlocks'],
  memory: Message['contentBlocks'],
): NonNullable<Message['contentBlocks']> {
  const merged = [...(durable ?? [])];
  const indexById = new Map(merged.map((block, index) => [block.id, index]));

  for (const block of memory ?? []) {
    const index = indexById.get(block.id);
    if (index === undefined) {
      indexById.set(block.id, merged.length);
      merged.push(block);
    } else {
      merged[index] = block;
    }
  }

  return merged;
}
