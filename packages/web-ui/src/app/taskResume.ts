import type { Task } from "@aurevoy/shared";

/**
 * 统一任务恢复入口的状态门禁：运行中、规划中和等待人工处理的暂停态
 * 由对应的实时 UI 接管，只有预算/完成门禁等待态允许直接续跑。
 */
export function canResumeTask(
  task: Pick<Task, "status" | "phase"> | null | undefined,
  busy: boolean,
): boolean {
  if (!task || busy) return false;
  if (task.status === "completed" || task.status === "running" || task.status === "planning") return false;
  return task.status !== "paused"
    || task.phase === "waiting_budget"
    || task.phase === "waiting_completion";
}
