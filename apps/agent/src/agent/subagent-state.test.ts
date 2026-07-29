import type { Task } from '@aurevoy/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { patchTask, publishEvent } = vi.hoisted(() => ({
  patchTask: vi.fn(),
  publishEvent: vi.fn(),
}));

vi.mock('../store/db.js', () => ({
  taskStore: { patch: patchTask },
}));
vi.mock('./events.js', () => ({
  taskEvents: { publish: publishEvent },
}));

import { completeSubagentRun, recordSubagentProgress } from './subagent-state.js';

describe('subagent state projection', () => {
  beforeEach(() => {
    patchTask.mockClear();
    publishEvent.mockClear();
  });

  it('persists lifecycle and internal tool activities as a replayable task snapshot', () => {
    const task = makeTask();
    recordSubagentProgress(task, 'parent-call', 'coder', '完善前端', {
      runId: 'run-1',
      phase: 'running',
      message: '子代理 coder 已启动',
      iteration: 0,
    });
    recordSubagentProgress(task, 'parent-call', 'coder', '完善前端', {
      runId: 'run-1',
      phase: 'tool_started',
      message: '正在调用 edit',
      iteration: 1,
      toolCallId: 'child-edit',
      toolName: 'edit',
    });
    recordSubagentProgress(task, 'parent-call', 'coder', '完善前端', {
      runId: 'run-1',
      phase: 'tool_completed',
      message: '已完成 edit',
      iteration: 1,
      toolCallId: 'child-edit',
      toolName: 'edit',
      toolStatus: 'completed',
      toolDurationMs: 42,
    });
    const completed = completeSubagentRun(task, 'parent-call', 'coder', '完善前端', {
      runId: 'run-1',
      ok: true,
      content: '前端已完成',
      toolCallCount: 1,
      iterations: 2,
      role: 'coder',
      stopReason: 'completed',
      durationMs: 1200,
      maxIterations: 12,
      maxWallMs: 600_000,
      truncated: false,
    });

    expect(completed.status).toBe('completed');
    expect(completed.activities).toEqual([
      expect.objectContaining({ id: 'child-edit', toolName: 'edit', status: 'completed', durationMs: 42 }),
    ]);
    expect(task.subagentRuns).toEqual([completed]);
    expect(patchTask).toHaveBeenLastCalledWith(task.id, { subagentRuns: [completed] });
    expect(publishEvent).toHaveBeenLastCalledWith({
      type: 'subagent_updated',
      taskId: task.id,
      run: completed,
    });
  });

  it('maps cancellation to a user-visible terminal state', () => {
    const task = makeTask();
    const cancelled = completeSubagentRun(task, 'parent-call', 'research', '调研资料', {
      runId: 'run-cancelled',
      ok: false,
      content: '',
      toolCallCount: 0,
      iterations: 0,
      role: 'research',
      stopReason: 'cancelled',
      durationMs: 50,
      maxIterations: 12,
      maxWallMs: 600_000,
      truncated: false,
      error: '父任务已取消',
    });

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.error).toBe('父任务已取消');
  });
});

function makeTask(): Task {
  const now = '2026-07-10T00:00:00.000Z';
  return {
    id: 'task-subagent-ui',
    goal: '完善子代理前端',
    title: '完善子代理前端',
    status: 'running',
    phase: 'calling_tool',
    plan: [],
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}
