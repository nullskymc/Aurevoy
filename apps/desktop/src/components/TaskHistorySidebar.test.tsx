import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@aurevoy/shared";
import { TaskHistorySidebar } from "./TaskHistorySidebar";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    goal: "写一篇报告",
    status: "completed",
    phase: null,
    plan: [],
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const noopProps = {
  onNewTask: vi.fn(),
  onSelectTask: vi.fn(),
  onSelectProject: vi.fn(),
  onCollapse: vi.fn(),
  onOpenSearch: vi.fn(),
  onOpenTools: vi.fn(),
  onOpenSettings: vi.fn(),
  onImportProject: vi.fn(),
  onDeleteProject: vi.fn(),
  projects: [],
  activeView: "chat" as const,
};

describe("TaskHistorySidebar context summary", () => {
  it("renders artifact and tool counts when present", () => {
    const task = makeTask({
      artifacts: [
        { id: "a", type: "file", name: "x", content: "", status: "confirmed", createdAt: "" },
      ],
      budgetUsage: { iterations: 1, toolCalls: 3, wallTimeMs: 0, outputBytes: 0 },
    });
    render(<TaskHistorySidebar tasks={[task]} {...noopProps} />);
    expect(screen.getByText(/1 产物/)).toBeInTheDocument();
    expect(screen.getByText(/3 工具/)).toBeInTheDocument();
  });

  it("omits the summary row when there are no artifacts or tool calls", () => {
    const task = makeTask({ artifacts: [], budgetUsage: undefined });
    const { container } = render(<TaskHistorySidebar tasks={[task]} {...noopProps} />);
    expect(container.querySelector(".conv-summary")).not.toBeInTheDocument();
  });

  it("shows only the artifact chip when there are artifacts but no tool calls", () => {
    const task = makeTask({
      artifacts: [
        { id: "a", type: "text", name: "y", content: "", status: "draft", createdAt: "" },
      ],
      budgetUsage: { iterations: 0, toolCalls: 0, wallTimeMs: 0, outputBytes: 0 },
    });
    render(<TaskHistorySidebar tasks={[task]} {...noopProps} />);
    expect(screen.getByText(/1 产物/)).toBeInTheDocument();
    expect(screen.queryByText(/\d+ 工具/)).not.toBeInTheDocument();
  });
});
