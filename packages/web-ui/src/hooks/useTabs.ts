import { useCallback, useEffect, useMemo, useState } from "react";

export type RightPanelTab =
  | { id: string; kind: "workspace"; path: string; name: string }
  | { id: string; kind: "artifact"; taskId: string; artifactId: string; name: string; mimeType?: string }
  | { id: string; kind: "empty"; name: string };

const STORAGE_KEY = "aurevoy.rightPanelTabs.v1";

function readStoredTabs(): { tabs: RightPanelTab[]; activeTabId: string | null } {
  if (typeof window === "undefined") return { tabs: [], activeTabId: null };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { tabs: [], activeTabId: null };
    const parsed = JSON.parse(raw) as { tabs?: RightPanelTab[]; activeTabId?: string | null };
    return {
      tabs: Array.isArray(parsed.tabs) ? parsed.tabs.filter(isRightPanelTab) : [],
      activeTabId: typeof parsed.activeTabId === "string" ? parsed.activeTabId : null,
    };
  } catch {
    return { tabs: [], activeTabId: null };
  }
}

function isRightPanelTab(value: unknown): value is RightPanelTab {
  if (!value || typeof value !== "object") return false;
  const tab = value as Partial<RightPanelTab>;
  if (typeof tab.id !== "string" || typeof tab.name !== "string") return false;
  if (tab.kind === "workspace") return typeof tab.path === "string";
  if (tab.kind === "artifact") return typeof tab.taskId === "string" && typeof tab.artifactId === "string";
  if (tab.kind === "empty") return true;
  return false;
}

function fileName(path: string): string {
  const clean = path.replace(/\/+$/g, "");
  return clean.split("/").pop() || clean || ".";
}

export function useTabs() {
  const stored = useMemo(readStoredTabs, []);
  const [tabs, setTabs] = useState<RightPanelTab[]>(stored.tabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(stored.activeTabId);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs, activeTabId }));
  }, [tabs, activeTabId]);

  const openWorkspaceFile = useCallback((path: string) => {
    const tab: RightPanelTab = { id: `workspace:${path}`, kind: "workspace", path, name: fileName(path) };
    setTabs((current) => current.some((item) => item.id === tab.id) ? current : [...current, tab]);
    setActiveTabId(tab.id);
  }, []);

  const openArtifact = useCallback((artifact: { id: string; name: string; mimeType?: string }, taskId: string) => {
    const tab: RightPanelTab = {
      id: `artifact:${taskId}:${artifact.id}`,
      kind: "artifact",
      taskId,
      artifactId: artifact.id,
      name: artifact.name,
      mimeType: artifact.mimeType,
    };
    setTabs((current) => current.some((item) => item.id === tab.id) ? current : [...current, tab]);
    setActiveTabId(tab.id);
  }, []);

  const openEmptyTab = useCallback((name = "Open File") => {
    const tab: RightPanelTab = { id: `empty:${Date.now()}:${Math.random().toString(36).slice(2)}`, kind: "empty", name };
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
  }, []);

  const closeTab = useCallback((tabId: string) => {
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === tabId);
      const next = current.filter((tab) => tab.id !== tabId);
      setActiveTabId((active) => {
        if (active !== tabId) return active;
        return next[Math.max(0, index - 1)]?.id ?? next[0]?.id ?? null;
      });
      return next;
    });
  }, []);

  return {
    tabs,
    activeTabId,
    activeTab: tabs.find((tab) => tab.id === activeTabId) ?? null,
    setActiveTabId,
    openWorkspaceFile,
    openArtifact,
    openEmptyTab,
    closeTab,
  };
}
