import type { MainView } from "../app/types";
import { t } from "../i18n";
import { getPhaseLabel, getStatusLabel } from "./status";
import type { Task, TaskPhase, TaskStatus } from "@aurevoy/shared";

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

function PanelFilesIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <path
        d="M2 5.5h6L9.5 4h6.5c.6 0 1 .4 1 1v10c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1V5.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <line x1="2" y1="14.5" x2="18" y2="14.5" stroke="currentColor" strokeWidth="1.3" />
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
  inspectorOpen,
  leftCollapsed,
  phase,
  status,
  onToggleInspector,
  onToggleSidebar,
}: {
  activeView: MainView;
  currentTask: Task | null;
  inspectorOpen: boolean;
  leftCollapsed: boolean;
  phase: TaskPhase | null;
  status: TaskStatus | null;
  onToggleInspector: () => void;
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
          <div className="topbar-context">
            <div className="topbar-title-group">
              <span className="topbar-title">{currentTask.goal}</span>
              <span className="topbar-subtitle">
                {status === "completed" || status === "failed" || status === "cancelled"
                  ? getStatusLabel(status)
                  : getPhaseLabel(phase) || getStatusLabel(status)}{" "}
                · {currentTask.messages.length} 条消息
              </span>
            </div>
          </div>
          <div className="topbar-actions">
            <button
              type="button"
              className="icon-btn"
              aria-label={inspectorOpen ? t("rightPanel.hide") : t("rightPanel.show")}
              onClick={onToggleInspector}
            >
              <PanelFilesIcon />
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
              aria-label={inspectorOpen ? t("rightPanel.hide") : t("rightPanel.show")}
              onClick={onToggleInspector}
            >
              <PanelFilesIcon />
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
