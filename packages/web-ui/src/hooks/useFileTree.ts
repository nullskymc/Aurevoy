import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkspaceReadEntry } from "@aurevoy/shared";
import { readWorkspaceEntry } from "../api";

interface FileTreeNodeState {
  entries: WorkspaceReadEntry[];
  open: boolean;
  loading: boolean;
  error: string | null;
  truncated: boolean;
}

const DEFAULT_NODE: FileTreeNodeState = {
  entries: [],
  open: false,
  loading: false,
  error: null,
  truncated: false,
};

const IGNORED_NAMES = new Set([
  ".git",
  ".aurevoy-trash",
  "node_modules",
  "dist",
  "build",
  "target",
  ".next",
  ".turbo",
]);

function visibleEntries(entries: WorkspaceReadEntry[]): WorkspaceReadEntry[] {
  return entries.filter((entry) => !IGNORED_NAMES.has(entry.name));
}

export function useFileTree(context: { taskId?: string; projectId?: string }) {
  const contextKey = useMemo(
    () => `${context.taskId ?? ""}:${context.projectId ?? ""}`,
    [context.projectId, context.taskId],
  );
  const [nodes, setNodes] = useState<Record<string, FileTreeNodeState>>({});

  const loadDirectory = useCallback(async (path: string, open = true) => {
    setNodes((current) => ({
      ...current,
      [path]: { ...(current[path] ?? DEFAULT_NODE), loading: true, error: null, open },
    }));
    try {
      const result = await readWorkspaceEntry({
        path,
        taskId: context.taskId,
        projectId: context.projectId,
        limit: 500,
      });
      if (result.type !== "directory") {
        throw new Error("Not a directory");
      }
      setNodes((current) => ({
        ...current,
        [path]: {
          entries: visibleEntries(result.entries),
          open,
          loading: false,
          error: null,
          truncated: result.truncated,
        },
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setNodes((current) => ({
        ...current,
        [path]: { ...(current[path] ?? DEFAULT_NODE), loading: false, error: message, open },
      }));
    }
  }, [context.projectId, context.taskId]);

  useEffect(() => {
    setNodes({});
    void loadDirectory(".", true);
  }, [contextKey, loadDirectory]);

  const toggleDirectory = useCallback((path: string) => {
    const current = nodes[path];
    if (current?.open) {
      setNodes((state) => ({
        ...state,
        [path]: { ...state[path], open: false },
      }));
      return;
    }
    void loadDirectory(path, true);
  }, [loadDirectory, nodes]);

  return {
    nodes,
    reloadRoot: () => loadDirectory(".", true),
    toggleDirectory,
  };
}
