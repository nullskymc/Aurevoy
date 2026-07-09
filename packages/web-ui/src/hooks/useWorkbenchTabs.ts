import { useCallback, useEffect, useMemo, useState } from "react";

/** Open documents only — explorer is not a tab. */
export type WorkbenchTab =
  | { id: string; kind: "workspace"; path: string; name: string }
  | { id: string; kind: "artifact"; taskId: string; artifactId: string; name: string; mimeType?: string };

interface ScopeTabs {
  tabs: WorkbenchTab[];
  activeTabId: string | null;
}

/** v2: tabs scoped by project (preferred) or task. Old v1 global store is ignored. */
const STORAGE_KEY = "aurevoy.workbenchTabs.v2";

function scopeKey(projectId?: string, taskId?: string): string {
  if (projectId) return `project:${projectId}`;
  if (taskId) return `task:${taskId}`;
  return "default";
}

function fileName(path: string): string {
  const clean = path.replace(/\/+$/g, "");
  return clean.split("/").pop() || clean || ".";
}

function isWorkbenchTab(value: unknown): value is WorkbenchTab {
  if (!value || typeof value !== "object") return false;
  const tab = value as Partial<WorkbenchTab>;
  if (typeof tab.id !== "string" || typeof tab.name !== "string") return false;
  if (tab.kind === "workspace") return typeof tab.path === "string";
  if (tab.kind === "artifact") {
    return typeof tab.taskId === "string" && typeof tab.artifactId === "string";
  }
  return false;
}

function readStore(): Record<string, ScopeTabs> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { byScope?: Record<string, ScopeTabs> };
    if (!parsed.byScope || typeof parsed.byScope !== "object") return {};
    const result: Record<string, ScopeTabs> = {};
    for (const [key, value] of Object.entries(parsed.byScope)) {
      if (!value || typeof value !== "object") continue;
      const tabs = Array.isArray(value.tabs) ? value.tabs.filter(isWorkbenchTab) : [];
      const activeTabId =
        typeof value.activeTabId === "string" && tabs.some((tab) => tab.id === value.activeTabId)
          ? value.activeTabId
          : tabs[0]?.id ?? null;
      result[key] = { tabs, activeTabId };
    }
    return result;
  } catch {
    return {};
  }
}

function pruneArtifacts(tabs: WorkbenchTab[], taskId?: string): WorkbenchTab[] {
  if (!taskId) return tabs.filter((tab) => tab.kind !== "artifact");
  return tabs.filter((tab) => tab.kind !== "artifact" || tab.taskId === taskId);
}

export function useWorkbenchTabs(scope: { projectId?: string; taskId?: string }) {
  const key = useMemo(() => scopeKey(scope.projectId, scope.taskId), [scope.projectId, scope.taskId]);
  const [store, setStore] = useState<Record<string, ScopeTabs>>(readStore);

  const current = store[key] ?? { tabs: [], activeTabId: null };
  const tabs = useMemo(
    () => pruneArtifacts(current.tabs, scope.taskId),
    [current.tabs, scope.taskId],
  );
  const activeTabId =
    current.activeTabId && tabs.some((tab) => tab.id === current.activeTabId)
      ? current.activeTabId
      : tabs[0]?.id ?? null;
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ byScope: store }));
  }, [store]);

  // Drop cross-task artifact tabs when the active task changes within the same scope.
  useEffect(() => {
    setStore((prev) => {
      const entry = prev[key];
      if (!entry) return prev;
      const nextTabs = pruneArtifacts(entry.tabs, scope.taskId);
      if (nextTabs.length === entry.tabs.length) return prev;
      const nextActive =
        entry.activeTabId && nextTabs.some((tab) => tab.id === entry.activeTabId)
          ? entry.activeTabId
          : nextTabs[0]?.id ?? null;
      return { ...prev, [key]: { tabs: nextTabs, activeTabId: nextActive } };
    });
  }, [key, scope.taskId]);

  const patchScope = useCallback((updater: (entry: ScopeTabs) => ScopeTabs) => {
    setStore((prev) => {
      const entry = prev[key] ?? { tabs: [], activeTabId: null };
      return { ...prev, [key]: updater(entry) };
    });
  }, [key]);

  const openWorkspaceFile = useCallback((path: string) => {
    const tab: WorkbenchTab = {
      id: `workspace:${path}`,
      kind: "workspace",
      path,
      name: fileName(path),
    };
    patchScope((entry) => ({
      tabs: entry.tabs.some((item) => item.id === tab.id) ? entry.tabs : [...entry.tabs, tab],
      activeTabId: tab.id,
    }));
  }, [patchScope]);

  const openArtifact = useCallback(
    (artifact: { id: string; name: string; mimeType?: string }, taskId: string) => {
      const tab: WorkbenchTab = {
        id: `artifact:${taskId}:${artifact.id}`,
        kind: "artifact",
        taskId,
        artifactId: artifact.id,
        name: artifact.name,
        mimeType: artifact.mimeType,
      };
      patchScope((entry) => ({
        tabs: entry.tabs.some((item) => item.id === tab.id) ? entry.tabs : [...entry.tabs, tab],
        activeTabId: tab.id,
      }));
    },
    [patchScope],
  );

  const closeTab = useCallback((tabId: string) => {
    patchScope((entry) => {
      const index = entry.tabs.findIndex((tab) => tab.id === tabId);
      const nextTabs = entry.tabs.filter((tab) => tab.id !== tabId);
      let nextActive = entry.activeTabId;
      if (entry.activeTabId === tabId) {
        nextActive = nextTabs[Math.max(0, index - 1)]?.id ?? nextTabs[0]?.id ?? null;
      }
      return { tabs: nextTabs, activeTabId: nextActive };
    });
  }, [patchScope]);

  const setActiveTabId = useCallback((tabId: string) => {
    patchScope((entry) => ({ ...entry, activeTabId: tabId }));
  }, [patchScope]);

  return {
    tabs,
    activeTabId,
    activeTab,
    setActiveTabId,
    openWorkspaceFile,
    openArtifact,
    closeTab,
  };
}
