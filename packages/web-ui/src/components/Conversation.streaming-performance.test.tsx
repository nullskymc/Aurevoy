// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message, Task } from "@aurevoy/shared";
import { createLiveOutputStore } from "../app/liveOutputStore";

const renderCounts = vi.hoisted(() => ({ historical: 0, streaming: 0 }));

vi.mock("./MarkdownRenderer", async () => {
  const React = await import("react");
  return {
    MarkdownRenderer: ({ content }: { content: string }) => {
      renderCounts.historical += 1;
      return React.createElement("div", null, content);
    },
    StreamingMarkdownRenderer: ({ content }: { content: string }) => {
      renderCounts.streaming += 1;
      return React.createElement("div", null, content);
    },
  };
});

import { Conversation, shouldAdjustConversationScrollPosition } from "./Conversation";

const noop = () => {};
const CONVERSATION_TEST_TURN_HEIGHT = 240;
let root: ReturnType<typeof createRoot> | undefined;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
  renderCounts.historical = 0;
  renderCounts.streaming = 0;
});

function task(messages: Message[]): Task {
  return {
    id: "task-stream-performance",
    goal: "验证流式隔离",
    title: "验证流式隔离",
    status: "running",
    phase: "thinking",
    plan: [],
    messages,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
}

describe("Conversation streaming render boundary", () => {
  it("工具完成重新测高时只补偿视口之前的 turn", () => {
    // 底部跟随由 anchorTo 独占；当前工具 turn 的高度变化不能再触发第二次补偿。
    expect(shouldAdjustConversationScrollPosition({ itemIndex: 39, firstVisibleIndex: 36, atEnd: true })).toBe(false);
    // 用户上滑后，可见 turn 自身变化保持视口稳定，只有窗口上方的历史高度变化需要补偿。
    expect(shouldAdjustConversationScrollPosition({ itemIndex: 36, firstVisibleIndex: 36, atEnd: false })).toBe(false);
    expect(shouldAdjustConversationScrollPosition({ itemIndex: 12, firstVisibleIndex: 36, atEnd: false })).toBe(true);
  });

  it("只挂载虚拟窗口内的历史 turn，并固定保留实时最后一轮", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("conversation-virtual-item") ? CONVERSATION_TEST_TURN_HEIGHT : 0;
    });
    const messages: Message[] = Array.from({ length: 40 }, (_, index) => [
      {
        id: `u${index}`,
        role: "user" as const,
        content: `问题 ${index}`,
        createdAt: `2026-07-22T00:${String(index).padStart(2, "0")}:00.000Z`,
      },
      {
        id: `a${index}`,
        role: "assistant" as const,
        content: `回答 ${index}`,
        createdAt: `2026-07-22T00:${String(index).padStart(2, "0")}:01.000Z`,
      },
    ]).flat();
    const scroll = document.createElement("div");
    scroll.className = "main-scroll";
    Object.defineProperties(scroll, {
      offsetWidth: { configurable: true, value: 800 },
      offsetHeight: { configurable: true, value: 900 },
    });
    scroll.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: 900,
      width: 800,
      height: 900,
      toJSON: () => ({}),
    });
    const container = document.createElement("div");
    scroll.appendChild(container);
    document.body.appendChild(scroll);
    root = createRoot(container);

    act(() => {
      root?.render(
        <Conversation
          task={task(messages)}
          status="running"
          phase="thinking"
          plan={[]}
          busy
          liveToolActivity={[]}
          hasLiveTail
          onToolDecision={noop}
          onClarificationAnswer={noop}
        />,
      );
    });

    const canvas = container.querySelector('[data-virtualized="true"]');
    const mountedTurns = container.querySelectorAll(".conversation-virtual-item");
    expect(canvas).not.toBeNull();
    expect(mountedTurns.length).toBeGreaterThan(0);
    expect(mountedTurns.length).toBeLessThan(40);
    expect(container.querySelector('[data-index="39"]')).not.toBeNull();
  });

  it("中间旁白流式期间不提前收纳过程层（抽屉不折叠历史旁白）", () => {
    vi.useFakeTimers();
    const outputStore = createLiveOutputStore();
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <Conversation
          task={task([
            { id: "u1", role: "user", content: "整理工作区", createdAt: "2026-07-22T00:00:00.000Z" },
            {
              id: "a1",
              role: "assistant",
              content: "我先看一下工作区结构。",
              toolCalls: [{ id: "call-1", type: "function", function: { name: "list_dir", arguments: "{}" } }],
              createdAt: "2026-07-22T00:00:01.000Z",
            },
            { id: "t1", role: "tool", content: "[]", toolCallId: "call-1", createdAt: "2026-07-22T00:00:02.000Z" },
          ])}
          status="running"
          phase="thinking"
          plan={[]}
          outputStore={outputStore}
          busy
          liveToolActivity={[]}
          hasLiveTail
          onToolDecision={noop}
          onClarificationAnswer={noop}
        />,
      );
    });

    // 第二条中间旁白开始流式：此时无运行中的工具、也无最终交付。
    act(() => outputStore.append("工具返回了，我继续分析。"));
    act(() => vi.advanceTimersByTime(32));

    // 过程层应保持展开：历史旁白段仍在，且不出现提前收纳的「已处理」抽屉。
    expect(container.querySelector(".process-live-narration")).not.toBeNull();
    expect(container.querySelector(".process-completed")).toBeNull();
    expect(container.textContent).toContain("我先看一下工作区结构");
    expect(container.textContent).toContain("工具返回了，我继续分析");
  });

  it("追加 token 只重渲染 live Markdown，不重渲染历史 Markdown", () => {
    vi.useFakeTimers();
    const outputStore = createLiveOutputStore();
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <Conversation
          task={task([
            { id: "u1", role: "user", content: "问题", createdAt: "2026-07-22T00:00:00.000Z" },
            { id: "a1", role: "assistant", content: "已经存在的历史回答", createdAt: "2026-07-22T00:00:01.000Z" },
          ])}
          status="running"
          phase="thinking"
          plan={[]}
          outputStore={outputStore}
          busy
          liveToolActivity={[]}
          hasLiveTail
          onToolDecision={noop}
          onClarificationAnswer={noop}
        />,
      );
    });

    const historicalAfterMount = renderCounts.historical;
    expect(historicalAfterMount).toBeGreaterThan(0);

    act(() => outputStore.append("新的流式正文"));
    act(() => vi.advanceTimersByTime(32));

    expect(renderCounts.streaming).toBeGreaterThan(0);
    expect(container.textContent).toContain("新的流式正文");
    expect(renderCounts.historical).toBe(historicalAfterMount);

    act(() => outputStore.append("，继续追加"));
    act(() => vi.advanceTimersByTime(32));

    expect(container.textContent).toContain("新的流式正文，继续追加");
    expect(renderCounts.historical).toBe(historicalAfterMount);
  });
});
