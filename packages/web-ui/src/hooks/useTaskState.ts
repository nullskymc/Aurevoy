import { useState, type Dispatch, type SetStateAction } from "react";
import type { PlanStep, Task, TaskPhase, TaskStatus, TaskTraceEntry } from "@aurevoy/shared";
import { formatTaskTitle } from "@aurevoy/shared";

function sanitizeTaskForDisplay(task: Task): Task {
  const messages = task.messages.filter((message) => message.role !== "system");
  const title = task.title?.trim() ? task.title : formatTaskTitle(task.goal);
  const needsMessages = messages.length !== task.messages.length;
  const needsTitle = title !== task.title;
  if (!needsMessages && !needsTitle) return task;
  return {
    ...task,
    ...(needsMessages ? { messages } : null),
    ...(needsTitle ? { title, titleSource: task.titleSource ?? "truncated" } : null),
  };
}

function sanitizeNullableTaskForDisplay(task: Task | null): Task | null {
  return task ? sanitizeTaskForDisplay(task) : task;
}

export function useTaskState() {
  const [busy, setBusy] = useState(false);
  const [currentTask, setCurrentTaskState] = useState<Task | null>(null);
  const [output, setOutput] = useState("");
  const [phase, setPhase] = useState<TaskPhase | null>(null);
  const [plan, setPlan] = useState<PlanStep[]>([]);
  const [status, setStatus] = useState<TaskStatus | null>(null);
  const [tasks, setTasksState] = useState<Task[]>([]);
  const [traces, setTraces] = useState<TaskTraceEntry[]>([]);

  const setCurrentTask: Dispatch<SetStateAction<Task | null>> = (value) => {
    if (typeof value === "function") {
      setCurrentTaskState((previous) =>
        sanitizeNullableTaskForDisplay((value as (previous: Task | null) => Task | null)(previous)),
      );
      return;
    }
    setCurrentTaskState(sanitizeNullableTaskForDisplay(value));
  };

  const setTasks: Dispatch<SetStateAction<Task[]>> = (value) => {
    if (typeof value === "function") {
      setTasksState((previous) => (value as (previous: Task[]) => Task[])(previous).map(sanitizeTaskForDisplay));
      return;
    }
    setTasksState(value.map(sanitizeTaskForDisplay));
  };

  function updateTaskList(task: Task): void {
    const displayTask = sanitizeTaskForDisplay(task);
    setTasksState((previous) => {
      const withoutTask = previous.filter((item) => item.id !== displayTask.id);
      return [displayTask, ...withoutTask].sort(
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
    'title',
  ];

  function patchCurrentTask(patch: Partial<Task>): void {
    setCurrentTaskState((previous) => {
      if (!previous) return previous;
      const nextTask = sanitizeTaskForDisplay({ ...previous, ...patch });
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
