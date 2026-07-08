import { describe, expect, it, vi } from "vitest";
import type { Message } from "@aurevoy/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentRound, buildAgentRoundFromMessage, buildLiveAgentRoundData } from "./Timeline";

vi.mock("dompurify", () => ({
  default: {
    sanitize: (value: string) => value,
  },
}));

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
    expect(round.planStepGroups[0]?.planStepId).toBe("exec");
    expect(step?.status).toBe("running");
    expect(step?.progress).toEqual({ message: "正在搜索", percent: 45 });
  });

  it("does not render empty plan groups when named and unnamed live tools are mixed", () => {
    const round = buildLiveAgentRoundData({
      plan: [
        { id: "discover", description: "搜集材料", status: "running" },
        { id: "synthesize", description: "整理结构", status: "pending" },
        { id: "deliver", description: "交付结果", status: "pending" },
      ],
      phase: "calling_tool",
      liveToolActivity: [
        {
          id: "call-read",
          name: "read",
          args: { path: "notes.md" },
          status: "running",
          planStepId: "discover",
        },
        {
          id: "call-search",
          name: "web_search",
          args: { query: "timeline regression" },
          status: "running",
        },
      ],
    });

    expect(round.planStepGroups.map((group) => group.planStepId)).toEqual(["discover", "_live"]);
    expect(round.planStepGroups.map((group) => group.steps.map((step) => step.id))).toEqual([
      ["call-read"],
      ["call-search"],
    ]);
  });

  it("does not create placeholder plan groups before any live tool exists", () => {
    const round = buildLiveAgentRoundData({
      plan: [
        { id: "discover", description: "搜集材料", status: "running" },
        { id: "synthesize", description: "整理结构", status: "pending" },
      ],
      phase: "thinking",
      liveToolActivity: [],
    });

    expect(round.planStepGroups).toEqual([]);
    expect(round.summary).toBe("");
    expect(round.status).toBe("running");
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

describe("AgentRound", () => {
  it("renders the live empty-state phase label once before streaming output", () => {
    const html = renderToStaticMarkup(
      <AgentRound
        busy
        phaseDetail="Agent 正在思考"
        data={{
          id: "live-tail",
          planStepGroups: [],
          summary: "",
          markdownOutput: "streaming answer",
          status: "running",
        }}
      />,
    );

    expect(html.match(/Agent 正在思考/g)).toHaveLength(1);
    expect(html).toContain("timeline-empty");
    expect(html).not.toContain("timeline-phase-bar");
    expect(html.indexOf("timeline-empty")).toBeLessThan(html.indexOf("timeline-output"));
    expect(html).not.toContain("思考中…");
  });
});
