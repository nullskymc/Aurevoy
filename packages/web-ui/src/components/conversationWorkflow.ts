import type { Message } from "@aurevoy/shared";

export interface ConversationTurn {
  id: string;
  user?: Message;
  agentMessages: Message[];
}

export interface ConversationViewModel<TLiveActivity> {
  turns: ConversationTurn[];
  liveToolActivity: TLiveActivity[];
  liveOutput: string;
  hiddenAssistantIds: Set<string>;
}

export function buildConversationViewModel<TLiveActivity extends { id: string }>(params: {
  messages: Message[];
  liveToolActivity: TLiveActivity[];
  output: string;
  hasLiveTail: boolean;
}): ConversationViewModel<TLiveActivity> {
  const { messages, liveToolActivity, output, hasLiveTail } = params;
  const visibleLiveActivity = hasLiveTail
    ? liveToolActivity.filter((item) => !hasHistoricalToolResult(messages, item.id))
    : [];
  const hiddenAssistantIds = collectLiveAssistantToolMessageIds(
    messages,
    new Set(visibleLiveActivity.map((item) => item.id)),
  );
  const liveOutput = shouldSuppressLiveOutput(messages, hiddenAssistantIds, output) ? "" : output;
  const turns = buildConversationTurns(messages, hiddenAssistantIds, collectAssistantToolCallIds(messages));

  return {
    turns,
    liveToolActivity: visibleLiveActivity,
    liveOutput,
    hiddenAssistantIds,
  };
}

function collectLiveAssistantToolMessageIds(messages: Message[], liveToolCallIds: Set<string>): Set<string> {
  const ids = new Set<string>();
  if (liveToolCallIds.size === 0) return ids;
  const lastUserIndex = [...messages].reverse().findIndex((message) => message.role === "user");
  if (lastUserIndex < 0) return ids;
  const startIndex = messages.length - 1 - lastUserIndex;
  for (const message of messages.slice(startIndex + 1)) {
    // 只隐藏仍在实时 tail 中展示的工具调用，避免长任务 busy 期间把已落库的历史步骤整轮藏掉。
    if (message.role === "assistant" && message.toolCalls?.some((call) => liveToolCallIds.has(call.id))) {
      ids.add(message.id);
    }
  }
  return ids;
}

function shouldSuppressLiveOutput(
  messages: Message[],
  hiddenAssistantIds: Set<string>,
  output: string,
): boolean {
  const liveText = output.trim();
  if (!liveText) return false;
  const lastUserIndex = [...messages].reverse().findIndex((message) => message.role === "user");
  if (lastUserIndex < 0) return false;
  const startIndex = messages.length - 1 - lastUserIndex;
  for (const message of messages.slice(startIndex + 1)) {
    if (message.role !== "assistant" || hiddenAssistantIds.has(message.id)) continue;
    const historicalText = message.content.trim();
    if (!historicalText) continue;
    // SSE message 事件已经把同一段正文写入历史区后，live tail 不再重复渲染流式缓存。
    if (historicalText === liveText || historicalText.includes(liveText) || liveText.includes(historicalText)) {
      return true;
    }
  }
  return false;
}

function buildConversationTurns(
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

function collectAssistantToolCallIds(messages: Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const toolCall of message.toolCalls ?? []) ids.add(toolCall.id);
  }
  return ids;
}

function hasHistoricalToolResult(messages: Message[], toolCallId: string): boolean {
  return messages.some((message) => message.role === "tool" && message.toolCallId === toolCallId);
}
