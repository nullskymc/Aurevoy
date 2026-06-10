import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@aurevoy/shared";
import { InspectorPanel } from "./InspectorPanel";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    goal: "目标",
    status: "running",
    phase: null,
    plan: [],
    messages: [{ id: "m1", role: "user", content: "hi" }],
    budget: { maxToolCalls: 80, maxOutputBytes: 1024 * 1024 },
    budgetUsage: { iterations: 1, toolCalls: 40, wallTimeMs: 0, outputBytes: 512 * 1024 },
    createdAt: "",
    updatedAt: "",
    ...overrides,
  } as Task;
}

describe("InspectorPanel budget visualization", () => {
  function renderInspector(task: Task | null) {
    return render(
      <InspectorPanel
        open
        events={[]}
        health={null}
        phase={null}
        task={task}
        traces={[]}
        tools={[]}
        onClose={vi.fn()}
      />,
    );
  }

  it("renders a visual budget bar with the right fill ratio", () => {
    const { container } = renderInspector(makeTask());
    const budget = container.querySelector(".inspector-budget");
    expect(budget).toBeInTheDocument();
    const tracks = container.querySelectorAll(".inspector-budget-track span");
    // 工具 40/80 = 50%
    expect((tracks[0] as HTMLElement).style.width).toBe("50%");
    // 输出 512KB / 1MB = 50%
    expect((tracks[1] as HTMLElement).style.width).toBe("50%");
  });

  it("does not render the budget bar when there is no budget data", () => {
    const { container } = renderInspector(
      makeTask({ budget: undefined, budgetUsage: undefined }),
    );
    expect(container.querySelector(".inspector-budget")).not.toBeInTheDocument();
  });
});
