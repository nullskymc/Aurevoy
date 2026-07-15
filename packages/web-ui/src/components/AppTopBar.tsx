import type { MainView } from "../app/types";
import { t } from "../i18n";
import { IconWorkbench } from "./workbenchIcons";
import type { Task, TaskPhase, TaskStatus } from "@aurevoy/shared";
import { taskDisplayTitle } from "@aurevoy/shared";

function SidebarIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <path
        d="M3.8 4.2h12.4c.9 0 1.6.7 1.6 1.6v8.4c0 .9-.7 1.6-1.6 1.6H3.8c-.9 0-1.6-.7-1.6-1.6V5.8c0-.9.7-1.6 1.6-1.6zM7.4 4.5v11"
        stroke="currentColor"
        strokeWidth="1.35"
        fill="none"
        strokeLinejoin="round"
      />
      {collapsed ? (
        <path d="M10 7.2l2.8 2.8-2.8 2.8" stroke="currentColor" strokeWidth="1.35" fill="none" strokeLinejoin="round" strokeLinecap="round" />
      ) : (
        <path d="M13 7.2l-2.8 2.8 2.8 2.8" stroke="currentColor" strokeWidth="1.35" fill="none" strokeLinejoin="round" strokeLinecap="round" />
      )}
    </svg>
  );
}



function getMainViewTitle(view: MainView): string {
  if (view === "search") return t("nav.search");
  if (view === "skills") return t("nav.skills");
  if (view === "settings") return t("nav.settings");
  return t("nav.conversations");
}

export function AppTopBar({
  activeView,
  currentTask,
  workbenchOpen,
  leftCollapsed,
  onToggleWorkbench,
  onToggleSidebar,
}: {
  activeView: MainView;
  currentTask: Task | null;
  workbenchOpen: boolean;
  leftCollapsed: boolean;
  /** 保留兼容：调用方仍可传入，顶栏不再展示状态/消息数 */
  phase?: TaskPhase | null;
  status?: TaskStatus | null;
  onToggleWorkbench: () => void;
  onToggleSidebar: () => void;
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
          <div className="topbar-title-group">
            <span className="topbar-title">{getMainViewTitle(activeView)}</span>
          </div>
        </div>
      )}
    </header>
  );
}
