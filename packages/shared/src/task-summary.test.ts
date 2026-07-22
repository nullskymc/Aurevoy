import { describe, expect, it } from 'vitest';
import type { Task } from './index.js';
import { taskSummaryFromTask } from './index.js';

describe('taskSummaryFromTask', () => {
  it('列表摘要不携带消息、计划和运行细节', () => {
    const task: Task = {
      id: 'task-1',
      goal: '分析项目',
      title: '项目分析',
      status: 'running',
      phase: 'calling_tool',
      plan: [{ id: 'step-1', description: '读取文件', status: 'running' }],
      messages: [{ id: 'message-1', role: 'assistant', content: '大量正文', createdAt: '2026-01-01T00:00:00.000Z' }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };

    expect(taskSummaryFromTask(task)).toEqual({
      id: 'task-1',
      goal: '分析项目',
      title: '项目分析',
      titleSource: undefined,
      status: 'running',
      projectId: undefined,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });
});
