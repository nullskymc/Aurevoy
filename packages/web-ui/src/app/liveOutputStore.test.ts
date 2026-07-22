import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveOutputStore } from "./liveOutputStore";

afterEach(() => vi.useRealTimers());

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

  it("只合帧 token，避免每条 SSE 都触发 React 更新", () => {
    vi.useFakeTimers();
    const store = createLiveOutputStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.append("一二三四");
    store.append("五六七八");
    expect(store.getSnapshot()).toBe("");
    expect(listener).not.toHaveBeenCalled();

    vi.advanceTimersByTime(31);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot()).toBe("一二三四五六七八");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("清空正文后从新消息重新追加", () => {
    vi.useFakeTimers();
    const store = createLiveOutputStore();
    store.append("旧消息");
    store.set("");
    store.append("新消息");
    vi.advanceTimersByTime(32);
    expect(store.getSnapshot()).toBe("新消息");
  });

  it("set 会先发布尚未合帧的尾部，确保消息切换不丢 token", () => {
    vi.useFakeTimers();
    const store = createLiveOutputStore();
    store.append("最后一段");
    store.set((previous) => `${previous}已落库`);
    expect(store.getSnapshot()).toBe("最后一段已落库");
  });
});
