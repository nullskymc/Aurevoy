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
  /** 排定的合帧刷新：优先 rAF 句柄（number），rAF 不可用/窗口隐藏时退回 setTimeout 句柄。 */
  private flushTimer: number | ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = (): string => this.value;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** 取消已排定的合帧刷新（rAF 与 setTimeout 两种来源都能取消）。 */
  private clearScheduledFlush(): void {
    if (this.flushTimer === null) return;
    const timer = this.flushTimer;
    this.flushTimer = null;
    if (typeof timer === "number" && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(timer);
    } else {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
    }
  }

  /** 立即发布尚未显示的 token；消息持久化、清空或任务切换前调用，保证尾部不丢字。 */
  readonly flush = (): void => {
    this.clearScheduledFlush();
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

  /**
   * 首 token 立即显示；后续 token 在本地合帧。
   * 合帧优先挂到 requestAnimationFrame：刷新与浏览器绘制帧对齐，避免 setTimeout
   * 相位抖动或主线程繁忙/隐藏页定时器节流造成的「吐字一顿一顿」；
   * rAF 不可用或窗口隐藏（rAF 不触发）时退回 setTimeout 兜底。
   */
  readonly append = (delta: string): void => {
    if (!delta) return;
    if (!this.value && !this.pending && this.flushTimer === null) {
      this.value = delta;
      this.notify();
      return;
    }
    this.pending += delta;
    this.scheduleFlush();
  };

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    const rafAvailable = typeof requestAnimationFrame === "function";
    const pageHidden = typeof document !== "undefined" && document.hidden === true;
    if (!rafAvailable || pageHidden) {
      this.flushTimer = setTimeout(this.flush, STREAM_FRAME_MS);
      return;
    }
    // 到帧边界且超过 32ms 合帧间隔才发布：保持 30 FPS 上限，同时刷新点稳定落在绘制帧上。
    const scheduledAt = performance.now();
    const step = (): void => {
      this.flushTimer = null;
      if (performance.now() - scheduledAt >= STREAM_FRAME_MS) {
        this.flush();
        return;
      }
      this.flushTimer = requestAnimationFrame(step);
    };
    this.flushTimer = requestAnimationFrame(step);
  }
}

export function createLiveOutputStore(): LiveOutputStore {
  return new LiveOutputStore();
}
