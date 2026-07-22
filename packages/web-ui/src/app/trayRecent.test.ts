import { describe, expect, it } from "vitest";
import type { Project, Task } from "@aurevoy/shared";
import { buildTrayRecentItems, createTrayRecentSignature } from "./trayRecent";

function task(overrides: Partial<Task> & Pick<Task, "id" | "goal" | "updatedAt">): Task {
  return {
    status: "pending",
    phase: "idle",
    plan: [],
    messages: [],
    createdAt: overrides.updatedAt,
    ...overrides,
  } as Task;
}

function project(id: string, name: string): Project {
  return {
    id,
    name,
    path: `/tmp/${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("托盘最近任务摘要", () => {
  it("只输出标题、项目副标题和最近任务顺序", () => {
    const items = buildTrayRecentItems(
      [
        task({ id: "older", goal: "旧任务", updatedAt: "2026-01-01T00:00:00.000Z" }),
        task({
          id: "newer",
          goal: "回退标题",
          title: "新任务",
          projectId: "project-1",
          updatedAt: "2026-01-02T00:00:00.000Z",
        }),
      ],
      [project("project-1", "Aurevoy")],
    );

    expect(items).toEqual([
      { id: "newer", title: "新任务", subtitle: "Aurevoy" },
      { id: "older", title: "旧任务", subtitle: null },
    ]);
  });

  it("SSE 高频字段变化不会改变托盘摘要签名", () => {
    const before = task({
      id: "task-1",
      goal: "任务",
      title: "固定标题",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const after: Task = {
      ...before,
      status: "running",
      phase: "calling_tool",
      plan: [{ id: "step-1", description: "执行", status: "running" }],
      messages: [{ id: "message-1", role: "assistant", content: "处理中", createdAt: before.updatedAt }],
    };

    const beforeItems = buildTrayRecentItems([before], []);
    const afterItems = buildTrayRecentItems([after], []);
    expect(createTrayRecentSignature(afterItems)).toBe(createTrayRecentSignature(beforeItems));
  });

  it("标题或最近任务顺序变化会改变摘要签名", () => {
    const first = task({ id: "first", goal: "第一项", updatedAt: "2026-01-02T00:00:00.000Z" });
    const second = task({ id: "second", goal: "第二项", updatedAt: "2026-01-01T00:00:00.000Z" });
    const before = buildTrayRecentItems([first, second], []);
    const after = buildTrayRecentItems(
      [{ ...first, title: "新标题" }, { ...second, updatedAt: "2026-01-03T00:00:00.000Z" }],
      [],
    );

    expect(createTrayRecentSignature(after)).not.toBe(createTrayRecentSignature(before));
  });
});
