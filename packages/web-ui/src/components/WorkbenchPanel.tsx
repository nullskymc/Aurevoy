import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { Task, TaskArtifact, WorkspaceReadEntry } from "@aurevoy/shared";
import { readStoredPaneSize, startPaneResize } from "../app/paneResize";
import { useFileTree } from "../hooks/useFileTree";
import type { WorkbenchTab } from "../hooks/useWorkbenchTabs";
import { FileTree } from "./FileTree";
import { FileViewer } from "./FileViewer";
import { IconClose, IconShowTree } from "./workbenchIcons";
import { IconFolder } from "../icons";
import { t } from "../i18n";
import "./WorkbenchPanel.css";

const EXPLORER_OPEN_KEY = "aurevoy.workbenchExplorerOpen";
const EXPLORER_WIDTH_KEY = "aurevoy.workbenchExplorerWidth";
const MIN_EXPLORER_WIDTH = 160;
const MAX_EXPLORER_WIDTH = 420;
const DEFAULT_EXPLORER_WIDTH = 260;
const WORKBENCH_SPLIT_WIDTH = 5;
const MIN_EDITOR_WIDTH = 140;

/**
 * 目录树不能侵占编辑器的最小交互宽度，否则顶部标签和操作会被裁切。
 */
function maxExplorerWidth(workbenchWidth: number | null): number {
  if (workbenchWidth === null) return MAX_EXPLORER_WIDTH;
  const available = workbenchWidth - WORKBENCH_SPLIT_WIDTH - MIN_EDITOR_WIDTH;
  return Math.max(MIN_EXPLORER_WIDTH, Math.min(MAX_EXPLORER_WIDTH, available));
}

function readExplorerOpen(): boolean {
  if (typeof window === "undefined") return true;
  const stored = window.localStorage.getItem(EXPLORER_OPEN_KEY);
  if (stored === "false") return false;
  if (stored === "true") return true;
  return true;
}

interface WorkbenchPanelProps {
  open: boolean;
  task: Task | null;
  projectId?: string;
  tabs: WorkbenchTab[];
  activeTab: WorkbenchTab | null;
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onOpenFile: (path: string) => void;
  onOpenArtifact: (artifact: TaskArtifact) => void;
  onAttachToChat: (entry: WorkspaceReadEntry) => void;
}

