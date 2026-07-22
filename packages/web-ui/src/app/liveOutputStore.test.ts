import { describe, expect, it, vi } from "vitest";
import { createLiveOutputStore } from "./liveOutputStore";

describe("LiveOutputStore", () => {
  it("在 React 根状态之外按顺序累加 token", () => {
    const store = createLiveOutputStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.set((previous) => previous + "你");
    store.set((previous) => previous + "好");

    expect(store.getSnapshot()).toBe("你好");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("相同值不通知订阅者", () => {
    const store = createLiveOutputStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.set("");
    expect(listener).not.toHaveBeenCalled();
  });

  it("直接提交 SSE 层已经按帧合并的 token，不额外制造打字延迟", () => {
    const store = createLiveOutputStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.append("一二三四五六七八");
    expect(store.getSnapshot()).toBe("一二三四五六七八");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("清空正文后从新消息重新追加", () => {
    const store = createLiveOutputStore();
    store.append("旧消息");
    store.set("");
    store.append("新消息");
    expect(store.getSnapshot()).toBe("新消息");
  });
});
