import type { Dispatch, SetStateAction } from "react";
import type { Task, TaskArtifact } from "@aurevoy/shared";

export function useArtifacts(
  setCurrentTask: Dispatch<SetStateAction<Task | null>>,
  updateTaskList: (task: Task) => void,
) {
  function mergeArtifact(artifact: TaskArtifact): void {
    setCurrentTask((previous) => {
      if (!previous) return previous;
      const artifacts = mergeById(previous.artifacts ?? [], artifact);
      const nextTask = { ...previous, artifacts };
      updateTaskList(nextTask);
      return nextTask;
    });
  }

  return { mergeArtifact };
}

function mergeById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) return [...items, next];
  return items.map((item) => (item.id === next.id ? next : item));
}
