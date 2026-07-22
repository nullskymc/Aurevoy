import { formatTaskTitle, taskSummaryFromTask, type Task, type TaskSummary } from "@aurevoy/shared";

export const TASK_SUMMARY_KEYS: readonly (keyof TaskSummary)[] = [
  "status",
  "updatedAt",
  "goal",
  "title",
  "titleSource",
  "projectId",
];

export function normalizeTaskSummary(task: TaskSummary): TaskSummary {
  const title = task.title?.trim() ? task.title : formatTaskTitle(task.goal);
  return title === task.title
    ? task
    : { ...task, title, titleSource: task.titleSource ?? "truncated" };
}

export function upsertTaskSummary(previous: TaskSummary[], task: Task): TaskSummary[] {
  const summary = normalizeTaskSummary(taskSummaryFromTask(task));
  return [summary, ...previous.filter((item) => item.id !== summary.id)].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

/** 无关 patch 返回原数组引用，让侧边栏、搜索和托盘跳过更新。 */
export function patchTaskSummaryList(
  previous: TaskSummary[],
  taskId: string,
  patch: Partial<Task>,
): TaskSummary[] {
  const entries = TASK_SUMMARY_KEYS
    .filter((key) => key in patch)
    .map((key) => [key, patch[key]] as const);
  if (entries.length === 0) return previous;

  const index = previous.findIndex((task) => task.id === taskId);
  if (index < 0) return previous;
  const candidate = normalizeTaskSummary({
    ...previous[index],
    ...Object.fromEntries(entries),
  });
  if (TASK_SUMMARY_KEYS.every((key) => Object.is(candidate[key], previous[index][key]))) {
    return previous;
  }
  const next = previous.slice();
  next[index] = candidate;
  return next.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}
