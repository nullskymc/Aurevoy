import type { Task } from '@aurevoy/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { taskStore } from '../store/db.js';
import { recoverInterruptedTasksOnBoot } from './harness-controller.js';

const createdTaskIds: string[] = [];

afterEach(() => {
  for (const id of createdTaskIds.splice(0)) taskStore.delete(id);
});

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  const now = '2026-08-06T00:00:00.000Z';
  const task: Task = {
    id,
    goal: '恢复中断任务',
    title: '恢复中断任务',
    status: 'running',
    phase: 'calling_tool',
    plan: [{ id: 'step-1', description: '读取文件', status: 'completed' }],
    messages: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  taskStore.save(task);
  createdTaskIds.push(id);
  return task;
}

describe('harness restart recovery', () => {
  it('auto-resumes safe in-flight tasks and preserves a recovery marker', () => {
    const previous = config.agent.autoResumeInterruptedTasks;
    config.agent.autoResumeInterruptedTasks = true;
    try {
      makeTask('recovery-safe', { status: 'running', phase: 'calling_tool' });

      const result = recoverInterruptedTasksOnBoot();

      expect(result.resumed.map((task) => task.id)).toContain('recovery-safe');
      expect(result.manual.map((task) => task.id)).not.toContain('recovery-safe');
      expect(result.resumed.find((task) => task.id === 'recovery-safe')).toMatchObject({
        status: 'pending',
        phase: 'initializing',
        resumedAfterRestart: true,
      });
    expect(taskStore.get('recovery-safe')).toMatchObject({
      status: 'pending',
      phase: 'initializing',
      resumedAfterRestart: true,
    });
    } finally {
      config.agent.autoResumeInterruptedTasks = previous;
    }
  });

  it('does not auto-resume a task waiting for an approval', () => {
    const previous = config.agent.autoResumeInterruptedTasks;
    config.agent.autoResumeInterruptedTasks = true;
    try {
      makeTask('recovery-approval', {
        status: 'paused',
        phase: 'waiting_approval',
        pendingApprovals: [{
          call: { id: 'call-1', toolName: 'execute_command', args: { command: 'npm test' } },
          riskLevel: 'dangerous',
          createdAt: '2026-08-06T00:00:01.000Z',
        }],
      });

      const result = recoverInterruptedTasksOnBoot();

      expect(result.resumed.map((task) => task.id)).not.toContain('recovery-approval');
      expect(result.manual.map((task) => task.id)).toContain('recovery-approval');
      expect(taskStore.get('recovery-approval')).toMatchObject({
        status: 'failed',
        phase: 'failed',
        pendingApprovals: [],
      });
    } finally {
      config.agent.autoResumeInterruptedTasks = previous;
    }
  });
});
