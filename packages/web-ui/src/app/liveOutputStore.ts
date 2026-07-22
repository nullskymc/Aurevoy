import type { SetStateAction } from "react";

/**
 * 高频流式正文使用独立外部 store，避免每个 token 都让 App、侧边栏和输入区重渲染。
 * React 只在真正消费正文的 Conversation 子树中订阅它。
 */
export class LiveOutputStore {
  private value = "";
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = (): string => this.value;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly set = (next: SetStateAction<string>): void => {
    const value = typeof next === "function"
      ? (next as (previous: string) => string)(this.value)
      : next;
    if (value === this.value) return;
    this.value = value;
    for (const listener of this.listeners) listener();
  };

  /**
   * SSE 层已经按浏览器帧合批，这里直接追加完整增量。
   * 不再人为逐字延迟，避免“纯文本打字完成后再切换 Markdown”的视觉跳变。
   */
  readonly append = (delta: string): void => {
    if (!delta) return;
    this.value += delta;
    for (const listener of this.listeners) listener();
  };
}

export function createLiveOutputStore(): LiveOutputStore {
  return new LiveOutputStore();
}
