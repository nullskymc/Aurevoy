import { useMemo, useState } from "react";
import type { Task, TaskStatus } from "@aurevoy/shared";
import { getRelativeTime } from "./status";
import { t } from "../i18n";

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
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">("all");
  const visibleTasks = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter((task) => {
      const matchesQuery = !q || task.goal.toLowerCase().includes(q);
      const matchesStatus = statusFilter === "all" || task.status === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [query, statusFilter, tasks]);

  return (
    <aside className="sidebar app-sidebar" aria-label={t("sidebar.label")}>
      <div className="sidebar-brand">
        <img className="sidebar-brand-logo" src="/aurevoy-wordmark.svg" alt="Aurevoy" />
        <button type="button" className="sidebar-collapse" onClick={onCollapse} aria-label={t("nav.collapse")}>
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
          <span>{t("nav.newChat")}</span>
        </button>
        <button
          type="button"
          className="sidebar-action"
          data-active={activeView === "search"}
          onClick={onOpenSearch}
        >
          <SearchIcon />
          <span>{t("nav.search")}</span>
        </button>
        <button
          type="button"
          className="sidebar-action"
          data-active={activeView === "tools"}
          onClick={onOpenTools}
        >
          <PluginIcon />
          <span>{t("nav.tools")}</span>
        </button>
        <button type="button" className="sidebar-action" disabled title={t("nav.automationDisabled")}>
          <ClockIcon />
          <span>{t("nav.automation")}</span>
        </button>
        <button type="button" className="sidebar-action" disabled title={t("nav.sitesDisabled")}>
          <GridIcon />
          <span>{t("nav.sites")}</span>
        </button>
      </div>

      <div className="sidebar-projects">
        <p className="sidebar-section-label">{t("nav.projects")}</p>
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
          <span>{t("nav.memory")}</span>
        </button>
      </div>

      <div className="sidebar-scroll">
        <p className="sidebar-section-label">{t("nav.conversations")}</p>
        <div className="history-filter">
          <label>
            <span className="sr-only">{t("sidebar.searchConversations")}</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("sidebar.searchPlaceholder")}
            />
          </label>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as TaskStatus | "all")}
            aria-label={t("sidebar.filterByStatus")}
          >
            <option value="all">{t("filter.all")}</option>
            <option value="running">{t("filter.running")}</option>
            <option value="paused">{t("filter.paused")}</option>
            <option value="completed">{t("filter.completed")}</option>
            <option value="failed">{t("filter.failed")}</option>
            <option value="cancelled">{t("filter.cancelled")}</option>
          </select>
        </div>
        {tasks.length === 0 ? (
          <p className="sidebar-empty">{t("sidebar.emptyNoTasks")}</p>
        ) : visibleTasks.length === 0 ? (
          <p className="sidebar-empty">{t("sidebar.emptyNoMatch")}</p>
        ) : (
          <ul
            className="conv-list"
            role="listbox"
            aria-label={t("sidebar.listLabel")}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(".conv-item"),
              );
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              if (index === -1) return;
              if (event.key === "ArrowDown" && index < items.length - 1) {
                event.preventDefault();
                items[index + 1].focus();
              } else if (event.key === "ArrowUp" && index > 0) {
                event.preventDefault();
                items[index - 1].focus();
              }
            }}
          >
            {visibleTasks.map((task) => (
              <li key={task.id} role="option" aria-selected={task.id === activeTaskId}>
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
                    {(task.artifacts?.length || task.budgetUsage?.toolCalls) ? (
                      <span className="conv-summary">
                        {task.artifacts?.length ? (
                          <span className="conv-summary-chip">📄 {task.artifacts.length} {t("sidebar.unitArtifacts")}</span>
                        ) : null}
                        {task.budgetUsage?.toolCalls ? (
                          <span className="conv-summary-chip">⚙ {task.budgetUsage.toolCalls} {t("sidebar.unitTools")}</span>
                        ) : null}
                      </span>
                    ) : null}
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
          <span>{t("nav.settings")}</span>
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
