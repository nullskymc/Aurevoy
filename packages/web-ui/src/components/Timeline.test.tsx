import { describe, expect, it, vi } from "vitest";
import type { Message, SubagentRun } from "@aurevoy/shared";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AgentRound,
  buildAgentRoundFromMessage,
  buildLiveAgentRoundData,
  flattenProcessActivityRows,
  formatProcessedSummaryLabel,
  mergeAgentRoundData,
  resolveLiveStatusText,
} from "./Timeline";

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

describe("process presentation helpers", () => {
  it("resolveLiveStatusText prefers phaseDetail and strips Agent prefix", () => {
    expect(
      resolveLiveStatusText({
        phaseDetail: "Agent 正在思考",
        data: {
          id: "r",
          planStepGroups: [],
          summary: "执行了 1 个搜索",
          status: "running",
        },
      }),
    ).toBe("正在思考");
  });

  it("resolveLiveStatusText falls back to behavioral activity summary", () => {
    expect(
      resolveLiveStatusText({
        data: {
          id: "r",
          planStepGroups: [{
            planStepId: "_live",
            description: "执行",
            status: "running",
            steps: [{
              id: "s1",
              kind: "command",
              title: "pwd",
              status: "running",
              toolName: "execute_command",
            }],
          }],
          summary: "",
          status: "running",
        },
      }),
    ).toBe("正在运行 pwd");
  });

  it("resolveLiveStatusText summarizes search as 正在搜索网页", () => {
    expect(
      resolveLiveStatusText({
        data: {
          id: "r",
          planStepGroups: [{
            planStepId: "_live",
            description: "执行",
            status: "running",
            steps: [{
              id: "s1",
              kind: "search",
              title: "ChatLuna",
              status: "running",
              toolName: "web_search",
            }],
          }],
          summary: "",
          status: "running",
        },
      }),
    ).toBe("正在搜索网页 · ChatLuna");
  });

  it("flattenProcessActivityRows builds flat tool and subagent rows", () => {
    const rows = flattenProcessActivityRows({
      id: "round-1",
      planStepGroups: [{
        planStepId: "_default",
        description: "执行",
        status: "completed",
        steps: [
          { id: "c1", kind: "command", title: "pwd", status: "success", toolName: "bash" },
          { id: "c2", kind: "command", title: "ls", status: "success", toolName: "bash" },
          { id: "r1", kind: "file_read", title: "a.md", status: "success", toolName: "read" },
        ],
      }],
      subagentRuns: [makeSubagentRun({ id: "sa1", status: "completed", role: "explore" })],
      summary: "执行了 3 个工具",
      status: "completed",
    });

    expect(rows.some((r) => r.kind === "group" && r.label.includes("多个命令"))).toBe(true);
    expect(rows.some((r) => r.label.includes("pwd"))).toBe(true);
    expect(rows.some((r) => r.label.includes("a.md"))).toBe(true);
    expect(rows.some((r) => r.kind === "subagent")).toBe(true);
  });

  it("formatProcessedSummaryLabel does not invent duration seconds", () => {
    expect(formatProcessedSummaryLabel({ stepCount: 3 })).toBe("已处理");
    expect(formatProcessedSummaryLabel({ stepCount: 3, durationMs: 13_000 })).toBe("已处理 13s");
  });

  it("mergeAgentRoundData collapses multiple rounds into one process block", () => {
    const a = buildAgentRoundFromMessage(
      {
        id: "a1",
        role: "assistant",
        content: "",
        createdAt: "2026-07-10T00:00:00.000Z",
        toolCalls: [{
          id: "c1",
          type: "function",
          function: { name: "bash", arguments: JSON.stringify({ command: "pwd" }) },
        }],
      },
      new Map([["c1", { ok: true, output: "/" }]]),
      [],
    );
    const b = buildAgentRoundFromMessage(
      {
        id: "a2",
        role: "assistant",
        content: "",
        createdAt: "2026-07-10T00:00:01.000Z",
        toolCalls: [{
          id: "c2",
          type: "function",
          function: { name: "web_search", arguments: JSON.stringify({ query: "x" }) },
        }],
      },
      new Map([["c2", { ok: true, output: [] }]]),
      [],
    );
    const merged = mergeAgentRoundData([a, b], "turn");
    expect(merged).not.toBeNull();
    expect(merged!.planStepGroups.flatMap((g) => g.steps).map((s) => s.id).sort()).toEqual(["c1", "c2"]);
    expect(merged!.markdownOutput).toBeUndefined();
    expect(flattenProcessActivityRows(merged!).length).toBeGreaterThanOrEqual(2);
  });
});

