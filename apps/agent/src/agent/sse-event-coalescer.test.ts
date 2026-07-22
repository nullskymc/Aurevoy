import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@aurevoy/shared';
import { createAgentEventCoalescer } from './sse-event-coalescer.js';

afterEach(() => vi.useRealTimers());

describe('createAgentEventCoalescer', () => {
  it('无损合并时间窗口内的连续 token', () => {
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const coalescer = createAgentEventCoalescer((event) => events.push(event), 24);
    coalescer.push({ type: 'token', taskId: 'task-1', delta: '你' });
    coalescer.push({ type: 'token', taskId: 'task-1', delta: '好' });

    expect(events).toEqual([]);
    vi.advanceTimersByTime(24);
    expect(events).toEqual([{ type: 'token', taskId: 'task-1', delta: '你好' }]);
  });

  it('在非 token 事件前同步排空，保持协议顺序', () => {
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const coalescer = createAgentEventCoalescer((event) => events.push(event), 24);
    coalescer.push({ type: 'token', taskId: 'task-1', delta: '正文' });
    coalescer.push({ type: 'message_start', taskId: 'task-1', role: 'assistant' });

    expect(events.map((event) => event.type)).toEqual(['token', 'message_start']);
  });
});
