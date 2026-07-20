import { describe, expect, it } from "vitest";
import { planModeToolBlockReason } from "./pi-harness.js";

type PlanToolCall = Parameters<typeof planModeToolBlockReason>[0];

function toolCall(toolName: string): PlanToolCall {
  return { toolName, args: {} } as PlanToolCall;
}

describe("Plan mode tool gate", () => {
  it("将 bash 转入用户审批，而不是直接拒绝", () => {
    expect(planModeToolBlockReason(toolCall("bash"))).toBeUndefined();
  });

  it("继续拒绝写入类工具", () => {
    expect(planModeToolBlockReason(toolCall("write"))).toContain("切换到 Agent 模式");
  });
});
