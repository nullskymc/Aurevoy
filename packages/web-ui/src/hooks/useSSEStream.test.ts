import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@aurevoy/shared";
import { enqueueFrameEvent } from "./useSSEStream";

describe("enqueueFrameEvent", () => {
  it("合并同一帧内相邻 token，同时保持字符顺序", () => {
    const queue: AgentEvent[] = [];
    enqueueFrameEvent(queue, { type: "token", taskId: "task-1", delta: "你" });
    enqueueFrameEvent(queue, { type: "token", taskId: "task-1", delta: "好" });

    expect(queue).toEqual([{ type: "token", taskId: "task-1", delta: "你好" }]);
  });

  it("事件屏障两侧的 token 不跨越合并", () => {
    const queue: AgentEvent[] = [];
    enqueueFrameEvent(queue, { type: "token", taskId: "task-1", delta: "前" });
    enqueueFrameEvent(queue, { type: "phase", taskId: "task-1", phase: "thinking" });
    enqueueFrameEvent(queue, { type: "token", taskId: "task-1", delta: "后" });

    expect(queue.map((event) => event.type)).toEqual(["token", "phase", "token"]);
  });

  it("相邻工具进度只保留最新快照", () => {
    const queue: AgentEvent[] = [];
    enqueueFrameEvent(queue, {
      type: "tool_progress",
      taskId: "task-1",
      callId: "call-1",
      message: "10%",
      percent: 10,
    });
    enqueueFrameEvent(queue, {
      type: "tool_progress",
      taskId: "task-1",
      callId: "call-1",
      message: "80%",
      percent: 80,
    });

    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ type: "tool_progress", message: "80%", percent: 80 });
  });
});
