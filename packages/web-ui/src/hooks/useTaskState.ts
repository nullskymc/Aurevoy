import { useState } from "react";
import type { PlanStep, Task, TaskPhase, TaskStatus, TaskTraceEntry } from "@aurevoy/shared";

export function useTaskState() {
  const [busy, setBusy] = useState(false);
  const [currentTask, setCurrentTask] = useState<Task | null>(null);
  const [output, setOutput] = useState("");
  const [phase, setPhase] = useState<TaskPhase | null>(null);
  const [plan, setPlan] = useState<PlanStep[]>([]);
  const [status, setStatus] = useState<TaskStatus | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [traces, setTraces] = useState<TaskTraceEntry[]>([]);

  function updateTaskList(task: Task): void {
    setTasks((previous) => {
      const withoutTask = previous.filter((item) => item.id !== task.id);
      return [task, ...withoutTask].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    });
  }

  /** 会影响 sidebar 排序/展示的关键字段 */
  const REORDER_TASK_KEYS: (keyof Task)[] = [
    'status',
    'phase',
    'plan',
    'messages',
    'updatedAt',
    'goal',
  ];

  function patchCurrentTask(patch: Partial<Task>): void {
    setCurrentTask((previous) => {
      if (!previous) return previous;
      const nextTask = { ...previous, ...patch };
      const shouldReorder = REORDER_TASK_KEYS.some((key) => key in patch);
      if (shouldReorder) {
        updateTaskList(nextTask);
      }
      return nextTask;
    });
  }

  return {
    busy,
    currentTask,
    output,
    phase,
    plan,
    status,
    tasks,
    traces,
    setBusy,
    setCurrentTask,
    setOutput,
    setPhase,
    setPlan,
    setStatus,
    setTasks,
    setTraces,
    patchCurrentTask,
    updateTaskList,
  };
}
