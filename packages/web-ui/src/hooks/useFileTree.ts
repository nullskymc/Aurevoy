import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkspaceReadEntry } from "@aurevoy/shared";
import { readWorkspaceEntry } from "../api";

export interface FileTreeNodeState {
  entries: WorkspaceReadEntry[];
  open: boolean;
  loading: boolean;
  error: string | null;
  truncated: boolean;
  next?: number;
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

const DIRECTORY_PAGE_SIZE = 500;

function visibleEntries(entries: WorkspaceReadEntry[]): WorkspaceReadEntry[] {
  return entries.filter((entry) => !IGNORED_NAMES.has(entry.name));
}

function appendUniqueEntries(
  current: WorkspaceReadEntry[],
  additions: WorkspaceReadEntry[],
): WorkspaceReadEntry[] {
  const seen = new Set(current.map((entry) => entry.path));
  return [...current, ...additions.filter((entry) => !seen.has(entry.path))];
}

export function useFileTree(context: { taskId?: string; projectId?: string }) {
  const contextKey = useMemo(
    () => `${context.taskId ?? ""}:${context.projectId ?? ""}`,
    [context.projectId, context.taskId],
  );
  const [nodes, setNodes] = useState<Record<string, FileTreeNodeState>>({});

  const loadDirectory = useCallback(async (
    path: string,
    open = true,
    offset = 1,
    append = false,
  ) => {
    setNodes((current) => ({
      ...current,
      [path]: {
        ...(current[path] ?? DEFAULT_NODE),
        loading: true,
        error: null,
        open,
        ...(append ? {} : { truncated: false, next: undefined }),
      },
    }));
    try {
      const result = await readWorkspaceEntry({
        path,
        taskId: context.taskId,
        projectId: context.projectId,
        offset,
        limit: DIRECTORY_PAGE_SIZE,
      });
      if (result.type !== "directory") {
        throw new Error("Not a directory");
      }
      setNodes((current) => ({
        ...current,
        [path]: {
          ...(current[path] ?? DEFAULT_NODE),
          entries: append
            ? appendUniqueEntries(current[path]?.entries ?? [], visibleEntries(result.entries))
            : visibleEntries(result.entries),
          open,
          loading: false,
          error: null,
          truncated: result.truncated,
          ...(result.next !== undefined ? { next: result.next } : { next: undefined }),
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

  const loadMoreDirectory = useCallback((path: string) => {
    const current = nodes[path];
    if (!current || current.loading || current.next === undefined) return;
    void loadDirectory(path, true, current.next, true);
  }, [loadDirectory, nodes]);

  const reloadRoot = useCallback(() => {
    void loadDirectory(".", true);
  }, [loadDirectory]);

  return {
    nodes,
    reloadRoot,
    toggleDirectory,
    loadMoreDirectory,
  };
}