describe("AgentRound", () => {
  it("live mode renders 已处理 + gray status stream without plan-step tree", () => {
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
        processStartedAtMs={Date.now() - 5000}
        data={{
          id: "subagent-round",
          planStepGroups: [{
            planStepId: "_live",
            description: "执行",
            status: "running",
            steps: [{
              id: "tool-1",
              kind: "command",
              title: "pwd",
              status: "running",
              toolName: "bash",
            }],
          }],
          summary: "",
          subagentRuns: [run],
          status: "running",
        }}
      />,
    );

    expect(html).toContain("process-live-block");
    expect(html).toContain("process-live-status");
    expect(html).toContain("已处理");
    expect(html).toContain("正在调用 edit");
    expect(html).not.toContain("协作工作组");
    expect(html).not.toContain("timeline-step");
    expect(html).not.toContain("timeline-empty");
    expect(html).toContain('data-process="live"');
  });

  it("streams typewriter delivery while thinking without stacking 正在思考", () => {
    const html = renderToStaticMarkup(
      <AgentRound
        busy
        phaseDetail="Agent 正在思考"
        processStartedAtMs={Date.now()}
        data={{
          id: "live-tail",
          planStepGroups: [],
          summary: "",
          markdownOutput: "streaming answer appears as typewriter",
          status: "running",
        }}
      />,
    );

    expect(html).toContain("已处理");
    expect(html).toContain("streaming answer appears as typewriter");
    expect(html).toContain("stream-caret");
    expect(html).toContain("is-streaming");
    // 正文已出时不叠灰字「正在思考」
    expect(html).not.toContain("正在思考");
    expect(html).not.toContain("process-live-status");
  });

  it("shows 正在思考 only when there is no streaming body yet", () => {
    const html = renderToStaticMarkup(
      <AgentRound
        busy
        phaseDetail="Agent 正在思考"
        processStartedAtMs={Date.now()}
        data={{
          id: "live-wait",
          planStepGroups: [],
          summary: "",
          status: "running",
        }}
      />,
    );

    expect(html).toContain("已处理");
    expect(html).toContain("正在思考");
    expect(html).toContain("process-live-status");
  });

  it("hides typewriter delivery while a tool is running", () => {
    const html = renderToStaticMarkup(
      <AgentRound
        busy
        processStartedAtMs={Date.now()}
        data={{
          id: "live-tool",
          planStepGroups: [{
            planStepId: "_live",
            description: "执行",
            status: "running",
            steps: [{
              id: "s1",
              kind: "search",
              title: "dingyi",
              status: "running",
              toolName: "web_search",
            }],
          }],
          summary: "",
          markdownOutput: "intermediate narration should stay out of body",
          status: "running",
        }}
      />,
    );

    expect(html).toContain("正在搜索网页");
    expect(html).not.toContain("intermediate narration should stay out of body");
  });

  it("completed mode exposes collapsible summary and flat activity rows with per-step status", () => {
    const html = renderToStaticMarkup(
      <AgentRound
        defaultToolDetailsOpen
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

    expect(html).toContain("process-completed");
    expect(html).toContain("已处理");
    expect(html).toContain("process-activity-row");
    expect(html).toContain('data-status="success"');
    expect(html).toContain('data-status="failed"');
    expect(html).toContain("ok.md");
    expect(html).toContain("missing.md");
    expect(html).not.toContain("timeline-step");
    expect(html).not.toContain("doc-meta");
  });

  it("completed subagent rounds render as activity rows not workgroup cards", () => {
    const html = renderToStaticMarkup(
      <AgentRound
        defaultToolDetailsOpen
        data={{
          id: "sa-round",
          planStepGroups: [],
          summary: "",
          subagentRuns: [makeSubagentRun({ id: "sa-done", status: "completed", role: "coder" })],
          status: "completed",
        }}
      />,
    );

    expect(html).toContain("process-activity-row");
    expect(html).toContain('data-kind="subagent"');
    expect(html).not.toContain("协作工作组");
    expect(html).not.toContain("subagent-workgroup");
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
