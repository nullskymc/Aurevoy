import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskEventBus } from './events.js';

afterEach(() => vi.useRealTimers());

describe('TaskEventBus replay', () => {
  it('为单任务事件编号并支持从指定序号无损回放', () => {
    const bus = new TaskEventBus();
    const live = vi.fn();
    bus.subscribe('task-1', live);

    bus.publish({ type: 'status', taskId: 'task-1', status: 'running' });
    bus.publish({ type: 'token', taskId: 'task-1', delta: '你' });

    expect(live.mock.calls.map(([event]) => event.seq)).toEqual([1, 2]);
    expect(bus.replayAfter('task-1', 0)).toMatchObject({
      complete: true,
      latestSeq: 2,
      events: [{ seq: 1 }, { seq: 2 }],
    });
    expect(bus.replayAfter('task-1', 1)).toMatchObject({
      complete: true,
      latestSeq: 2,
      events: [{ seq: 2 }],
    });
  });

  it('冻结发布时的嵌套对象，避免回放被运行态后续修改', () => {
    const bus = new TaskEventBus();
    const plan = [{ id: 'step-1', description: '初始步骤', status: 'pending' as const }];
    bus.publish({ type: 'plan', taskId: 'task-1', plan });
    plan[0]!.description = '运行态已修改';

    const replay = bus.replayAfter('task-1', 0);
    expect(replay.events[0]).toMatchObject({
      type: 'plan',
      plan: [{ description: '初始步骤' }],
    });
  });

  it('任务恢复运行时取消旧终态的延迟清理', () => {
    vi.useFakeTimers();
    const bus = new TaskEventBus();
    bus.publish({ type: 'done', taskId: 'task-1', status: 'failed' });
    bus.publish({ type: 'status', taskId: 'task-1', status: 'running' });

    vi.advanceTimersByTime(5 * 60_000);
    expect(bus.replayAfter('task-1', 0)).toMatchObject({
      // 恢复新一轮时旧 done 已主动移出窗口，因此从 0 回放必须声明有缺口。
      complete: false,
      latestSeq: 2,
      events: [{ seq: 2 }],
    });
    expect(bus.replayAfter('task-1', 1)).toMatchObject({
      complete: true,
      latestSeq: 2,
      events: [{ seq: 2 }],
    });
  });

  it('环形缓冲满后覆盖最旧事件，回放窗口保持最新 4096 条且顺序正确', () => {
    const bus = new TaskEventBus();
    for (let i = 1; i <= 4100; i++) {
      bus.publish({ type: 'token', taskId: 'task-1', delta: `d${i}` });
    }

    // 从 0 回放：窗口最早 seq 为 4100 - 4096 + 1 = 5，必须声明有缺口。
    const replay = bus.replayAfter('task-1', 0);
    expect(replay.latestSeq).toBe(4100);
    expect(replay.complete).toBe(false);
    expect(replay.events).toHaveLength(4096);
    expect(replay.events[0]).toMatchObject({ seq: 5, delta: 'd5' });
    expect(replay.events.at(-1)).toMatchObject({ seq: 4100, delta: 'd4100' });

    // afterSeq 恰好落在窗口前一条：视为完整，且不丢窗口首条。
    const replay2 = bus.replayAfter('task-1', 4);
    expect(replay2.complete).toBe(true);
    expect(replay2.events).toHaveLength(4096);
    expect(replay2.events[0]).toMatchObject({ seq: 5 });

    // 窗口中部断点：只回放断点之后的事件，顺序保持。
    const replay3 = bus.replayAfter('task-1', 100);
    expect(replay3.complete).toBe(true);
    expect(replay3.events).toHaveLength(4000);
    expect(replay3.events[0]).toMatchObject({ seq: 101 });
    expect(replay3.events.at(-1)).toMatchObject({ seq: 4100 });
  });
});
