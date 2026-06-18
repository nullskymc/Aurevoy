import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@aurevoy/shared";
import { Conversation } from "./Conversation";

function makeTask(): Task {
  return {
    id: "t1",
    goal: "创建一个 md",
    status: "completed",
    phase: "finalizing",
    plan: [
      { id: "1", description: "step", status: "completed" },
      { id: "2", description: "step2", status: "completed" },
    ],
    messages: [
      { id: "u1", role: "user", content: "创建一个 md，里面包含一首诗", createdAt: "" },
      { id: "a1", role: "assistant", content: "好的，已经创建。", createdAt: "" },
    ],
    createdAt: "",
    updatedAt: "",
  };
}

const callbacks = {
  onToolDecision: vi.fn(),
  onClarificationAnswer: vi.fn(),
  onArtifactDecision: vi.fn(),
};

function renderConversation(extra: Record<string, unknown> = {}) {
  return render(
    <Conversation
      task={makeTask()}
      status="completed"
      phase="finalizing"
      plan={makeTask().plan}
      output=""
      reasoning=""
      busy={false}
      liveToolActivity={[]}
      {...callbacks}
      {...extra}
    />,
  );
}

describe("Conversation rendering tweaks", () => {
  it("renders the user input as a right-aligned bubble", () => {
    const { container } = renderConversation();
    const bubble = screen.getByText("创建一个 md，里面包含一首诗");
    expect(bubble).toHaveClass("user-bubble");
    expect(container.querySelector(".user-bubble-row")).toBeInTheDocument();
  });

  it("no longer renders the run-summary step progress bar", () => {
    const { container } = renderConversation();
    expect(container.querySelector(".run-summary")).not.toBeInTheDocument();
    expect(container.querySelector(".run-summary-progress")).not.toBeInTheDocument();
  });

  it("does not show the lingering 整理结果 phase label for a completed task", () => {
    renderConversation();
    expect(screen.queryByText("整理结果")).not.toBeInTheDocument();
  });

  it("edits a user message and resends it (edit equals retry)", async () => {
    const user = userEvent.setup();
    const onUserMessageEdit = vi.fn();
    renderConversation({ onUserMessageEdit });
    // 进入编辑：点击用户气泡上的修改 icon
    await user.click(screen.getByRole("button", { name: "修改" }));
    const input = screen.getByDisplayValue("创建一个 md，里面包含一首诗");
    await user.clear(input);
    await user.type(input, "改成一首词");
    await user.click(screen.getByRole("button", { name: "修改并重试" }));
    // Phase 2：确认后出现模式选择面板，需要选择恢复模式
    await user.click(screen.getByRole("button", { name: "恢复对话 + 代码" }));
    expect(onUserMessageEdit).toHaveBeenCalledWith("u1", "改成一首词", "code_and_conv");
  });

  it("no longer renders a standalone 重试 text button", () => {
    renderConversation({ onUserMessageEdit: vi.fn() });
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
  });

  it("offers an icon-only copy action on agent messages", () => {
    const { container } = renderConversation();
    const agent = container.querySelector(".doc-block-agent") as HTMLElement;
    const copyBtn = within(agent).getByRole("button", { name: "复制" });
    expect(copyBtn).toHaveClass("msg-action-btn");
  });

  it("renders resume in context when resumable", async () => {
    const user = userEvent.setup();
    const onResume = vi.fn();
    renderConversation({ onResume, canResume: true });
    await user.click(screen.getByRole("button", { name: "恢复" }));
    expect(onResume).toHaveBeenCalled();
  });

  it("hides the resume action when the task is not resumable", () => {
    renderConversation({ onResume: vi.fn(), canResume: false });
    expect(screen.queryByRole("button", { name: "恢复" })).not.toBeInTheDocument();
  });

});
