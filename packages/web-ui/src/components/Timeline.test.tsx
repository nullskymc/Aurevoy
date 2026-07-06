import { describe, expect, it } from "vitest";
import type { Message } from "@aurevoy/shared";
import { buildAgentRoundFromMessage, buildLiveAgentRoundData } from "./Timeline";

describe("buildLiveAgentRoundData", () => {
  it("keeps live tools visible when their planStepId is missing from the current plan", () => {
    const round = buildLiveAgentRoundData({
      plan: [],
      phase: "tool_running",
      liveToolActivity: [
        {
          id: "live-search-unmatched-plan-step",
          name: "web_search",
          args: { query: "live unmatched plan step" },
          status: "running",
          planStepId: "missing-plan-step",
        },
      ],
    });
    const steps = round.planStepGroups.flatMap((group) => group.steps);

    expect(round.summary).toBe("执行了 1 个搜索");
    expect(round.planStepGroups).toHaveLength(1);
    expect(round.planStepGroups[0]?.planStepId).toBe("missing-plan-step");
    expect(steps.map((step) => step.id)).toEqual(["live-search-unmatched-plan-step"]);
  });

  it("maps SSE phase detail and tool progress into the live timeline", () => {
    const round = buildLiveAgentRoundData({
      plan: [{ id: "exec", description: "执行任务", status: "running" }],
      phase: "calling_tool",
      phaseDetail: "调用工具 web_search",
      liveToolActivity: [
        {
          id: "call-search",
          name: "web_search",
          args: { query: "sse timeline" },
          status: "running",
          planStepId: "exec",
          progress: { message: "正在搜索", percent: 45 },
        },
      ],
    });
    const step = round.planStepGroups[0]?.steps[0];

    expect(round.summary).toBe("执行了 1 个搜索");
    expect(round.phaseDetail).toBe("调用工具 web_search");
    expect(round.planStepGroups[0]?.planStepId).toBe("exec");
    expect(step?.status).toBe("running");
    expect(step?.progress).toEqual({ message: "正在搜索", percent: 45 });
  });
});

describe("buildAgentRoundFromMessage", () => {
  it("keeps historical tools visible when their planStepId is missing from the current plan", () => {
    const message: Message = {
      id: "assistant-with-unmatched-plan-step",
      role: "assistant",
      content: "",
      createdAt: "2026-07-05T00:00:00.000Z",
      toolCalls: [
        {
          id: "history-search-unmatched-plan-step",
          type: "function",
          function: {
            name: "web_search",
            arguments: JSON.stringify({ query: "historical unmatched plan step" }),
            planStepId: "missing-plan-step",
          },
        },
      ],
    };
    const resultMap = new Map([
      ["history-search-unmatched-plan-step", { ok: true, output: { results: [] } }],
    ]);

    const round = buildAgentRoundFromMessage(message, resultMap, []);
    const steps = round.planStepGroups.flatMap((group) => group.steps);

    expect(round.summary).toBe("执行了 1 个搜索");
    expect(round.planStepGroups).toHaveLength(1);
    expect(round.planStepGroups[0]?.planStepId).toBe("missing-plan-step");
    expect(steps.map((step) => step.id)).toEqual(["history-search-unmatched-plan-step"]);
  });
});
