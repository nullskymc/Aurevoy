import type { AgentEvent } from '@aurevoy/shared';

export interface AgentEventCoalescer {
  push(event: AgentEvent): void;
  flush(): void;
  cancel(): void;
}

/**
 * 将短窗口内连续 token 合为一个无损事件；任何非 token 事件到来前先排空，保证消息顺序。
 */
export function createAgentEventCoalescer(
  emit: (event: AgentEvent) => void,
  delayMs = 24,
): AgentEventCoalescer {
  let pending: Extract<AgentEvent, { type: 'token' }> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending) return;
    const event = pending;
    pending = null;
    emit(event);
  };

  return {
    push(event) {
      if (event.type !== 'token') {
        flush();
        emit(event);
        return;
      }
      if (pending?.taskId === event.taskId) pending.delta += event.delta;
      else {
        flush();
        pending = { ...event };
      }
      if (!timer) timer = setTimeout(flush, delayMs);
    },
    flush,
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
