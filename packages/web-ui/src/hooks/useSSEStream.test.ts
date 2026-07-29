// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@aurevoy/shared";

vi.mock("../api", () => ({ getBaseUrl: () => "http://127.0.0.1:8787" }));

const { fetchEventSourceMock } = vi.hoisted(() => ({
  fetchEventSourceMock: vi.fn(),
}));

vi.mock("@microsoft/fetch-event-source", () => ({
  EventStreamContentType: "text/event-stream",
  fetchEventSource: fetchEventSourceMock,
}));

import { useSSEStream } from "./useSSEStream";

let root: ReturnType<typeof createRoot> | undefined;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  fetchEventSourceMock.mockReset();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useSSEStream immediate dispatch", () => {
  it("按到达顺序立即分发 token 和每一条工具进度，不经过 RAF 合并", () => {
    fetchEventSourceMock.mockResolvedValue(undefined);
    const requestFrame = vi.spyOn(globalThis, "requestAnimationFrame");
    const received: AgentEvent[] = [];
    let openStream: ReturnType<typeof useSSEStream>["openStream"] | undefined;

    function Harness() {
      const stream = useSSEStream();
      stream.syncEventHandler((event) => received.push(event));
      openStream = stream.openStream;
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(createElement(Harness)));
    act(() => openStream?.("task-1", (event) => received.push(event), () => {}, { hasSnapshot: true }));

    expect(fetchEventSourceMock).toHaveBeenCalledOnce();
    const [url, options] = fetchEventSourceMock.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:8787/api/tasks/task-1/stream?afterSeq=0&snapshot=0");
    expect(options.openWhenHidden).toBe(true);
    expect(options.headers).toEqual({ Accept: "text/event-stream" });
    options.onmessage({ data: JSON.stringify({ type: "token", taskId: "task-1", delta: "你" }) });
    options.onmessage({ data: JSON.stringify({ type: "token", taskId: "task-1", delta: "好" }) });
    options.onmessage({ data: JSON.stringify({ type: "tool_progress", taskId: "task-1", callId: "call-1", message: "10%", percent: 10 }) });
    options.onmessage({ data: JSON.stringify({ type: "tool_progress", taskId: "task-1", callId: "call-1", message: "80%", percent: 80 }) });

    expect(received.map((event) => event.type)).toEqual(["token", "token", "tool_progress", "tool_progress"]);
    expect(received.slice(0, 2).map((event) => event.type === "token" ? event.delta : "")).toEqual(["你", "好"]);
    expect(requestFrame).not.toHaveBeenCalled();
  });
});
