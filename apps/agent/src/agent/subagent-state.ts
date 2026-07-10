import type { SubagentRole, SubagentRun, Task } from '@aurevoy/shared';
import { taskStore } from '../store/db.js';
import { taskEvents } from './events.js';
import type { SubTaskProgress, SubTaskResult } from './subagent.js';

/**
 * 将子代理进度归一化为可持久回放的用户侧快照。
 * 高频 token 不进入这里；只记录生命周期、工具元数据和最终摘要，控制数据库与 UI 噪音。
 */
export function recordSubagentProgress(
  task: Task,
  parentCallId: string,
  role: SubagentRole,
  goal: string,
  progress: SubTaskProgress,
): SubagentRun {
  const now = new Date().toISOString();
  const existing = task.subagentRuns?.find((run) => run.id === progress.runId);
  const base: SubagentRun = existing ?? {
    id: progress.runId,
    parentCallId,
    role,
    goal,
    status: 'queued',
    activities: [],
    iterations: 0,
    toolCallCount: 0,
    maxIterations: progress.maxIterations,
    createdAt: now,
  };

  let activities = base.activities;
  if (progress.phase === 'tool_started' && progress.toolCallId && progress.toolName) {
    const nextActivity = {
      id: progress.toolCallId,
      toolName: progress.toolName,
      status: 'running' as const,
      startedAt: now,
    };
    activities = [
      ...activities.filter((activity) => activity.id !== progress.toolCallId),
      nextActivity,
    ];
  } else if (progress.phase === 'tool_completed' && progress.toolCallId && progress.toolName) {
    const previous = activities.find((activity) => activity.id === progress.toolCallId);
    const nextActivity = {
      id: progress.toolCallId,
      toolName: progress.toolName,
      status: progress.toolStatus === 'failed' ? 'failed' as const : 'completed' as const,
      startedAt: previous?.startedAt ?? now,
      completedAt: now,
      durationMs: progress.toolDurationMs,
      error: progress.error,
    };
    activities = [
      ...activities.filter((activity) => activity.id !== progress.toolCallId),
      nextActivity,
    ];
  }

  const run: SubagentRun = {
    ...base,
    parentCallId,
    role,
    goal,
    status: progress.phase === 'queued' ? 'queued' : 'running',
    currentActivity: progress.message,
    activities,
    iterations: progress.iteration ?? base.iterations,
    maxIterations: progress.maxIterations ?? base.maxIterations,
    startedAt: progress.phase === 'running' && !base.startedAt ? now : base.startedAt,
  };
  persistSubagentRun(task, run);
  return run;
}

/** 用精确 result 收敛运行状态；不会由模糊进度文案推断成功或失败。 */
export function completeSubagentRun(
  task: Task,
  parentCallId: string,
  role: SubagentRole,
  goal: string,
  result: SubTaskResult,
): SubagentRun {
  const now = new Date().toISOString();
  const existing = task.subagentRuns?.find((run) => run.id === result.runId);
  const status: SubagentRun['status'] = result.ok
    ? 'completed'
    : result.stopReason === 'cancelled'
      ? 'cancelled'
      : 'failed';
  const run: SubagentRun = {
    id: result.runId,
    parentCallId,
    role,
    goal,
    status,
    currentActivity: result.ok ? '已完成并返回结果' : result.error ?? '子代理运行失败',
    activities: existing?.activities ?? [],
    iterations: result.iterations,
    toolCallCount: result.toolCallCount,
    maxIterations: existing?.maxIterations,
    stopReason: result.stopReason,
    result: result.content || undefined,
    error: result.error,
    truncated: result.truncated,
    durationMs: result.durationMs,
    createdAt: existing?.createdAt ?? now,
    startedAt: existing?.startedAt ?? now,
    completedAt: now,
  };
  persistSubagentRun(task, run);
  return run;
}

function persistSubagentRun(task: Task, run: SubagentRun): void {
  const runs = [...(task.subagentRuns ?? [])];
  const index = runs.findIndex((item) => item.id === run.id);
  if (index >= 0) runs[index] = run;
  else runs.push(run);
  task.subagentRuns = runs;
  task.updatedAt = new Date().toISOString();
  taskStore.patch(task.id, { subagentRuns: runs });
  taskEvents.publish({ type: 'subagent_updated', taskId: task.id, run });
}
