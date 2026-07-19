import { describe, expect, it } from "vitest";
import type { PlanStep } from "@aurevoy/shared";
import { setLocale } from "../i18n";
import {
  getPlanStepStatusLabel,
  mapPlanStepGroupStatus,
  mapPlanStepToUiStatus,
  planBlockedReason,
  shouldShowPlanProgress,
} from "./planStatus";
import { buildAgentRoundFromMessage } from "./Timeline";

describe("planStatus mapping", () => {
  it("maps blocked/paused to blocked UI status (not completed)", () => {
    expect(mapPlanStepToUiStatus("blocked")).toBe("blocked");
    expect(mapPlanStepToUiStatus("paused")).toBe("blocked");
    expect(mapPlanStepToUiStatus("running")).toBe("running");
    expect(mapPlanStepToUiStatus("pending")).toBe("pending");
    expect(mapPlanStepToUiStatus("completed")).toBe("completed");
    expect(mapPlanStepToUiStatus("failed")).toBe("failed");
    expect(mapPlanStepToUiStatus("cancelled")).toBe("pending");
  });

  it("mapPlanStepGroupStatus escalates tool failure", () => {
    expect(mapPlanStepGroupStatus("running", true)).toBe("failed");
    expect(mapPlanStepGroupStatus("blocked", false)).toBe("blocked");
    expect(mapPlanStepGroupStatus("completed", true)).toBe("completed");
    expect(mapPlanStepGroupStatus("pending", false, true)).toBe("failed");
  });

  it("shouldShowPlanProgress only for multi-step plans", () => {
    expect(shouldShowPlanProgress([{ id: "exec", description: "x", status: "running" }])).toBe(false);
    expect(
      shouldShowPlanProgress([
        { id: "discover", description: "a", status: "completed" },
        { id: "synthesize", description: "b", status: "blocked", blockedReason: "dependency offline" },
      ]),
    ).toBe(true);
  });

  it("planBlockedReason only for blocked/paused with text", () => {
    expect(
      planBlockedReason({ id: "s", description: "d", status: "blocked", blockedReason: "  offline  " }),
    ).toBe("offline");
    expect(planBlockedReason({ id: "s", description: "d", status: "running", blockedReason: "x" })).toBeUndefined();
  });

  it("labels use i18n keys", () => {
    setLocale("zh");
    expect(getPlanStepStatusLabel("blocked")).toBe("阻塞");
    setLocale("en");
    expect(getPlanStepStatusLabel("blocked")).toBe("Blocked");
  });
});

describe("buildAgentRoundFromMessage plan status", () => {
  it("keeps blocked plan steps as blocked (not completed)", () => {
    const plan: PlanStep[] = [
      { id: "discover", description: "定位", status: "completed" },
      { id: "synthesize", description: "写配置", status: "blocked", blockedReason: "Connection closed" },
      { id: "deliver", description: "验证", status: "pending" },
    ];
    const message = {
      id: "a1",
      role: "assistant" as const,
      content: "",
      createdAt: "2026-07-19T00:00:00.000Z",
      toolCalls: [
        {
          id: "c1",
          type: "function" as const,
          function: {
            name: "bash",
            arguments: "{}",
            planStepId: "synthesize",
          },
        },
      ],
    };
    const resultMap = new Map([["c1", { ok: true, output: { exit: 0 } }]]);
    const round = buildAgentRoundFromMessage(message, resultMap, plan);
    const group = round.planStepGroups.find((g) => g.planStepId === "synthesize");
    expect(group?.status).toBe("blocked");
    expect(group?.blockedReason).toBe("Connection closed");
  });
});
