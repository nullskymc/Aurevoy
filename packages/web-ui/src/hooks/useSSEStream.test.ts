// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@aurevoy/shared";

vi.mock("../api", () => ({ getBaseUrl: () => "http://127.0.0.1:8787" }));

import { useSSEStream } from "./useSSEStream";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  emit(event: AgentEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  }
}

let root: ReturnType<typeof createRoot> | undefined;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  FakeEventSource.instances = [];
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useSSEStream immediate dispatch", () => {
  it("按到达顺序立即分发 token 和每一条工具进度，不经过 RAF 合并", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
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
    act(() => openStream?.("task-1", (event) => received.push(event), () => {}));

    const source = FakeEventSource.instances[0];
    expect(source).toBeDefined();
    source!.emit({ type: "token", taskId: "task-1", delta: "你" });
    source!.emit({ type: "token", taskId: "task-1", delta: "好" });
    source!.emit({ type: "tool_progress", taskId: "task-1", callId: "call-1", message: "10%", percent: 10 });
    source!.emit({ type: "tool_progress", taskId: "task-1", callId: "call-1", message: "80%", percent: 80 });

    expect(received.map((event) => event.type)).toEqual(["token", "token", "tool_progress", "tool_progress"]);
    expect(received.slice(0, 2).map((event) => event.type === "token" ? event.delta : "")).toEqual(["你", "好"]);
    expect(requestFrame).not.toHaveBeenCalled();
  });
});
