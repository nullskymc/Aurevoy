import { describe, expect, it } from "vitest";
import type { Message } from "@aurevoy/shared";
import { buildConversationViewModel } from "./conversationWorkflow";

const createdAt = "2026-07-05T00:00:00.000Z";

function userMessage(id: string): Message {
  return { id, role: "user", content: "run", createdAt };
}

function assistantToolMessage(id: string, callId: string): Message {
  return {
    id,
    role: "assistant",
    content: "",
    createdAt,
    toolCalls: [
      {
        id: callId,
        type: "function",
        function: { name: "read", arguments: "{}" },
      },
    ],
  };
}

function toolResultMessage(id: string, callId: string): Message {
  return {
    id,
    role: "tool",
    content: "ok",
    createdAt,
    toolCallId: callId,
  };
}

describe("conversationWorkflow", () => {
  it("only hides assistant tool messages that are still represented by the live tail", () => {
    const messages = [
      userMessage("user-1"),
      assistantToolMessage("assistant-completed", "call-completed"),
      toolResultMessage("tool-completed", "call-completed"),
      assistantToolMessage("assistant-running", "call-running"),
    ];
    const view = buildConversationViewModel({
      messages,
      liveToolActivity: [{ id: "call-running" }],
      output: "",
      hasLiveTail: true,
    });

    expect(view.hiddenAssistantIds.has("assistant-completed")).toBe(false);
    expect(view.hiddenAssistantIds.has("assistant-running")).toBe(true);
  });

  it("keeps completed historical tool calls visible while a later call is live", () => {
    const messages = [
      userMessage("user-1"),
      assistantToolMessage("assistant-completed", "call-completed"),
      toolResultMessage("tool-completed", "call-completed"),
      assistantToolMessage("assistant-running", "call-running"),
    ];
    const view = buildConversationViewModel({
      messages,
      liveToolActivity: [{ id: "call-running" }],
      output: "",
      hasLiveTail: true,
    });

    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]?.agentMessages.map((message) => message.id)).toEqual(["assistant-completed"]);
  });

  it("suppresses live output once the same assistant text is visible in history", () => {
    const messages = [
      userMessage("user-1"),
      {
        ...assistantToolMessage("assistant-completed", "call-completed"),
        content: "好的，我来全权决定！",
      },
      toolResultMessage("tool-completed", "call-completed"),
    ];
    const view = buildConversationViewModel({
      messages,
      liveToolActivity: [],
      output: "好的，我来全权决定！",
      hasLiveTail: true,
    });

    expect(view.liveOutput).toBe("");
  });

  it("keeps live output when the matching assistant message is hidden by active tools", () => {
    const messages = [
      userMessage("user-1"),
      {
        ...assistantToolMessage("assistant-running", "call-running"),
        content: "好的，我来全权决定！",
      },
    ];
    const view = buildConversationViewModel({
      messages,
      liveToolActivity: [{ id: "call-running" }],
      output: "好的，我来全权决定！",
      hasLiveTail: true,
    });

    expect(view.liveOutput).toBe("好的，我来全权决定！");
  });

  it("keeps completed live tools visible until the matching tool result message is in history", () => {
    const live = [{ id: "call-completed", status: "ok" }];
    const messagesWithoutToolResult = [
      userMessage("user-1"),
      assistantToolMessage("assistant-completed", "call-completed"),
    ];
    const visibleBeforeResult = buildConversationViewModel({
      messages: messagesWithoutToolResult,
      liveToolActivity: live,
      output: "",
      hasLiveTail: true,
    });

    expect(visibleBeforeResult.liveToolActivity).toEqual(live);
    expect(visibleBeforeResult.hiddenAssistantIds.has("assistant-completed")).toBe(true);

    const messagesWithToolResult = [
      ...messagesWithoutToolResult,
      toolResultMessage("tool-completed", "call-completed"),
    ];
    const visibleAfterResult = buildConversationViewModel({
      messages: messagesWithToolResult,
      liveToolActivity: live,
      output: "",
      hasLiveTail: true,
    });

    expect(visibleAfterResult.liveToolActivity).toEqual([]);
    expect(visibleAfterResult.hiddenAssistantIds.has("assistant-completed")).toBe(false);
  });
});
