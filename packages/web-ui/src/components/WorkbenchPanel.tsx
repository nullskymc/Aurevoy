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
const DEFAULT_EXPLORER_WIDTH = 220;

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

  return (
    <aside
      className="workbench"
      data-open={open}
      data-explorer-open={explorerOpen}
      aria-label={t("workbench.panelLabel")}
      aria-hidden={!open}
    >
      {open && (
        <div className="workbench-body" style={bodyStyle}>
          <div className="workbench-editor">
            <div className="workbench-editor-toolbar">
              <EditorTabBar
                tabs={tabs}
                activeTabId={activeTabId}
                onSelect={onSelectTab}
                onClose={onCloseTab}
              />
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

            <div className="workbench-breadcrumb">
              <span>Aurevoy</span>
              {activeTab ? (
                <>
                  <span aria-hidden="true">›</span>
                  <strong title={activeTab.kind === "workspace" ? activeTab.path : activeTab.name}>
                    {activeTab.kind === "workspace" ? activeTab.path : activeTab.name}
                  </strong>
                </>
              ) : null}
            </div>

            <div className="workbench-content">
              {activeTab ? (
                <div className="workbench-viewer" role="tabpanel">
                  <FileViewer tab={activeTab} taskId={task?.id} projectId={projectId} />
                </div>
              ) : (
                <div className="workbench-empty">{t("workbench.selectFile")}</div>
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
}: {
  tabs: WorkbenchTab[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
}) {
  if (tabs.length === 0) {
    return <div className="workbench-tabbar workbench-tabbar-empty">{t("workbench.noOpenTabs")}</div>;
  }

  return (
    <div className="workbench-tabbar" role="tablist" aria-label={t("workbench.tabs")}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className="workbench-tab"
          data-active={tab.id === activeTabId}
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
          <span className="workbench-tab-icon" aria-hidden="true">
            {iconForTab(tab)}
          </span>
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
    </div>
  );
}

function iconForTab(tab: WorkbenchTab): string {
  if (tab.kind === "artifact") return "◇";
  const ext = tab.name.split(".").pop()?.toLowerCase();
  if (ext === "md" || ext === "mdx") return "M";
  if (ext === "json" || ext === "yml" || ext === "yaml") return "{}";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext ?? "")) return "▧";
  return "□";
}
