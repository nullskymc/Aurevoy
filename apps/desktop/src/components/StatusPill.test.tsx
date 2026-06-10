import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusPill } from "./StatusPill";

describe("StatusPill", () => {
  it("renders an icon badge with an accessible label and data attributes", () => {
    render(<StatusPill status="running" />);
    const pill = screen.getByRole("img", { name: "执行中" });
    expect(pill).toHaveClass("status-pill");
    expect(pill).toHaveAttribute("data-status", "running");
    // 文案不再以可见汉字呈现，而是通过 aria-label/title 提供
    expect(pill).toHaveAttribute("title", "执行中");
    expect(pill.querySelector("svg")).not.toBeInTheDocument();
    expect(pill.querySelector(".status-dot")).toBeInTheDocument();
  });

  it("falls back to idle when status is null", () => {
    render(<StatusPill status={null} />);
    const pill = screen.getByRole("img", { name: "未开始" });
    expect(pill).toHaveAttribute("data-status", "idle");
  });

  it("shows a check icon and 已完成 label for a completed task even with a lingering phase", () => {
    render(<StatusPill status="completed" phase="finalizing" />);
    const pill = screen.getByRole("img", { name: "已完成" });
    // 绿色对勾：渲染 svg，而不是汉字"整理结果"
    expect(pill.querySelector("svg")).toBeInTheDocument();
    expect(pill).not.toHaveTextContent("整理结果");
  });

  it("still uses the phase label while the task is active", () => {
    render(<StatusPill status="running" phase="finalizing" />);
    expect(screen.getByRole("img", { name: "整理结果" })).toBeInTheDocument();
  });
});
