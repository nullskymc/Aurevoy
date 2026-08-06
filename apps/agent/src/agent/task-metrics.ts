import type {
  Task,
  TaskErrorCategory,
  TaskObservabilityReport,
  TaskTraceEntry,
  TokenUsageReport,
} from '@aurevoy/shared';
import { buildTokenUsageReport } from './token-usage.js';

const TERMINAL_STATUSES = new Set<Task['status']>(['completed', 'failed', 'cancelled']);
const ACTIVE_STATUSES = new Set<Task['status']>(['pending', 'planning', 'running']);

/** 将任务轨迹聚合为本地诊断指标；仅读取内存对象，不上传或持久化额外内容。 */
export function buildTaskObservabilityReport(
  tasks: Task[],
  tracesForTask: (taskId: string) => TaskTraceEntry[],
  now = new Date(),
): TaskObservabilityReport {
  let terminalTasks = 0;
  let completedTasks = 0;
  let failedTasks = 0;
  let cancelledTasks = 0;
  let activeTasks = 0;
  let pausedTasks = 0;
  let recoveredTasks = 0;
  let userInterventions = 0;
  let retries = 0;
  const durations: number[] = [];
  const failureCategories: Partial<Record<TaskErrorCategory, number>> = {};

  for (const task of tasks) {
    if (TERMINAL_STATUSES.has(task.status)) terminalTasks += 1;
    if (task.status === 'completed') completedTasks += 1;
    if (task.status === 'failed') failedTasks += 1;
    if (task.status === 'cancelled') cancelledTasks += 1;
    if (ACTIVE_STATUSES.has(task.status)) activeTasks += 1;
    if (task.status === 'paused') pausedTasks += 1;

    const createdAt = Date.parse(task.createdAt);
    const updatedAt = Date.parse(task.updatedAt);
    if (TERMINAL_STATUSES.has(task.status) && Number.isFinite(createdAt) && Number.isFinite(updatedAt) && updatedAt >= createdAt) {
      durations.push(updatedAt - createdAt);
    }

    const traces = tracesForTask(task.id);
    let taskRecovered = false;
    for (const trace of traces) {
      const data = isRecord(trace.data) ? trace.data : undefined;
      if (trace.kind === 'approval') userInterventions += 1;
      if (trace.kind === 'phase' && data?.delivery && trace.ok !== false) userInterventions += 1;
      if (trace.kind === 'phase' && data?.kind === 'clarification') userInterventions += 1;

      if (isRecoveryTrace(trace, data)) taskRecovered = true;
      if (isRetryTrace(trace)) retries += 1;
      if (trace.kind === 'error' && trace.errorCategory) {
        failureCategories[trace.errorCategory] = (failureCategories[trace.errorCategory] ?? 0) + 1;
      }
    }
    // clarification 状态是任务持久化真相源；补上没有单独 trace 的用户回答。
    userInterventions += (task.clarifications ?? []).filter((item) => item.status !== 'pending').length;
    if (taskRecovered) recoveredTasks += 1;
  }

  const sortedDurations = [...durations].sort((a, b) => a - b);
  const report: TaskObservabilityReport = {
    generatedAt: now.toISOString(),
    tasks: tasks.length,
    terminalTasks,
    completedTasks,
    failedTasks,
    cancelledTasks,
    activeTasks,
    pausedTasks,
    successRate: terminalTasks > 0 ? completedTasks / terminalTasks : null,
    recoveredTasks,
    userInterventions,
    retries,
    measuredDurationTasks: sortedDurations.length,
    averageDurationMs: sortedDurations.length > 0
      ? Math.round(sortedDurations.reduce((sum, value) => sum + value, 0) / sortedDurations.length)
      : null,
    p95DurationMs: percentile(sortedDurations, 0.95),
    failureCategories,
    tokenUsage: buildTokenUsageReport(tasks),
  };
  return report;
}

function isRecoveryTrace(trace: TaskTraceEntry, data: Record<string, unknown> | undefined): boolean {
  if (trace.kind !== 'error' && trace.kind !== 'phase') return false;
  return Boolean(
    data?.recoveredAt ||
    data?.previousStatus ||
    /恢复|重启|restart|recovered/i.test(trace.summary ?? ''),
  );
}

function isRetryTrace(trace: TaskTraceEntry): boolean {
  return trace.kind === 'phase' && /重试|续跑|继续|恢复|retry|resume|continue/i.test(trace.summary ?? '');
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1));
  return values[index] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 保留一个具名导出，便于 route 层和回归测试表达 token 汇总仍来自同一实现。 */
export type { TokenUsageReport };
