import { useEffect, useState, type CSSProperties } from "react";
import type { Task, TaskArtifact, WorkspaceReadEntry } from "@aurevoy/shared";
import { readStoredPaneSize, startPaneResize } from "../app/paneResize";
import { useFileTree } from "../hooks/useFileTree";
import type { WorkbenchTab } from "../hooks/useWorkbenchTabs";
import { FileTree } from "./FileTree";
import { FileViewer } from "./FileViewer";
import { IconClose, IconShowTree } from "./workbenchIcons";
import { t } from "../i18n";
import "./WorkbenchPanel.css";

const EXPLORER_OPEN_KEY = "aurevoy.workbenchExplorerOpen";
const EXPLORER_WIDTH_KEY = "aurevoy.workbenchExplorerWidth";
const MIN_EXPLORER_WIDTH = 160;
const MAX_EXPLORER_WIDTH = 420;
const DEFAULT_EXPLORER_WIDTH = 260;

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
  onOpenArtifact,
  onAttachToChat,
}: WorkbenchPanelProps) {
  const tree = useFileTree({ taskId: task?.id, projectId });
  const artifacts = task?.artifacts ?? [];
  const [explorerOpen, setExplorerOpen] = useState(readExplorerOpen);
  const [explorerWidth, setExplorerWidth] = useState(() =>
    readStoredPaneSize(EXPLORER_WIDTH_KEY, DEFAULT_EXPLORER_WIDTH, MIN_EXPLORER_WIDTH, MAX_EXPLORER_WIDTH),
  );

  useEffect(() => {
    window.localStorage.setItem(EXPLORER_OPEN_KEY, String(explorerOpen));
  }, [explorerOpen]);

  useEffect(() => {
    window.localStorage.setItem(EXPLORER_WIDTH_KEY, String(explorerWidth));
  }, [explorerWidth]);

  const bodyStyle = {
    "--workbench-explorer-width": `${explorerWidth}px`,
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
        <div className="workbench-body" style={bodyStyle}>
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
                    max: MAX_EXPLORER_WIDTH,
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
                  artifacts={artifacts}
                  selectedPath={
                    activeTab?.kind === "workspace" ? activeTab.path : null
                  }
                  onOpenFile={onOpenFile}
                  onOpenArtifact={onOpenArtifact}
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
  const size = small ? 14 : 40;
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} fill="none" aria-hidden="true">
      <path
        d="M8 14.5h12.2l3 3.2H40a2 2 0 012 2V34a2 2 0 01-2 2H8a2 2 0 01-2-2V16.5a2 2 0 012-2z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
