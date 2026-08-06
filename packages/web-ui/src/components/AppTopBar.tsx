import type { MainView } from "../app/types";
import { t } from "../i18n";
import { IconWorkbench } from "./workbenchIcons";
import type { Task, TaskPhase, TaskStatus } from "@aurevoy/shared";
import { taskDisplayTitle } from "@aurevoy/shared";
import { IconFile, IconFork, IconGauge, IconPanelLeftClose, IconPanelLeftOpen } from "../icons";

function SidebarIcon({ collapsed }: { collapsed: boolean }) {
  return collapsed ? <IconPanelLeftOpen size={18} /> : <IconPanelLeftClose size={18} />;
}

function getMainViewTitle(view: MainView): string {
  if (view === "skills") return t("nav.skills");
  if (view === "automations") return t("nav.automations");
  if (view === "settings") return t("nav.settings");
  return t("nav.conversations");
}

/** 输出栏：文档/产物图标（与工作台「分栏+文件」区分） */
function OutputRailIcon({ open }: { open: boolean }) {
  return <IconFile size={18} strokeWidth={open ? 2 : 1.75} />;
}

export function AppTopBar({
  activeView,
  currentTask,
  workbenchOpen,
  outputRailOpen,
  sessionTreeOpen,
  tracePanelOpen,
  leftCollapsed,
  onToggleWorkbench,
  onToggleOutputRail,
  onToggleSessionTree,
  onToggleTracePanel,
  onToggleSidebar,
  onBackToChat,
}: {
  activeView: MainView;
  currentTask: Task | null;
  workbenchOpen: boolean;
  /** 输出栏是否打开（与工作台互斥展示） */
  outputRailOpen?: boolean;
  sessionTreeOpen?: boolean;
  tracePanelOpen?: boolean;
  leftCollapsed: boolean;
  /** 保留兼容：调用方仍可传入，顶栏不再展示状态/消息数 */
  phase?: TaskPhase | null;
  status?: TaskStatus | null;
  onToggleWorkbench: () => void;
  onToggleOutputRail?: () => void;
  onToggleSessionTree?: () => void;
  onToggleTracePanel?: () => void;
  onToggleSidebar: () => void;
  onBackToChat?: () => void;
}) {
  const isChatView = activeView === "chat";
  const showConversation = currentTask !== null;

  return (
    <header className="topbar window-drag-region" data-tauri-drag-region>
      <div className="topbar-left-tools">
        <button
          type="button"
          className="icon-btn sidebar-toggle-btn"
          onClick={onToggleSidebar}
          aria-label={leftCollapsed ? t("nav.expand") : t("nav.collapse")}
        >
          <SidebarIcon collapsed={leftCollapsed} />
        </button>
      </div>
      {isChatView && showConversation ? (
        <>
          <div className="topbar-context topbar-context--conversation">
            <h1 className="topbar-conversation-title" title={currentTask.goal}>
              {taskDisplayTitle(currentTask)}
            </h1>
          </div>
          <div className="topbar-actions">
            {onToggleSessionTree && (
              <button
                type="button"
                className="icon-btn"
                data-active={sessionTreeOpen ? "true" : undefined}
                aria-label={sessionTreeOpen ? t("sessionTree.hide") : t("sessionTree.show")}
                title={sessionTreeOpen ? t("sessionTree.hide") : t("sessionTree.show")}
                onClick={onToggleSessionTree}
              >
                <IconFork size={18} />
              </button>
            )}
            {onToggleTracePanel && (
              <button
                type="button"
                className="icon-btn"
                data-active={tracePanelOpen ? "true" : undefined}
                aria-label={tracePanelOpen ? t("trace.hide") : t("trace.show")}
                title={tracePanelOpen ? t("trace.hide") : t("trace.show")}
                onClick={onToggleTracePanel}
              >
                <IconGauge size={18} />
              </button>
            )}
            {onToggleOutputRail && !workbenchOpen && (
              <button
                type="button"
                className="icon-btn"
                data-active={outputRailOpen ? "true" : undefined}
                aria-label={outputRailOpen ? t("output.hide") : t("output.show")}
                title={outputRailOpen ? t("output.hide") : t("output.show")}
                onClick={onToggleOutputRail}
              >
                <OutputRailIcon open={!!outputRailOpen} />
              </button>
            )}
            <button
              type="button"
              className="icon-btn"
              aria-label={workbenchOpen ? t("workbench.hide") : t("workbench.show")}
              onClick={onToggleWorkbench}
            >
              <IconWorkbench />
            </button>
          </div>
        </>
      ) : isChatView ? (
        <>
          <div className="topbar-context">
            <span className="topbar-kicker">Aurevoy Agent</span>
          </div>
          <div className="topbar-actions">
            <button
              type="button"
              className="icon-btn"
              aria-label={workbenchOpen ? t("workbench.hide") : t("workbench.show")}
              onClick={onToggleWorkbench}
            >
              <IconWorkbench />
            </button>
          </div>
        </>
      ) : (
        <div className="topbar-context">
          {onBackToChat ? (
            <button type="button" className="topbar-back-btn" onClick={onBackToChat}>
              ← {t("common.backToChat")}
            </button>
          ) : null}
          <div className="topbar-title-group">
            <span className="topbar-title">{getMainViewTitle(activeView)}</span>
          </div>
        </div>
      )}
    </header>
  );
}