export function WorkbenchPanel({
  open,
  task,
  projectId,
  tabs,
  activeTab,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onOpenFile,
  onOpenArtifact: _onOpenArtifact,
  onAttachToChat,
}: WorkbenchPanelProps) {
  const tree = useFileTree({ taskId: task?.id, projectId });
  const [explorerOpen, setExplorerOpen] = useState(readExplorerOpen);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [workbenchBodyWidth, setWorkbenchBodyWidth] = useState<number | null>(null);
  const [explorerWidth, setExplorerWidth] = useState(() =>
    readStoredPaneSize(EXPLORER_WIDTH_KEY, DEFAULT_EXPLORER_WIDTH, MIN_EXPLORER_WIDTH, MAX_EXPLORER_WIDTH),
  );

  useEffect(() => {
    window.localStorage.setItem(EXPLORER_OPEN_KEY, String(explorerOpen));
  }, [explorerOpen]);

  useEffect(() => {
    window.localStorage.setItem(EXPLORER_WIDTH_KEY, String(explorerWidth));
  }, [explorerWidth]);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!open || !body) return;

    // 外层工作台被拖拽时，内部目录树上限也要立即随之重算。
    const observer = new ResizeObserver(([entry]) => {
      setWorkbenchBodyWidth(entry.contentRect.width);
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, [open]);

  const explorerMaxWidth = maxExplorerWidth(workbenchBodyWidth);
  const effectiveExplorerWidth = Math.min(explorerWidth, explorerMaxWidth);

  const bodyStyle = {
    "--workbench-explorer-width": `${effectiveExplorerWidth}px`,
  } as CSSProperties;

  const hasTab = activeTab != null;

  return (
    <aside
      className="workbench"
      data-open={open}
      data-explorer-open={explorerOpen}
      data-has-tab={hasTab ? "true" : "false"}
      aria-label={t("workbench.panelLabel")}
      aria-hidden={!open}
    >
      {open && (
        <div ref={bodyRef} className="workbench-body" style={bodyStyle}>
          <div className="workbench-editor" data-has-tab={hasTab ? "true" : "false"}>
            <div className="workbench-editor-toolbar">
              <EditorTabBar
                tabs={tabs}
                activeTabId={activeTabId}
                onSelect={onSelectTab}
                onClose={onCloseTab}
                onShowTree={() => setExplorerOpen(true)}
              />
              <div className="workbench-editor-toolbar-end">
                {!explorerOpen && (
                  <button
                    type="button"
                    className="workbench-toolbar-btn"
                    onClick={() => setExplorerOpen(true)}
                    aria-label={t("workbench.showTree")}
                    title={t("workbench.showTree")}
                  >
                    <IconShowTree />
                  </button>
                )}
              </div>
            </div>

            {hasTab && (
              <div className="workbench-breadcrumb">
                <div className="workbench-breadcrumb-path">
                  <BreadcrumbPath tab={activeTab} />
                </div>
              </div>
            )}

            <div className="workbench-content">
              {activeTab ? (
                <div className="workbench-viewer" role="tabpanel">
                  <FileViewer tab={activeTab} taskId={task?.id} projectId={projectId} />
                </div>
              ) : (
                <div className="workbench-empty">
                  <div className="workbench-empty-card">
                    <span className="workbench-empty-icon" aria-hidden="true">
                      <EmptyFolderIcon />
                    </span>
                    <strong className="workbench-empty-title">{t("workbench.openFileTitle")}</strong>
                    <p className="workbench-empty-desc">{t("workbench.selectFile")}</p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {explorerOpen && (
            <>
              <div
                className="workbench-split workbench-split-col"
                role="separator"
                aria-orientation="vertical"
                aria-label={t("workbench.resizeExplorer")}
                onPointerDown={(event) =>
                  startPaneResize(event, {
                    axis: "x",
                    startSize: explorerWidth,
                    min: MIN_EXPLORER_WIDTH,
                    max: explorerMaxWidth,
                    invert: true,
                    onSize: setExplorerWidth,
                  })
                }
              />
              <div className="workbench-explorer">
                <FileTree
                  tree={tree}
                  taskId={task?.id}
                  projectId={projectId}
                  selectedPath={
                    activeTab?.kind === "workspace" ? activeTab.path : null
                  }
                  onOpenFile={onOpenFile}
                  onAttachToChat={onAttachToChat}
                  onCloseExplorer={() => setExplorerOpen(false)}
                />
              </div>
            </>
          )}
        </div>
      )}
    </aside>
  );
}

function EditorTabBar({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onShowTree,
}: {
  tabs: WorkbenchTab[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onShowTree: () => void;
}) {
  if (tabs.length === 0) {
    return (
      <div className="workbench-tabbar workbench-tabbar-empty">
        <button
          type="button"
          className="workbench-open-file-pill"
          onClick={onShowTree}
          title={t("workbench.selectFile")}
        >
          <EmptyFolderIcon small />
          <span>{t("workbench.openFileTitle")}</span>
        </button>
        <button
          type="button"
          className="workbench-tab-add"
          onClick={onShowTree}
          aria-label={t("workbench.showTree")}
          title={t("workbench.showTree")}
        >
          +
        </button>
      </div>
    );
  }

  return (
    <div className="workbench-tabbar" role="tablist" aria-label={t("workbench.tabs")}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className="workbench-tab"
          data-active={tab.id === activeTabId}
          data-ext={tabExt(tab)}
          role="tab"
          tabIndex={0}
          aria-selected={tab.id === activeTabId}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect(tab.id);
            }
          }}
          title={tab.kind === "workspace" ? tab.path : tab.name}
        >
          <span className="workbench-tab-name">{tab.name}</span>
          <button
            type="button"
            className="workbench-tab-close"
            aria-label={t("action.close")}
            onClick={(event) => {
              event.stopPropagation();
              onClose(tab.id);
            }}
          >
            <IconClose />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="workbench-tab-add"
        onClick={onShowTree}
        aria-label={t("workbench.showTree")}
        title={t("workbench.showTree")}
      >
        +
      </button>
    </div>
  );
}

function BreadcrumbPath({ tab }: { tab: WorkbenchTab }) {
  if (tab.kind !== "workspace") {
    return <strong className="workbench-breadcrumb-current">{tab.name}</strong>;
  }
  const parts = tab.path.split(/[/\\]/).filter(Boolean);
  if (parts.length === 0) {
    return <strong className="workbench-breadcrumb-current">{tab.name}</strong>;
  }
  const leaf = parts[parts.length - 1]!;
  const parent = parts.length > 1 ? parts[parts.length - 2] : null;
  return (
    <>
      {parent ? (
        <>
          <span className="workbench-breadcrumb-seg" title={tab.path}>
            {parent}
          </span>
          <span className="workbench-breadcrumb-sep" aria-hidden="true">
            ›
          </span>
        </>
      ) : null}
      <strong className="workbench-breadcrumb-current" title={tab.path}>
        {leaf}
      </strong>
    </>
  );
}

function tabExt(tab: WorkbenchTab): string {
  if (tab.kind === "artifact") return "artifact";
  return tab.name.split(".").pop()?.toLowerCase() ?? "";
}

function EmptyFolderIcon({ small = false }: { small?: boolean }) {
  return <IconFolder size={small ? 14 : 40} strokeWidth={1.5} />;
}
