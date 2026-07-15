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
    expect(html.match(/process-completed/g)?.length ?? 0).toBe(1);
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
        onToolDecision={noop}
        onClarificationAnswer={noop}
      />,
    );

    expect(html).toContain("agent-final-response");
    expect(html).toContain("背景");
    expect(html).toContain("目标");
    // 过程旁白不得出现在交付区
    const deliverySlice = html.split('class="agent-final-response"')[1] ?? "";
    expect(deliverySlice).not.toContain("我先查看工作区里的项目结构");
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

    expect(html.match(/process-completed/g)?.length ?? 0).toBe(1);
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

    expect(html).toContain("process-live-status");
    expect(html).toContain("data-process-stream");
    expect(html).not.toContain("Thought process");
    expect(html).not.toContain("workflow-drawer");
    expect(html).not.toContain('class="timeline-step"');
  });
});
