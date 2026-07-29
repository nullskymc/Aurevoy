import { describe, expect, it } from "vitest";
import type { PiSessionTreeNode } from "@aurevoy/shared";
import { buildSessionTreeRows, isSessionTreeNodeNavigable } from "./SessionTreeDialog";

function node(
  id: string,
  parentId: string | null,
  overrides: Partial<PiSessionTreeNode> = {},
): PiSessionTreeNode {
  return {
    id,
    parentId,
    type: "message",
    role: "user",
    timestamp: "2026-07-29T00:00:00.000Z",
    preview: id,
    navigable: (overrides.role ?? "user") === "user",
    ...overrides,
  };
}

describe("会话树布局", () => {
  it("线性路径保持同一泳道，只有第二个子分支才新增泳道", () => {
    const rows = buildSessionTreeRows([
      node("root", null),
      node("a", "root", { role: "assistant" }),
      node("a1", "a"),
      node("b", "root", { role: "assistant" }),
      node("b1", "b"),
    ]);

    expect(rows.map(({ node: rowNode, lane }) => [rowNode.id, lane])).toEqual([
      ["root", 0],
      ["a", 0],
      ["a1", 0],
      ["b", 1],
      ["b1", 1],
    ]);
  });

  it("跨过隐藏的工具节点连接最近的可见父节点", () => {
    const rows = buildSessionTreeRows([
      node("root", null),
      node("tool", "root", { type: "message", role: "tool" }),
      node("answer", "tool", { role: "assistant" }),
    ]);

    expect(rows.map((row) => [row.node.id, row.visibleParentId])).toEqual([
      ["root", null],
      ["answer", "root"],
    ]);
  });

  it("只允许用户消息作为切换目标，并隐藏无正文的 assistant 工具调用节点", () => {
    const user = node("user", null, { navigable: true });
    const finalAssistant = node("final", "user", { role: "assistant", preview: "完成" });
    const toolCallAssistant = node("tool-call", "user", { role: "assistant", preview: undefined });

    expect(isSessionTreeNodeNavigable(user)).toBe(true);
    expect(isSessionTreeNodeNavigable(finalAssistant)).toBe(false);
    expect(buildSessionTreeRows([user, toolCallAssistant, finalAssistant]).map((row) => row.node.id))
      .toEqual(["user", "final"]);
  });
});
