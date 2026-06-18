import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ToolActivityList, type ToolActivity } from "./Conversation";

function makeTool(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: "call-1",
    name: "read_file",
    args: { path: "a.txt" },
    status: "ok",
    ...overrides,
  };
}

describe("ToolActivityList", () => {
  it("renders finished tools as a compact chip", () => {
    render(<ToolActivityList items={[makeTool({ status: "ok" })]} onDecision={vi.fn()} />);
    const chip = screen.getByRole("button", { name: /查看.*read_file.*详情/ });
    expect(chip).toHaveClass("tool-chip");
    expect(chip).toHaveAttribute("data-status", "ok");
    // 紧凑态默认不展示参数 body
    expect(screen.queryByText("参数")).not.toBeInTheDocument();
  });

  it("renders failed tools as a chip too", () => {
    render(
      <ToolActivityList
        items={[makeTool({ status: "error", error: "boom" })]}
        onDecision={vi.fn()}
      />,
    );
    expect(screen.getByText("read_file").closest("button")).toHaveClass("tool-chip");
  });

  it("renders running tools as a compact chip by default", () => {
    const { container } = render(
      <ToolActivityList items={[makeTool({ status: "running" })]} onDecision={vi.fn()} />,
    );
    expect(container.querySelector(".tool-chip")).toBeInTheDocument();
    expect(container.querySelector(".tool-card")).not.toBeInTheDocument();
  });

  it("renders tool details open when the preference is enabled", () => {
    const { container } = render(
      <ToolActivityList
        items={[makeTool({ status: "running", output: { ok: true } })]}
        defaultDetailsOpen
        onDecision={vi.fn()}
      />,
    );
    expect(container.querySelector(".tool-card")).toBeInTheDocument();
    expect(screen.getByText("参数")).toBeInTheDocument();
  });

  it("keeps awaiting tools as a full card with approval actions", () => {
    const { container } = render(
      <ToolActivityList
        items={[makeTool({ status: "awaiting", riskLevel: "dangerous" })]}
        onDecision={vi.fn()}
      />,
    );
    expect(container.querySelector(".tool-card")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "批准" })).toBeInTheDocument();
  });

  it("expands a chip into the full card on click, then collapses back", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ToolActivityList
        items={[makeTool({ status: "ok", output: { result: 42 } })]}
        onDecision={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /查看.*详情/ }));
    // 展开后是完整卡片并默认展示 body（结果）
    expect(container.querySelector(".tool-card")).toBeInTheDocument();
    expect(screen.getByText("结果")).toBeInTheDocument();
    // 再次点击头部收起回到 chip
    await user.click(container.querySelector(".tool-card-head") as HTMLElement);
    expect(container.querySelector(".tool-chip")).toBeInTheDocument();
    expect(container.querySelector(".tool-card")).not.toBeInTheDocument();
  });

  it("shows a risk marker on a finished risky tool chip", () => {
    render(
      <ToolActivityList
        items={[makeTool({ status: "ok", riskLevel: "caution" })]}
        onDecision={vi.fn()}
      />,
    );
    expect(screen.getByText("需确认")).toHaveClass("tool-chip-risk");
  });
});
