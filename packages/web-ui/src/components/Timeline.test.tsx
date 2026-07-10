import { describe, expect, it, vi } from "vitest";
import type { Message, SubagentRun } from "@aurevoy/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentRound, buildAgentRoundFromMessage, buildLiveAgentRoundData } from "./Timeline";

vi.mock("dompurify", () => ({
  default: {
    sanitize: (value: string) => value,
  },
}));

describe("buildLiveAgentRoundData", () => {
  it("projects parallel delegate calls into a dedicated subagent workgroup", () => {
    const runs: SubagentRun[] = [
      makeSubagentRun({ id: "run-explore", parentCallId: "call-explore", role: "explore" }),
      makeSubagentRun({ id: "run-research", parentCallId: "call-research", role: "research" }),
    ];
    const round = buildLiveAgentRoundData({
      plan: [],
      phase: "calling_tool",
      liveToolActivity: [
        { id: "call-explore", name: "delegate", args: { goal: "检查代码", role: "explore" }, status: "running" },
        { id: "call-research", name: "delegate", args: { goal: "调研方案", role: "research" }, status: "running" },
      ],
      subagentRuns: runs,
    });

    expect(round.subagentRuns?.map((run) => run.id)).toEqual(["run-explore", "run-research"]);
    expect(round.planStepGroups).toEqual([]);
    expect(round.status).toBe("running");
  });

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
  it("associates persisted subagent runs with the assistant message that delegated them", () => {
    const message: Message = {
      id: "assistant-delegate",
      role: "assistant",
      content: "",
      createdAt: "2026-07-10T00:00:00.000Z",
      toolCalls: [{
        id: "delegate-call",
        type: "function",
        function: { name: "delegate", arguments: JSON.stringify({ goal: "检查实现", role: "coder" }) },
      }],
    };
    const persisted = [makeSubagentRun({
      id: "persisted-run",
      parentCallId: "delegate-call",
      role: "coder",
      status: "completed",
    })];

    const round = buildAgentRoundFromMessage(message, new Map(), [], persisted);
    expect(round.subagentRuns?.map((run) => run.id)).toEqual(["persisted-run"]);
    expect(round.planStepGroups).toEqual([]);
  });

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

  it("keeps per-step success/fail independent when one tool fails", () => {
    const message: Message = {
      id: "assistant-mixed-tools",
      role: "assistant",
      content: "",
      createdAt: "2026-07-05T00:00:00.000Z",
      toolCalls: [
        {
          id: "call-ok",
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: "ok.md" }) },
        },
        {
          id: "call-fail",
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: "missing.md" }) },
        },
      ],
    };
    const resultMap = new Map([
      ["call-ok", { ok: true, output: "file contents" }],
      ["call-fail", { ok: false, error: "file not found" }],
    ]);

    const round = buildAgentRoundFromMessage(message, resultMap, []);
    const steps = round.planStepGroups.flatMap((group) => group.steps);

    expect(round.status).toBe("failed");
    expect(steps.find((step) => step.id === "call-ok")?.status).toBe("success");
    expect(steps.find((step) => step.id === "call-fail")?.status).toBe("failed");
  });
});

describe("AgentRound", () => {
  it("renders user-facing subagent identity, progress, metrics and tool activity", () => {
    const run = makeSubagentRun({
      id: "visible-run",
      parentCallId: "visible-call",
      role: "coder",
      status: "running",
      currentActivity: "正在调用 edit",
      activities: [{
        id: "activity-edit",
        toolName: "edit",
        status: "running",
        startedAt: "2026-07-10T00:00:00.000Z",
      }],
    });
    const html = renderToStaticMarkup(
      <AgentRound
        busy
        data={{
          id: "subagent-round",
          planStepGroups: [],
          summary: "",
          subagentRuns: [run],
          status: "running",
        }}
      />,
    );

    expect(html).toContain("协作工作组");
    expect(html).toContain("编码");
    expect(html).toContain("检查实现");
    expect(html).toContain("正在调用 edit");
    expect(html).toContain("edit");
    expect(html).toContain("执行中");
    expect(html).not.toContain("timeline-empty");
  });

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

  it("renders failed and successful tool steps with independent data-status", () => {
    const html = renderToStaticMarkup(
      <AgentRound
        data={{
          id: "mixed-status-round",
          planStepGroups: [{
            planStepId: "_default",
            description: "执行任务",
            status: "failed",
            steps: [
              {
                id: "step-ok",
                kind: "file_read",
                title: "ok.md",
                status: "success",
                toolName: "read",
              },
              {
                id: "step-fail",
                kind: "file_read",
                title: "missing.md",
                status: "failed",
                toolName: "read",
                error: "file not found",
              },
            ],
          }],
          summary: "执行了 2 个工具",
          status: "failed",
        }}
      />,
    );

    // Round-level failed is expected for summary/badge, but each step keeps its own status.
    expect(html).toContain('data-status="failed"');
    expect(html).toContain('class="timeline-step" data-status="success"');
    expect(html).toContain('class="timeline-step" data-status="failed"');
  });
});

function makeSubagentRun(overrides: Partial<SubagentRun>): SubagentRun {
  return {
    id: "run-default",
    parentCallId: "call-default",
    role: "general",
    goal: "检查实现",
    status: "running",
    currentActivity: "正在工作",
    activities: [],
    iterations: 2,
    toolCallCount: 1,
    maxIterations: 12,
    createdAt: "2026-07-10T00:00:00.000Z",
    startedAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}
