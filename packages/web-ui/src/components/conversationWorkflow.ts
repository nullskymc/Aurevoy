import type { Message } from "@aurevoy/shared";

export interface ConversationTurn {
  id: string;
  user?: Message;
  agentMessages: Message[];
}

export function collectLiveAssistantToolMessageIds(messages: Message[], hasLiveTail: boolean): Set<string> {
  const ids = new Set<string>();
  if (!hasLiveTail) return ids;
  const lastUserIndex = [...messages].reverse().findIndex((message) => message.role === "user");
  if (lastUserIndex < 0) return ids;
  const startIndex = messages.length - 1 - lastUserIndex;
  for (const message of messages.slice(startIndex + 1)) {
    if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
      ids.add(message.id);
    }
  }
  return ids;
}

export function buildConversationTurns(
  messages: Message[],
  hiddenAssistantIds: Set<string>,
  assistantToolCallIds: Set<string>,
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let current: ConversationTurn | null = null;

  function ensureTurn(): ConversationTurn {
    if (current) return current;
    current = { id: "orphan-agent", agentMessages: [] };
    turns.push(current);
    return current;
  }

  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      current = { id: message.id, user: message, agentMessages: [] };
      turns.push(current);
      continue;
    }
    if (message.role === "assistant") {
      if (hiddenAssistantIds.has(message.id)) continue;
      ensureTurn().agentMessages.push(message);
      continue;
    }
    if (message.role === "tool") {
      if (message.toolCallId && assistantToolCallIds.has(message.toolCallId)) continue;
      ensureTurn().agentMessages.push(message);
    }
  }

  return turns;
}
