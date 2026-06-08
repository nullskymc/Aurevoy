import type { Task } from "@aurevoy/shared";
import { getRelativeTime } from "./status";

interface TaskHistorySidebarProps {
  activeTaskId?: string;
  tasks: Task[];
  onNewTask: () => void;
  onSelectTask: (task: Task) => void;
  onOpenInspector: () => void;
  onOpenMemory: () => void;
}

export function TaskHistorySidebar({
  activeTaskId,
  tasks,
  onNewTask,
  onSelectTask,
  onOpenInspector,
  onOpenMemory,
}: TaskHistorySidebarProps) {
  return (
    <aside className="sidebar" aria-label="导航与对话历史">
      <div className="sidebar-brand">
        <img className="sidebar-brand-logo" src="/aurevoy-wordmark.svg" alt="Aurevoy" />
      </div>

      <div className="sidebar-actions">
        <button type="button" className="sidebar-action primary" onClick={onNewTask}>
          <EditIcon />
          <span>新对话</span>
        </button>
        <button type="button" className="sidebar-action" disabled title="即将推出">
          <SearchIcon />
          <span>搜索</span>
        </button>
        <button type="button" className="sidebar-action" onClick={onOpenInspector}>
          <PluginIcon />
          <span>工具</span>
        </button>
        <button type="button" className="sidebar-action" onClick={onOpenMemory}>
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
                  <span className="conv-title">{task.goal}</span>
                  <span className="conv-time">{getRelativeTime(task.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="sidebar-footer">
        <button type="button" className="sidebar-action" disabled title="即将推出">
          <GearIcon />
          <span>设置</span>
        </button>
      </div>
    </aside>
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
