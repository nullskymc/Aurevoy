import { describe, expect, it } from "vitest";
import type { Message, PendingToolApproval } from "@aurevoy/shared";
import {
  buildDeliveryMessages,
  buildToolResultMap,
  collectApprovalItems,
  currentTurnMessages,
  currentTurnSubagentRuns,
  findFinalAssistantMessage,
  getFailureInfo,
  isProcessToolNarration,
  parseToolResultContent,
  resolveProcessStartMs,
  standaloneToolActivityFromMessage,
} from "./conversationData";

const createdAt = "2026-07-05T00:00:00.000Z";

function message(id: string, role: Message["role"], content = ""): Message {
  return { id, role, content, createdAt };
}

function assistantTool(id: string, callId: string, name = "read", content = ""): Message {
  return {
    ...message(id, "assistant", content),
    toolCalls: [{ id: callId, type: "function", function: { name, arguments: "{}" } }],
  };
}

describe("conversationData", () => {
  it("parses structured errors without treating plain text as a failure", () => {
    expect(parseToolResultContent("plain output")).toEqual({ ok: true, output: "plain output" });
    expect(parseToolResultContent(JSON.stringify({ error: "denied", errorCode: "approval_denied" }))).toEqual({
      ok: false,
      error: "denied",
      errorCode: "approval_denied",
    });
  });

  it("keeps result mapping and standalone tool rendering deterministic", () => {
    const result = message("tool-1", "tool", JSON.stringify({ ok: true, value: 3 }));
    result.toolCallId = "call-1";
    const map = buildToolResultMap([result]);
    expect(map.get("call-1")).toEqual({ ok: true, output: { ok: true, value: 3 } });
    expect(standaloneToolActivityFromMessage(result)).toMatchObject({
      id: "call-1",
      name: "tool_result:call-1",
      status: "ok",
    });
  });

  it("limits live subagents to delegate calls in the current user turn", () => {
    const old = message("old-user", "user");
    const current = message("current-user", "user");
    const delegate = assistantTool("assistant-delegate", "delegate-current", "delegate");
    const runs = [
      { id: "old-run", parentCallId: "delegate-old" },
      { id: "current-run", parentCallId: "delegate-current" },
    ] as Parameters<typeof currentTurnSubagentRuns>[1];

    expect(currentTurnMessages([
      old,
      assistantTool("old-delegate", "delegate-old", "delegate"),
      current,
      delegate,
    ]).map((item) => item.id)).toEqual(["current-user", "assistant-delegate"]);
    expect(currentTurnSubagentRuns([current, delegate], runs).map((run) => run.id)).toEqual(["current-run"]);
  });

  it("separates process narration from the final delivery message", () => {
    const process = assistantTool("process", "call-read", "read", "我先检查工作区");
    const final = message("final", "assistant", "结果已整理完成");
    expect(isProcessToolNarration(process)).toBe(true);
    expect(findFinalAssistantMessage([process, final])).toBe(final);
    expect(buildDeliveryMessages([process, final], final)).toEqual([final]);
    expect(getFailureInfo(message("failure", "assistant", "任务失败，原因：超时\n\n错误分类：timeout")))
      .toEqual({ message: "超时", category: "timeout" });
  });

  it("merges pending approvals with live awaiting activities by call id", () => {
    const pending = {
      call: { id: "call-approve", toolName: "execute_command", args: { command: "pwd" }, summary: "查看目录" },
      riskLevel: "caution",
      createdAt,
    } as PendingToolApproval;
    const items = collectApprovalItems([
      { id: "call-approve", name: "execute_command", args: {}, status: "awaiting" },
    ], [pending]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "call-approve", args: {}, status: "awaiting" });
  });

  it("uses a safe current-time fallback for stale process timestamps", () => {
    const now = Date.parse("2026-07-05T12:00:00.000Z");
    expect(resolveProcessStartMs("2026-07-05T11:59:00.000Z", now)).toBe(now - 60_000);
    expect(resolveProcessStartMs("2026-07-04T00:00:00.000Z", now)).toBe(now);
  });
});
