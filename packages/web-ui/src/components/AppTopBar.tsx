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

/** 输出栏：文档/产物图标（与工作台「分栏+文件」区分） */
function OutputRailIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true">
      {/* 背后一层：产物堆叠感 */}
      <path
        d="M6.2 4.2h6.2a1.4 1.4 0 011.4 1.4v.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        opacity={open ? 0.45 : 0.35}
      />
      {/* 主文档 */}
      <path
        d="M5 5.8h7.5a1.5 1.5 0 011.5 1.5V15a1.5 1.5 0 01-1.5 1.5H5A1.5 1.5 0 013.5 15V7.3A1.5 1.5 0 015 5.8z"
        stroke="currentColor"
        strokeWidth="1.35"
      />
      <path
        d="M6.4 9.2h5.2M6.4 11.6h5.2M6.4 14h3.4"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        opacity={open ? 1 : 0.85}
      />
    </svg>
  );
}

export function AppTopBar({
  activeView,
  currentTask,
  workbenchOpen,
  outputRailOpen,
  leftCollapsed,
  onToggleWorkbench,
  onToggleOutputRail,
  onToggleSidebar,
}: {
  activeView: MainView;
  currentTask: Task | null;
  workbenchOpen: boolean;
  /** 输出栏是否打开（与工作台互斥展示） */
  outputRailOpen?: boolean;
  leftCollapsed: boolean;
  /** 保留兼容：调用方仍可传入，顶栏不再展示状态/消息数 */
  phase?: TaskPhase | null;
  status?: TaskStatus | null;
  onToggleWorkbench: () => void;
  onToggleOutputRail?: () => void;
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
          <div className="topbar-title-group">
            <span className="topbar-title">{getMainViewTitle(activeView)}</span>
          </div>
        </div>
      )}
    </header>
  );
}
