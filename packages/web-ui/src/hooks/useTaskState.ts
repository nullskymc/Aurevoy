import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { PlanStep, Task, TaskPhase, TaskStatus, TaskSummary, TaskTraceEntry } from "@aurevoy/shared";
import { formatTaskTitle } from "@aurevoy/shared";
import { createLiveOutputStore } from "../app/liveOutputStore";
import { normalizeTaskSummary, patchTaskSummaryList, upsertTaskSummary } from "../app/taskSummary";

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
  const currentTaskIdRef = useRef<string | null>(null);
  const [outputStore] = useState(createLiveOutputStore);
  const [phase, setPhase] = useState<TaskPhase | null>(null);
  const [plan, setPlan] = useState<PlanStep[]>([]);
  const [status, setStatus] = useState<TaskStatus | null>(null);
  const [tasks, setTasksState] = useState<TaskSummary[]>([]);
  const [traces, setTraces] = useState<TaskTraceEntry[]>([]);

  const setCurrentTask: Dispatch<SetStateAction<Task | null>> = (value) => {
    if (typeof value === "function") {
      setCurrentTaskState((previous) => {
        const next = sanitizeNullableTaskForDisplay((value as (previous: Task | null) => Task | null)(previous));
        currentTaskIdRef.current = next?.id ?? null;
        return next;
      });
      return;
    }
    const next = sanitizeNullableTaskForDisplay(value);
    currentTaskIdRef.current = next?.id ?? null;
    setCurrentTaskState(next);
  };

  const setTasks: Dispatch<SetStateAction<TaskSummary[]>> = (value) => {
    if (typeof value === "function") {
      setTasksState((previous) =>
        (value as (previous: TaskSummary[]) => TaskSummary[])(previous).map(normalizeTaskSummary),
      );
      return;
    }
    setTasksState(value.map(normalizeTaskSummary));
  };

  function updateTaskList(task: Task): void {
    setTasksState((previous) => upsertTaskSummary(previous, sanitizeTaskForDisplay(task)));
  }

  function patchCurrentTask(patch: Partial<Task>): void {
    const taskId = currentTaskIdRef.current;
    setCurrentTaskState((previous) =>
      previous ? sanitizeTaskForDisplay({ ...previous, ...patch }) : previous,
    );

    if (!taskId) return;
    setTasksState((previous) => patchTaskSummaryList(previous, taskId, patch));
  }

  return {
    busy,
    currentTask,
    outputStore,
    phase,
    plan,
    status,
    tasks,
    traces,
    setBusy,
    setCurrentTask,
    setOutput: outputStore.set,
    appendOutput: outputStore.append,
    setPhase,
    setPlan,
    setStatus,
    setTasks,
    setTraces,
    patchCurrentTask,
    updateTaskList,
  };
}
