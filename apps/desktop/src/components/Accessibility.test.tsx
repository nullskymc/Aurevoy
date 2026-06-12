import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@aurevoy/shared";
import { Composer } from "./Composer";
import { TaskHistorySidebar } from "./TaskHistorySidebar";

const composerProps = {
  onChange: vi.fn(),
  onSubmit: vi.fn(),
  onOpenModelSelector: vi.fn(),
  onStop: vi.fn(),
};

describe("Composer send button accessibility", () => {
  it("explains why sending is blocked when empty", () => {
    render(<Composer value="" busy={false} online={true} provider="openai" {...composerProps} />);
    expect(screen.getByRole("button", { name: "发送" })).toHaveAttribute("title", "输入内容后可发送");
  });

  it("explains the offline engine reason", () => {
    render(
      <Composer value="hello" busy={false} online={false} provider="openai" {...composerProps} />,
    );
    expect(screen.getByRole("button", { name: "发送" })).toHaveAttribute(
      "title",
      "引擎离线，无法发送",
    );
  });

  it("explains the unconfigured provider reason", () => {
    render(
      <Composer value="hello" busy={false} online={true} provider="unconfigured" {...composerProps} />,
    );
    expect(screen.getByRole("button", { name: "发送" })).toHaveAttribute(
      "title",
      "请先配置 LLM 模型",
    );
  });

  it("is ready to send when all conditions are met", () => {
    render(
      <Composer value="hello" busy={false} online={true} provider="openai" {...composerProps} />,
    );
    expect(screen.getByRole("button", { name: "发送" })).toHaveAttribute("title", "发送 (Enter)");
  });
});

function makeTask(id: string, goal: string): Task {
  return {
    id,
    goal,
    status: "completed",
    phase: null,
    plan: [],
    messages: [],
    createdAt: "",
    updatedAt: "",
  };
}

const sidebarProps = {
  onNewTask: vi.fn(),
  onSelectTask: vi.fn(),
  onSelectProject: vi.fn(),
  onCollapse: vi.fn(),
  onOpenSearch: vi.fn(),
  onOpenTools: vi.fn(),
  onOpenSettings: vi.fn(),
  activeView: "chat" as const,
  projects: [],
  onImportProject: vi.fn(),
  onDeleteProject: vi.fn(),
};

describe("TaskHistorySidebar keyboard navigation", () => {
  it("exposes a listbox with option roles", () => {
    render(
      <TaskHistorySidebar
        tasks={[makeTask("a", "task a"), makeTask("b", "task b")]}
        {...sidebarProps}
      />,
    );
    const listbox = screen.getByRole("listbox", { name: "对话列表" });
    expect(listbox).toBeInTheDocument();
    expect(within(listbox).getAllByRole("option")).toHaveLength(2);
  });

  it("moves focus between items with ArrowDown / ArrowUp", async () => {
    const user = userEvent.setup();
    render(
      <TaskHistorySidebar
        tasks={[makeTask("a", "task a"), makeTask("b", "task b")]}
        {...sidebarProps}
      />,
    );
    const items = screen.getAllByText(/task [ab]/).map((el) => el.closest("button")!);
    items[0].focus();
    expect(items[0]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(items[1]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(items[0]).toHaveFocus();
  });
});
