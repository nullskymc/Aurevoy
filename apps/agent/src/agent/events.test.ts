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
});
