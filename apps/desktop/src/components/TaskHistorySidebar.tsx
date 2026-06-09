import type { Task } from "@aurevoy/shared";
import { getRelativeTime } from "./status";

type MainView = "chat" | "search" | "tools" | "memory" | "settings";

interface TaskHistorySidebarProps {
  activeTaskId?: string;
  activeView: MainView;
  tasks: Task[];
  onNewTask: () => void;
  onSelectTask: (task: Task) => void;
  onCollapse: () => void;
  onOpenSearch: () => void;
  onOpenTools: () => void;
  onOpenMemory: () => void;
  onOpenSettings: () => void;
}

export function TaskHistorySidebar({
  activeTaskId,
  activeView,
  tasks,
  onNewTask,
  onSelectTask,
  onCollapse,
  onOpenSearch,
  onOpenTools,
  onOpenMemory,
  onOpenSettings,
}: TaskHistorySidebarProps) {
  return (
    <aside className="sidebar app-sidebar" aria-label="导航与对话历史">
      <div className="sidebar-brand">
        <img className="sidebar-brand-logo" src="/aurevoy-wordmark.svg" alt="Aurevoy" />
        <button type="button" className="sidebar-collapse" onClick={onCollapse} aria-label="收起左侧栏">
          <CollapseIcon />
        </button>
      </div>

      <div className="sidebar-actions">
        <button
          type="button"
          className="sidebar-action primary"
          data-active={activeView === "chat" && !activeTaskId}
          onClick={onNewTask}
        >
          <EditIcon />
          <span>新对话</span>
        </button>
        <button
          type="button"
          className="sidebar-action"
          data-active={activeView === "search"}
          onClick={onOpenSearch}
        >
          <SearchIcon />
          <span>搜索</span>
        </button>
        <button
          type="button"
          className="sidebar-action"
          data-active={activeView === "tools"}
          onClick={onOpenTools}
        >
          <PluginIcon />
          <span>工具</span>
        </button>
        <button type="button" className="sidebar-action" disabled title="自动化尚未接入真实能力">
          <ClockIcon />
          <span>自动化</span>
        </button>
        <button type="button" className="sidebar-action" disabled title="站点尚未接入真实能力">
          <GridIcon />
          <span>站点</span>
        </button>
      </div>

      <div className="sidebar-projects">
        <p className="sidebar-section-label">项目</p>
        <button type="button" className="sidebar-action project-row" disabled>
          <FolderIcon />
          <span>Aurevoy</span>
        </button>
        <button
          type="button"
          className="sidebar-action project-row"
          data-active={activeView === "memory"}
          onClick={onOpenMemory}
        >
          <ClockIcon />
          <span>记忆</span>
        </button>
      </div>

      <div className="sidebar-scroll">
        <p className="sidebar-section-label">对话</p>
        {tasks.length === 0 ? (
          <p className="sidebar-empty">还没有对话记录</p>
        ) : (
          <ul className="conv-list">
            {tasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  className="conv-item"
                  data-active={task.id === activeTaskId}
                  onClick={() => onSelectTask(task)}
                  title={task.goal}
                >
                  <span className="conv-status-dot" data-status={task.status} aria-hidden="true" />
                  <span className="conv-copy">
                    <span className="conv-title">{task.goal}</span>
                    <span className="conv-meta">
                      <span>{task.status}</span>
                      <span>{getRelativeTime(task.updatedAt)}</span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className="sidebar-action"
          data-active={activeView === "settings"}
          onClick={onOpenSettings}
        >
          <GearIcon />
          <span>设置</span>
        </button>
      </div>
    </aside>
  );
}

function CollapseIcon() {
  return (
    <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
      <path
        d="M3.8 4.2h12.4c.9 0 1.6.7 1.6 1.6v8.4c0 .9-.7 1.6-1.6 1.6H3.8c-.9 0-1.6-.7-1.6-1.6V5.8c0-.9.7-1.6 1.6-1.6zM7.4 4.5v11M13 7.2l-2.8 2.8 2.8 2.8"
        stroke="currentColor"
        strokeWidth="1.35"
        fill="none"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
      <path
        d="M4 14.5l-.6 2.6 2.6-.6L16 6.5a1.5 1.5 0 00-2.1-2.1L4 14.5z"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
      <circle cx="9" cy="9" r="5" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M13 13l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function PluginIcon() {
  return (
    <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
      <rect x="3.5" y="3.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <rect x="11.5" y="3.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <rect x="3.5" y="11.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <rect x="11.5" y="11.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" fill="none" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
      <path
        d="M4 4h6v6H4zM12 4h4v4h-4zM4 12h4v4H4zM10 12h6v4h-6z"
        stroke="currentColor"
        strokeWidth="1.35"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
      <path
        d="M3 6.2c0-.8.6-1.4 1.4-1.4h3.1l1.3 1.5h5.8c.8 0 1.4.6 1.4 1.4v6.1c0 .8-.6 1.4-1.4 1.4H4.4c-.8 0-1.4-.6-1.4-1.4V6.2z"
        stroke="currentColor"
        strokeWidth="1.35"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
      <circle cx="10" cy="10" r="6.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <path d="M10 6.5V10l2.5 1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <path
        d="M10 2.8v2.2M10 15v2.2M17.2 10H15M5 10H2.8M15.1 4.9l-1.6 1.6M6.5 13.5l-1.6 1.6M15.1 15.1l-1.6-1.6M6.5 6.5L4.9 4.9"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
