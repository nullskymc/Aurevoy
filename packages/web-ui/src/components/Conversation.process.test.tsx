// @vitest-environment jsdom
/**
 * Conversation 集成呈现：主路径过程层必须是 AgentRound 语法，
 * 不得再包一层「Thought process」抽屉。
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Message, Task } from "@aurevoy/shared";
import { Conversation } from "./Conversation";

vi.mock("dompurify", () => ({
  default: {
    sanitize: (value: string) => value,
  },
}));

function baseTask(overrides: Partial<Task> & { messages: Message[] }): Task {
  const { messages, ...rest } = overrides;
  return {
    id: "task-1",
    goal: "test",
    title: "test",
    status: "running",
    phase: "calling_tool",
    plan: [],
    messages,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    ...rest,
  };
}

const noop = () => {};

describe("Conversation process presentation (integrated path)", () => {
  it("live path shows process-live-status and never Thought process / workflow-drawer", () => {
    const task = baseTask({
      status: "running",
      phase: "thinking",
      messages: [
        {
          id: "u1",
          role: "user",
          content: "hello",
          createdAt: "2026-07-10T00:00:00.000Z",
        },
      ],
    });

    const html = renderToStaticMarkup(
      <Conversation
        task={task}
        status="running"
        phase="thinking"
        phaseDetail="Agent 正在思考"
        plan={[]}
        output=""
        busy
        liveToolActivity={[]}
        hasLiveTail
        onToolDecision={noop}
        onClarificationAnswer={noop}
      />,
    );

    expect(html).toContain("agent-process-stream");
    expect(html).toContain("process-live-status");
    expect(html).toContain("process-live-block");
    expect(html).toContain("已处理");
    expect(html).toContain("正在思考");
    expect(html).toContain('data-process="live"');
    expect(html).not.toContain("Thought process");
    expect(html).not.toContain("workflow-drawer");
    expect(html).not.toContain("timeline-step");
  });

  it("completed path exposes 已处理 summary without nested Thought process chrome", () => {
    const task = baseTask({
      status: "completed",
      phase: "finalizing",
      messages: [
        {
          id: "u1",
          role: "user",
          content: "run tools",
          createdAt: "2026-07-10T00:00:00.000Z",
        },
        {
          id: "a1",
          role: "assistant",
          content: "Done with tools.",
          createdAt: "2026-07-10T00:00:01.000Z",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({ command: "pwd" }),
              },
            },
            {
              id: "call-2",
              type: "function",
              function: {
                name: "read",
                arguments: JSON.stringify({ path: "ok.md" }),
              },
            },
          ],
        },
        {
          id: "t1",
          role: "tool",
          content: JSON.stringify({ ok: true, output: "/tmp" }),
          toolCallId: "call-1",
          createdAt: "2026-07-10T00:00:02.000Z",
        },
        {
          id: "t2",
          role: "tool",
          content: JSON.stringify({ ok: true, output: "file" }),
          toolCallId: "call-2",
          createdAt: "2026-07-10T00:00:03.000Z",
        },
      ],
    });

    const html = renderToStaticMarkup(
      <Conversation
        task={task}
        status="completed"
        phase="finalizing"
        plan={[]}
        output=""
        busy={false}
        liveToolActivity={[]}
        hasLiveTail={false}
        defaultToolDetailsOpen
        onToolDecision={noop}
        onClarificationAnswer={noop}
      />,
    );

    expect(html).toContain("agent-process-stream");
    expect(html).toContain("process-completed");
    expect(html).toContain("已处理");
    expect(html).toContain("process-activity-row");
    // 过程旁白不进交付正文区（仅活动行）
    expect(html).not.toContain("agent-final-response");
    expect(html).not.toContain("Thought process");
    expect(html).not.toContain("workflow-drawer");
    // Single process collapsible — not drawer + completed nested
    expect(html).not.toContain("workflow-drawer-toggle");
    expect(html.match(/class="process-completed"/g)?.length ?? 0).toBe(1);
    expect((html.match(/已处理/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("keeps process narration out of final delivery body", () => {
    const task = baseTask({
      status: "completed",
      phase: "finalizing",
      messages: [
        {
          id: "u1",
          role: "user",
          content: "梳理项目",
          createdAt: "2026-07-10T00:00:00.000Z",
        },
        {
          id: "a-narration",
          role: "assistant",
          content: "我先查看工作区里的项目结构和相关文档，再据此梳理背景、目标和当前进展。",
          createdAt: "2026-07-10T00:00:01.000Z",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "list_directory",
                arguments: JSON.stringify({ path: "." }),
              },
            },
          ],
        },
        {
          id: "t1",
          role: "tool",
          content: JSON.stringify({ ok: true, output: "src/" }),
          toolCallId: "call-1",
          createdAt: "2026-07-10T00:00:02.000Z",
        },
        {
          id: "a-final",
          role: "assistant",
          content: "## 背景\n\n农行作为四大行之一。\n\n## 目标\n\n做结构化深度调研。",
          createdAt: "2026-07-10T00:00:03.000Z",
        },
      ],
    });

    const html = renderToStaticMarkup(
      <Conversation
        task={task}
        status="completed"
        phase="finalizing"
        plan={[]}
        output=""
        busy={false}
        liveToolActivity={[]}
        hasLiveTail={false}
        defaultToolDetailsOpen
        onToolDecision={noop}
        onClarificationAnswer={noop}
      />,
    );

    expect(html).toContain("agent-final-response");
    expect(html).toContain("背景");
    expect(html).toContain("目标");
    expect(html).toContain("process-completed-narration");
    const processSegment = (html.split('data-message-id="a-narration"')[1] ?? "").split("</section>")[0] ?? "";
    expect(processSegment).toContain("我先查看工作区里的项目结构");
    expect(processSegment).toContain("process-activity-list");
    // 过程旁白不得出现在交付区
    const deliverySlice = html.split('class="agent-final-response"')[1] ?? "";
    expect(deliverySlice).not.toContain("我先查看工作区里的项目结构");
    expect(deliverySlice).toContain("agent-message-actions");
    expect(deliverySlice).toContain('aria-label="Copy"');
    expect(deliverySlice).toContain('dateTime="2026-07-10T00:00:03.000Z"');
    expect(html).toContain('dateTime="2026-07-10T00:00:00.000Z"');
  });

  it("merges multiple tool-calling assistant messages into one 已处理", () => {
    const task = baseTask({
      status: "completed",
      phase: "finalizing",
      messages: [
        {
          id: "u1",
          role: "user",
          content: "search dingyi",
          createdAt: "2026-07-10T00:00:00.000Z",
        },
        {
          id: "a1",
          role: "assistant",
          content: "",
          createdAt: "2026-07-10T00:00:01.000Z",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "web_search",
                arguments: JSON.stringify({ query: "dingyi" }),
              },
            },
          ],
        },
        {
          id: "t1",
          role: "tool",
          content: JSON.stringify({ ok: true, output: "hits" }),
          toolCallId: "call-1",
          createdAt: "2026-07-10T00:00:02.000Z",
        },
        {
          id: "a2",
          role: "assistant",
          content: "",
          createdAt: "2026-07-10T00:00:03.000Z",
          toolCalls: [
            {
              id: "call-2",
              type: "function",
              function: {
                name: "web_search",
                arguments: JSON.stringify({ query: "dingyi222666" }),
              },
            },
          ],
        },
        {
          id: "t2",
          role: "tool",
          content: JSON.stringify({ ok: true, output: "more hits" }),
          toolCallId: "call-2",
          createdAt: "2026-07-10T00:00:04.000Z",
        },
        {
          id: "a3",
          role: "assistant",
          content: "主要命中的是开发者 dingyi。",
          createdAt: "2026-07-10T00:00:05.000Z",
        },
      ],
    });

    const html = renderToStaticMarkup(
      <Conversation
        task={task}
        status="completed"
        phase="finalizing"
        plan={[]}
        output=""
        busy={false}
        liveToolActivity={[]}
        hasLiveTail={false}
        defaultToolDetailsOpen
        onToolDecision={noop}
        onClarificationAnswer={noop}
      />,
    );

    expect(html.match(/class="process-completed"/g)?.length ?? 0).toBe(1);
    expect((html.match(/已处理/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(html).toContain("process-activity-row");
    expect(html).toContain("已搜索网页");
    expect(html).toContain("主要命中的是开发者");
    expect(html).not.toContain("Thought process");
  });

  it("live tool activity surfaces as status stream not expandable tool-card timeline", () => {
    const task = baseTask({
      status: "running",
      phase: "calling_tool",
      messages: [
        {
          id: "u1",
          role: "user",
          content: "search",
          createdAt: "2026-07-10T00:00:00.000Z",
        },
      ],
    });

    const html = renderToStaticMarkup(
      <Conversation
        task={task}
        status="running"
        phase="calling_tool"
        phaseDetail=""
        plan={[]}
        output=""
        busy
        liveToolActivity={[
          {
            id: "live-1",
            name: "web_search",
            args: { query: "x" },
            status: "running",
          },
        ]}
        hasLiveTail
        onToolDecision={noop}
        onClarificationAnswer={noop}
      />,
    );

    // live 有工具时用活动行，而非可展开 tool-card 时间轴
    expect(html).toContain("process-activity-list");
    expect(html).toContain("正在搜索网页");
    expect(html).toContain("data-process-stream");
    expect(html).not.toContain("Thought process");
    expect(html).not.toContain("workflow-drawer");
    expect(html).not.toContain('class="timeline-step"');
  });

  it("binds token-stream narration to the current live tool before message persistence", () => {
    const task = baseTask({
      status: "running",
      phase: "calling_tool",
      messages: [
        {
          id: "u1",
          role: "user",
          content: "检查项目",
          createdAt: "2026-07-10T00:00:00.000Z",
        },
      ],
    });

    const html = renderToStaticMarkup(
      <Conversation
        task={task}
        status="running"
        phase="calling_tool"
        plan={[]}
        output="我先读取项目说明，再检查目录结构。"
        busy
        liveToolActivity={[
          { id: "call-read", name: "read", args: { path: "README.md" }, status: "running" },
        ]}
        hasLiveTail
        onToolDecision={noop}
        onClarificationAnswer={noop}
      />,
    );

    const streamingSegment = (html.split('data-process-segment="streaming"')[1] ?? "")
      .split("</section>")[0] ?? "";
    expect(streamingSegment).toContain("我先读取项目说明，再检查目录结构。");
    expect(streamingSegment).toContain("正在读取");
  });

  it("shows persisted process narration immediately while its tool remains live", () => {
    const task = baseTask({
      status: "running",
      phase: "calling_tool",
      messages: [
        {
          id: "u1",
          role: "user",
          content: "检查工作区",
          createdAt: "2026-07-10T00:00:00.000Z",
        },
        {
          id: "a1",
          role: "assistant",
          content: "我先查看工作区里的项目结构，再判断下一步。",
          createdAt: "2026-07-10T00:00:01.000Z",
          toolCalls: [
            {
              id: "call-read",
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ path: "README.md" }) },
            },
          ],
        },
      ],
    });

    const html = renderToStaticMarkup(
      <Conversation
        task={task}
        status="running"
        phase="calling_tool"
        plan={[]}
        output=""
        busy
        liveToolActivity={[{ id: "call-read", name: "read", args: { path: "README.md" }, status: "running" }]}
        hasLiveTail
        onToolDecision={noop}
        onClarificationAnswer={noop}
      />,
    );

    expect(html).toContain("process-live-narration");
    expect(html).toContain("我先查看工作区里的项目结构，再判断下一步。");
    expect(html).toContain("正在读取");
    const segment = html.split('data-message-id="a1"')[1] ?? "";
    expect(segment).toContain("正在读取");
  });

  it("collects completed tool process before streaming the final response", () => {
    const task = baseTask({
      status: "running",
      phase: "thinking",
      messages: [
        {
          id: "u1",
          role: "user",
          content: "检查工作区",
          createdAt: "2026-07-10T00:00:00.000Z",
        },
        {
          id: "a-process",
          role: "assistant",
          content: "我先读取项目说明。",
          createdAt: "2026-07-10T00:00:01.000Z",
          toolCalls: [
            {
              id: "call-read",
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ path: "README.md" }) },
            },
          ],
        },
        {
          id: "tool-read",
          role: "tool",
          content: JSON.stringify({ ok: true, output: "项目说明" }),
          toolCallId: "call-read",
          createdAt: "2026-07-10T00:00:02.000Z",
        },
      ],
    });

    const html = renderToStaticMarkup(
      <Conversation
        task={task}
        status="running"
        phase="thinking"
        phaseDetail="Agent 正在思考"
        plan={[]}
        output="最终结论正在流式生成"
        busy
        liveToolActivity={[]}
        hasLiveTail
        onToolDecision={noop}
        onClarificationAnswer={noop}
      />,
    );

    const completedIndex = html.indexOf("process-completed");
    const finalStreamIndex = html.indexOf("最终结论正在流式生成");
    expect(completedIndex).toBeGreaterThanOrEqual(0);
    expect(finalStreamIndex).toBeGreaterThan(completedIndex);
    expect(html).not.toContain("process-live-narration");
  });

  it("ask_user clarification renders question markdown structure (not plain escaped text)", () => {
    const task = baseTask({
      status: "paused",
      phase: "waiting_clarification",
      messages: [
        {
          id: "u1",
          role: "user",
          content: "调研美股盘后",
          createdAt: "2026-07-10T00:00:00.000Z",
        },
      ],
      clarifications: [
        {
          id: "c1",
          callId: "call-ask",
          status: "pending",
          createdAt: "2026-07-10T00:00:02.000Z",
          question: [
            "## 调研话题：美股盘后",
            "",
            "请确认框架是否需要增删。",
            "",
            "### Items 列表",
            "",
            "1. **三大指数盘后表现**",
            "2. **股指期货与隔夜定价**",
            "",
            "### 请确认",
            "",
            "1. Items 是否需要增减？",
          ].join("\n"),
          options: ["框架可用，按此推进", "我要自定义增减 items/字段"],
          context: "背景：**盘后研究**常见维度",
        },
      ],
    });

    const html = renderToStaticMarkup(
      <Conversation
        task={task}
        status="paused"
        phase="waiting_clarification"
        phaseDetail="等待用户补充信息"
        plan={[]}
        output=""
        busy={false}
        liveToolActivity={[]}
        hasLiveTail={false}
        onToolDecision={noop}
        onClarificationAnswer={noop}
      />,
    );

    expect(html).toContain("gate-card");
    expect(html).toContain("gate-card-markdown");
    expect(html).toContain("markdown-body");
    // Headings / bold / list structure from marked, not raw ## ** markers as body text
    expect(html).toMatch(/<h2[^>]*>调研话题：美股盘后<\/h2>/);
    expect(html).toMatch(/<h3[^>]*>Items 列表<\/h3>/);
    expect(html).toContain("<strong>三大指数盘后表现</strong>");
    expect(html).toContain("<ol>");
    expect(html).toContain("gate-card-chip");
    expect(html).toContain("框架可用，按此推进");
    // context also markdown
    expect(html).toContain("<strong>盘后研究</strong>");
    // Must not dump raw markdown markers as the only representation
    expect(html).not.toContain("## 调研话题");
    expect(html).not.toContain("**三大指数盘后表现**");
  });

  it("renders present_ui as the assistant delivery instead of process narration", () => {
    const task = baseTask({
      status: "completed",
      phase: "finalizing",
      messages: [
        {
          id: "u1",
          role: "user",
          content: "给我一个交互探索器",
          createdAt: "2026-07-10T00:00:00.000Z",
        },
        {
          id: "a1",
          role: "assistant",
          content: "",
          createdAt: "2026-07-10T00:00:01.000Z",
          toolCalls: [{
            id: "call-ui",
            type: "function",
            function: {
              name: "present_ui",
              arguments: JSON.stringify({ kind: "canvas" }),
            },
          }],
          contentBlocks: [{
            id: "dataset-explorer",
            type: "ui",
            kind: "canvas",
            content: "数据探索器",
            props: {
              title: "数据探索器",
              html: "<p>可筛选的数据</p>",
            },
          }],
        },
        {
          id: "t1",
          role: "tool",
          content: "交互片段已展示",
          toolCallId: "call-ui",
          createdAt: "2026-07-10T00:00:02.000Z",
        },
        {
          id: "a2",
          role: "assistant",
          content: "可以直接筛选并选择条目查看详情。",
          createdAt: "2026-07-10T00:00:03.000Z",
        },
      ],
    });

    const html = renderToStaticMarkup(
      <Conversation
        task={task}
        status="completed"
        phase="finalizing"
        phaseDetail=""
        plan={[]}
        output=""
        busy={false}
        liveToolActivity={[]}
        hasLiveTail={false}
        onToolDecision={noop}
        onClarificationAnswer={noop}
      />,
    );

    expect(html).toContain("gen-ui-canvas");
    expect(html).toContain("数据探索器");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("可以直接筛选并选择条目查看详情。");
    expect(html).not.toContain("已调用 present_ui");
  });
});
