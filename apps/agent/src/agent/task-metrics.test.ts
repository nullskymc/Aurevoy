import { describe, expect, it } from 'vitest';
import type { Task, TaskTraceEntry } from '@aurevoy/shared';
import { buildTaskObservabilityReport } from './task-metrics.js';

function task(id: string, status: Task['status'], createdAt: string, updatedAt: string): Task {
  return {
    id,
    goal: id,
    title: id,
    titleSource: 'truncated',
    status,
    phase: status === 'failed' ? 'failed' : null,
    plan: [],
    messages: [],
    artifacts: [],
    fileChanges: [],
    clarifications: [],
    pendingApprovals: [],
    checkpoints: [],
    budget: {},
    budgetUsage: { iterations: 0, toolCalls: 0, wallTimeMs: 0, outputBytes: 0 },
    lifetimeBudget: {},
    lifetimeUsage: { iterations: 0, toolCalls: 0, wallTimeMs: 0, outputBytes: 0 },
    tokenUsage: { available: false },
    createdAt,
    updatedAt,
  };
}

function trace(taskId: string, partial: Partial<TaskTraceEntry>): TaskTraceEntry {
  return {
    id: `${taskId}-${Math.random()}`,
    taskId,
    kind: 'phase',
    phase: null,
    tokenUsage: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    ...partial,
  };
}

describe('task observability metrics', () => {
  it('aggregates terminal state, interventions, recovery and duration without task content', () => {
    const completed = task('completed', 'completed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z');
    const failed = task('failed', 'failed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:02:00.000Z');
    const paused = task('paused', 'paused', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:10.000Z');
    paused.clarifications = [{
      id: 'clarification-1',
      question: 'which?',
      callId: 'call-1',
      status: 'answered',
      answer: 'this one',
      createdAt: '2026-01-01T00:00:01.000Z',
    }];
    const traces = new Map<string, TaskTraceEntry[]>([
      ['completed', [
        trace('completed', { kind: 'approval', ok: true }),
        trace('completed', { summary: '用户恢复历史任务', data: { previousStatus: 'failed' } }),
      ]],
      ['failed', [trace('failed', { kind: 'error', ok: false, errorCategory: 'network' })]],
      ['paused', []],
    ]);

    const report = buildTaskObservabilityReport(
      [completed, failed, paused],
      (taskId) => traces.get(taskId) ?? [],
      new Date('2026-01-02T00:00:00.000Z'),
    );

    expect(report).toMatchObject({
      tasks: 3,
      terminalTasks: 2,
      completedTasks: 1,
      failedTasks: 1,
      pausedTasks: 1,
      successRate: 0.5,
      recoveredTasks: 1,
      userInterventions: 2,
      retries: 1,
      measuredDurationTasks: 2,
      averageDurationMs: 90000,
      p95DurationMs: 120000,
      failureCategories: { network: 1 },
    });
    expect(report).not.toHaveProperty('goal');
  });
});
