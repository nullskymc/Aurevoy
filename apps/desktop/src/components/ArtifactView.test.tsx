import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TaskArtifact } from "@aurevoy/shared";
import { ArtifactView } from "./ArtifactView";

function makeArtifact(overrides: Partial<TaskArtifact> = {}): TaskArtifact {
  return {
    id: "art-1",
    type: "file",
    name: "report.md",
    content: "# Report\n\nbody",
    status: "confirmed",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("ArtifactView", () => {
  it("shows an empty state when there are no artifacts", () => {
    render(<ArtifactView artifacts={[]} onDecision={vi.fn()} />);
    expect(screen.getByText("暂无产物")).toBeInTheDocument();
  });

  it("renders the artifact list and selects the first by default", () => {
    render(
      <ArtifactView
        artifacts={[
          makeArtifact({ id: "a", name: "first.md" }),
          makeArtifact({ id: "b", name: "second.md" }),
        ]}
        onDecision={vi.fn()}
      />,
    );
    // 导航项均渲染
    expect(screen.getByRole("button", { name: /first\.md/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /second\.md/ })).toBeInTheDocument();
    // 默认选中第一个，文档标题为 first.md
    expect(screen.getByRole("heading", { name: "first.md" })).toBeInTheDocument();
  });

  it("switches the document when another artifact is clicked", async () => {
    const user = userEvent.setup();
    render(
      <ArtifactView
        artifacts={[
          makeArtifact({ id: "a", name: "first.md" }),
          makeArtifact({ id: "b", name: "second.md" }),
        ]}
        onDecision={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /second\.md/ }));
    expect(screen.getByRole("heading", { name: "second.md" })).toBeInTheDocument();
  });

  it("shows confirm/reject actions only for draft artifacts and fires the callback", async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn();
    render(
      <ArtifactView
        artifacts={[makeArtifact({ id: "d", name: "draft.md", status: "draft" })]}
        onDecision={onDecision}
      />,
    );
    await user.click(screen.getByRole("button", { name: "确认" }));
    expect(onDecision).toHaveBeenCalledWith("d", "confirmed");
    await user.click(screen.getByRole("button", { name: "拒绝" }));
    expect(onDecision).toHaveBeenCalledWith("d", "rejected");
  });

  it("does not render decision actions for non-draft artifacts", () => {
    render(
      <ArtifactView
        artifacts={[makeArtifact({ status: "confirmed" })]}
        onDecision={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "确认" })).not.toBeInTheDocument();
  });
});
