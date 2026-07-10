/**
 * 子代理并发闸门。
 *
 * 父 Agent 可以在同一轮并行调用多个 delegate，但不能把模型一次生成的任意数量调用
 * 直接放大成本机/Provider 的无界并发。等待队列支持 AbortSignal，父任务取消后不会留下悬挂任务。
 */
export class SubagentConcurrencyLimiter {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly maxConcurrency: () => number) {}

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(createAbortError());
    if (this.active < this.limit()) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      waiter.onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(createAbortError());
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private limit(): number {
    const raw = Math.floor(this.maxConcurrency());
    return Number.isFinite(raw) && raw > 0 ? raw : 1;
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.limit() && this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      waiter.signal?.removeEventListener('abort', waiter.onAbort!);
      if (waiter.signal?.aborted) {
        waiter.reject(createAbortError());
        continue;
      }
      this.active += 1;
      waiter.resolve(this.createRelease());
    }
  }
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function createAbortError(): Error {
  const error = new Error('subagent_cancelled');
  error.name = 'AbortError';
  return error;
}
