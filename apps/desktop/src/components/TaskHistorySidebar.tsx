import { useMemo, useState } from "react";
import type { Task, Project } from "@aurevoy/shared";
import { getRelativeTime } from "./status";
import { t } from "../i18n";

type MainView = "chat" | "search" | "tools" | "settings";

interface TaskHistorySidebarProps {
  activeTaskId?: string;
  activeView: MainView;
  tasks: Task[];
  projects: Project[];
  selectedProjectId?: string;
  onNewTask: () => void;
  onSelectTask: (task: Task) => void;
  onSelectProject: (projectId: string) => void;
  onCollapse: () => void;
  onOpenSearch: () => void;
  onOpenTools: () => void;
  onOpenSettings: () => void;
  onImportProject: () => void;
  onDeleteProject: (projectId: string) => void;
  onDeleteTask: (taskId: string) => void;
}

export function TaskHistorySidebar({
  activeTaskId,
  activeView,
  tasks,
  projects,
  selectedProjectId,
  onNewTask,
  onSelectTask,
  onSelectProject,
  onCollapse,
  onOpenSearch,
  onOpenTools,
  onOpenSettings,
  onImportProject,
  onDeleteProject,
  onDeleteTask,
}: TaskHistorySidebarProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const project of projects) initial.add(project.id);
    initial.add("__standalone__");
    return initial;
  });

  // Auto-expand new projects as they appear
  const prevProjectIds = useMemo(() => new Set(projects.map((p) => p.id)), [projects]);
  useMemo(() => {
    setExpandedIds((prev) => {
      let changed = false;
      for (const id of prevProjectIds) {
        if (!prev.has(id)) { changed = true; break; }
      }
      if (!changed) return prev;
      const next = new Set(prev);
      for (const id of prevProjectIds) next.add(id);
      next.add("__standalone__");
      return next;
    });
  }, [prevProjectIds]);

  const tasksByProject = useMemo(() => {
    const map = new Map<string, Task[]>();
    const standalone: Task[] = [];
    for (const task of tasks) {
      if (task.projectId) {
        const list = map.get(task.projectId) ?? [];
        list.push(task);
        map.set(task.projectId, list);
      } else {
        standalone.push(task);
      }
    }
    return { map, standalone };
  }, [tasks]);

  // Auto-expand drawer containing the active task
  useMemo(() => {
    if (!activeTaskId) return;
    const activeTask = tasks.find((t) => t.id === activeTaskId);
    if (!activeTask) return;
    const drawerId = activeTask.projectId ?? "__standalone__";
    setExpandedIds((prev) => {
      if (prev.has(drawerId)) return prev;
      const next = new Set(prev);
      next.add(drawerId);
      return next;
    });
  }, [activeTaskId, tasks]);

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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

      <div className="sidebar-scroll">
        {tasks.length === 0 ? (
          <p className="sidebar-empty">{t("sidebar.emptyNoTasks")}</p>
        ) : (
          <div className="drawer-list">
            <button type="button" className="sidebar-action project-row drawer-import" onClick={onImportProject}>
              <PlusIcon />
              <span>{t("projects.import")}</span>
            </button>

            {projects.map((project) => {
              const projectTasks = tasksByProject.map.get(project.id) ?? [];
              const expanded = expandedIds.has(project.id);
              return (
                <div key={project.id} className="drawer-group">
                  <div className="drawer-header-row">
                    <button
                      type="button"
                      className="sidebar-action drawer-header"
                      data-expanded={expanded}
                      data-selected={selectedProjectId === project.id}
                      onClick={() => { toggleExpand(project.id); onSelectProject(project.id); }}
                      title={project.path}
                    >
                      <ChevronIcon expanded={expanded} />
                      <FolderIcon />
                      <span className="drawer-name">{project.name}</span>
                      <span className="drawer-count">{projectTasks.length}</span>
                    </button>
                    <button
                      type="button"
                      className="project-delete-btn"
                      onClick={() => onDeleteProject(project.id)}
                      title={t("projects.delete")}
                      aria-label={t("projects.delete")}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                  {expanded && (
                    <TaskList
                      tasks={projectTasks}
                      activeTaskId={activeTaskId}
                      onSelectTask={onSelectTask}
                      onDeleteTask={onDeleteTask}
                    />
                  )}
                </div>
              );
            })}

            {tasksByProject.standalone.length > 0 && (
              <div className="drawer-group">
                <button
                  type="button"
                  className="sidebar-action drawer-header"
                  data-expanded={expandedIds.has("__standalone__")}
                  onClick={() => toggleExpand("__standalone__")}
                >
                  <ChevronIcon expanded={expandedIds.has("__standalone__")} />
                  <FolderIcon />
                  <span className="drawer-name">{t("projects.standalone")}</span>
                  <span className="drawer-count">{tasksByProject.standalone.length}</span>
                </button>
                {expandedIds.has("__standalone__") && (
                  <TaskList
                    tasks={tasksByProject.standalone}
                    activeTaskId={activeTaskId}
                    onSelectTask={onSelectTask}
                    onDeleteTask={onDeleteTask}
                  />
                )}
              </div>
            )}
          </div>
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

function TaskList({
  tasks,
  activeTaskId,
  onSelectTask,
  onDeleteTask,
}: {
  tasks: Task[];
  activeTaskId?: string;
  onSelectTask: (task: Task) => void;
  onDeleteTask: (taskId: string) => void;
}) {
  if (tasks.length === 0) {
    return <p className="sidebar-empty drawer-empty">{t("sidebar.emptyNoTasks")}</p>;
  }
  return (
    <ul
      className="conv-list drawer-conv-list"
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
      {tasks.map((task) => (
        <li key={task.id} role="option" aria-selected={task.id === activeTaskId}>
          <div className="conv-item-row">
            <button
              type="button"
              className="conv-item"
              data-active={task.id === activeTaskId}
              onClick={() => onSelectTask(task)}
              title={task.goal}
            >
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
            <button
              type="button"
              className="conv-delete-btn"
              onClick={(e) => { e.stopPropagation(); onDeleteTask(task.id); }}
              title={t("sidebar.deleteTask")}
              aria-label={t("sidebar.deleteTask")}
            >
              <TrashIcon />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      className="drawer-chevron"
      data-expanded={expanded}
    >
      <path
        d="M6 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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

function PlusIcon() {
  return (
    <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
      <path
        d="M10 4v12M4 10h12"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
      <path
        d="M5 6h10l-.8 9.3a1 1 0 01-1 .7H6.8a1 1 0 01-1-.7L5 6zM8 6V4.5a1 1 0 011-1h2a1 1 0 011 1V6M3.5 6h13"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
