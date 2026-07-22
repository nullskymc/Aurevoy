import { describe, expect, it } from "vitest";
import type { TaskSummary } from "@aurevoy/shared";
import { patchTaskSummaryList } from "./taskSummary";

const summary: TaskSummary = {
  id: "task-1",
  goal: "分析项目",
  title: "项目分析",
  status: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("patchTaskSummaryList", () => {
  it("plan/messages/phase 等实时字段变化保持原数组引用", () => {
    const previous = [summary];
    expect(patchTaskSummaryList(previous, summary.id, {
      phase: "calling_tool",
      plan: [{ id: "step-1", description: "执行", status: "running" }],
      messages: [{ id: "message-1", role: "assistant", content: "实时正文", createdAt: summary.createdAt }],
    })).toBe(previous);
  });

  it("状态和标题变化才生成新摘要", () => {
    const previous = [summary];
    const next = patchTaskSummaryList(previous, summary.id, { status: "completed", title: "完成标题" });
    expect(next).not.toBe(previous);
    expect(next[0]).toMatchObject({ status: "completed", title: "完成标题" });
  });
});
