import type { SetStateAction } from "react";

/** Markdown、测高和滚动修正不需要跟随每个 token；30 FPS 足以保持连续阅读感。 */
const STREAM_FRAME_MS = 32;

/**
 * 高频流式正文使用独立外部 store：App 与历史消息不重渲染，live tail 也只按显示帧更新。
 * 事件协议本身不延迟，工具/审批/状态仍由 SSE 层立即处理。
 */
export class LiveOutputStore {
  private value = "";
  private pending = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = (): string => this.value;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** 立即发布尚未显示的 token；消息持久化、清空或任务切换前调用，保证尾部不丢字。 */
  readonly flush = (): void => {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.pending) return;
    this.value += this.pending;
    this.pending = "";
    this.notify();
  };

  readonly set = (next: SetStateAction<string>): void => {
    this.flush();
    const value = typeof next === "function"
      ? (next as (previous: string) => string)(this.value)
      : next;
    if (value === this.value) return;
    this.value = value;
    this.notify();
  };

  /** token 在本地合帧，最多每 32ms 触发一次 React、Markdown 与虚拟列表测高。 */
  readonly append = (delta: string): void => {
    if (!delta) return;
    this.pending += delta;
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(this.flush, STREAM_FRAME_MS);
  };
}

export function createLiveOutputStore(): LiveOutputStore {
  return new LiveOutputStore();
}
