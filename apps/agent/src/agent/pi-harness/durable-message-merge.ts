import type { Message } from '@aurevoy/shared';

/** 以 SQLite 耐久消息为前缀真相，并补入 runtime 尚未落库的唯一消息。 */
export function mergeDurableTaskMessages(durable: Message[], memory: Message[]): Message[] {
  const durableIds = new Set(durable.map((message) => message.id));
  return [...durable, ...memory.filter((message) => !durableIds.has(message.id))];
}
