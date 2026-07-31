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

  it("首 token 立即显示，后续 token 合帧", () => {
    vi.useFakeTimers();
    const store = createLiveOutputStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.append("一二三四");
    store.append("五六七八");
    expect(store.getSnapshot()).toBe("一二三四");
    expect(listener).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(31);
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot()).toBe("一二三四五六七八");
    expect(listener).toHaveBeenCalledTimes(2);
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

describe("LiveOutputStore frame-aligned flush", () => {
  it("rAF 可用时合帧刷新与绘制帧对齐，首 token 仍立即显示", () => {
    vi.useFakeTimers();
    const store = createLiveOutputStore();
    const listener = vi.fn();
    store.subscribe(listener);

    // 模拟 60Hz 绘制帧：rAF 由 16ms 定时器驱动，返回定时器句柄。
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16) as unknown as number,
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));

    store.append("第一");
    expect(store.getSnapshot()).toBe("第一"); // 首 token 立即显示
    store.append("第二");

    // 距首个待发布 token 不足 32ms（第 1-2 个绘制帧内）不发布。
    vi.advanceTimersByTime(24);
    expect(store.getSnapshot()).toBe("第一");
    expect(listener).toHaveBeenCalledTimes(1);

    // 第 3 个绘制帧（t=32）已过合帧间隔，此时发布且落在帧边界上。
    vi.advanceTimersByTime(16);
    expect(store.getSnapshot()).toBe("第一第二");
    expect(listener).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });

  it("窗口隐藏（rAF 不触发）时退回 setTimeout 合帧", () => {
    vi.useFakeTimers();
    // node 测试环境无 document；stub 一个 hidden=true 的 document 验证隐藏页兜底。
    vi.stubGlobal("document", { hidden: true });
    const raf = vi.fn();
    vi.stubGlobal("requestAnimationFrame", raf);

    const store = createLiveOutputStore();
    store.append("a");
    store.append("b");
    expect(raf).not.toHaveBeenCalled();

    vi.advanceTimersByTime(32);
    expect(store.getSnapshot()).toBe("ab");

    vi.unstubAllGlobals();
  });
});
