import { useCallback, useMemo, useState } from "react";
import type { Task, Project } from "@aurevoy/shared";
import { getRelativeTime, getStatusLabel } from "./status";
import { t } from "../i18n";
import { usePlatform } from "../platform/context";
import { ContextMenu } from "./ContextMenu";
import type { ContextMenuItem } from "./ContextMenu";
import {
  buildFileMenuItems,
  contextMenuPoint,
  copyTextItem,
  type ContextMenuState,
} from "./contextMenuActions";
import "./TaskHistorySidebar.css";

type MainView = "chat" | "search" | "skills" | "settings";

interface TaskHistorySidebarProps {
  activeTaskId?: string;
  activeView: MainView;
  tasks: Task[];
  projects: Project[];
  selectedProjectId?: string;
  onNewTask: (projectId?: string) => void;
  onSelectTask: (task: Task) => void;
  onSelectProject: (projectId: string) => void;
  onOpenSearch: () => void;
  onOpenSkills: () => void;
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
  onOpenSearch,
  onOpenSkills,
  onOpenSettings,
  onImportProject,
  onDeleteProject,
  onDeleteTask,
}: TaskHistorySidebarProps) {
  const platform = usePlatform();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const project of projects) initial.add(project.id);
    initial.add("__standalone__");
    return initial;
  });

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>({ open: false, items: [] });

  const closeCtxMenu = useCallback(() => {
    setCtxMenu((prev) => ({ ...prev, open: false }));
  }, []);

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

  function handleProjectContextMenu(
    e: React.MouseEvent,
    project: Project,
  ) {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = [
      {
        type: "item",
        id: "new-conversation",
        label: t("nav.newChat"),
        icon: <PlusIcon />,
        action: () => onNewTask(project.id),
      },
      { type: "separator" },
      ...buildFileMenuItems({
        path: project.path,
        name: project.name,
        platform,
        openLabel: "用默认 App 打开项目",
        revealLabel: "在 Finder 中显示项目",
      }),
      { type: "separator" },
      {
        type: "item",
        id: "delete-project",
        label: t("projects.delete"),
        icon: <TrashIcon />,
        danger: true,
        action: () => onDeleteProject(project.id),
      },
    ];
    setCtxMenu({
      open: true,
      point: contextMenuPoint(e),
      items,
    });
  }

  function handleTaskContextMenu(
    e: React.MouseEvent,
    task: Task,
  ) {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = [
      {
        type: "item",
        id: "select-task",
        label: "选择对话",
        icon: <ChatIcon />,
        action: () => onSelectTask(task),
      },
      copyTextItem("copy-task-title", "复制标题", task.goal),
      copyTextItem("copy-task-id", "复制对话 ID", task.id),
      { type: "separator" },
      {
        type: "item",
        id: "delete-task",
        label: t("sidebar.deleteTask"),
        icon: <TrashIcon />,
        danger: true,
        action: () => onDeleteTask(task.id),
      },
    ];
    setCtxMenu({
      open: true,
      point: contextMenuPoint(e),
      items,
    });
  }

  return (
    <aside className="sidebar app-sidebar" aria-label={t("sidebar.label")}>
      <div className="window-drag-strip window-drag-region" data-tauri-drag-region aria-hidden="true" />
      <div className="sidebar-brand" >
        <img className="sidebar-brand-logo" src="/aurevoy-wordmark.svg" alt="Aurevoy" />
      </div>

      <div className="sidebar-actions">
        <button
          type="button"
          className="sidebar-action primary new-chat-btn"
          data-active={activeView === "chat" && !activeTaskId}
          onClick={() => onNewTask()}
        >
          <PlusIcon />
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
          data-active={activeView === "skills"}
          onClick={onOpenSkills}
        >
          <PluginIcon />
          <span>{t("nav.skills")}</span>
        </button>
      </div>

      <div className="sidebar-scroll">
        <div className="drawer-list">
          {/* 项目标头 */}
          <div className="sidebar-section-divider">
            <span className="section-line-short" />
            <span className="section-title">{t("nav.projects")}</span>
            <span className="section-line-long" />
            <button
              type="button"
              className="section-action-btn"
              onClick={onImportProject}
              title={t("projects.import")}
              aria-label={t("projects.import")}
            >
              <PlusIcon />
            </button>
          </div>

          {projects.map((project) => {
            const projectTasks = tasksByProject.map.get(project.id) ?? [];
            const expanded = expandedIds.has(project.id);
            return (
              <div key={project.id} className="drawer-group">
                <div className="drawer-header-row" onContextMenu={(e) => handleProjectContextMenu(e, project)}>
                  <button
                    type="button"
                    className="sidebar-action drawer-header"
                    data-expanded={expanded}
                    data-selected={selectedProjectId === project.id}
                    onClick={() => { toggleExpand(project.id); onSelectProject(project.id); }}
                    title={project.path}
                  >
                    <FolderIcon />
                    <span className="drawer-name">{project.name}</span>
                    {projectTasks.length > 0 && (
                      <span className="drawer-count">{projectTasks.length}</span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="project-new-chat-btn"
                    onClick={(e) => { e.stopPropagation(); onNewTask(project.id); }}
                    title={t("nav.newChat")}
                    aria-label={t("nav.newChat")}
                  >
                    <PlusIcon />
                  </button>
                  <button
                    type="button"
                    className="project-delete-btn"
                    onClick={(e) => { e.stopPropagation(); onDeleteProject(project.id); }}
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
                    onContextMenuTask={handleTaskContextMenu}
                    isChild={true}
                  />
                )}
              </div>
            );
          })}

          {/* 独立对话标头 */}
          <div className="sidebar-section-divider">
            <span className="section-line-short" />
            <span className="section-title">{t("nav.conversations")}</span>
            <span className="section-line-long" />
            <button
              type="button"
              className="section-action-btn"
              onClick={() => onNewTask()}
              title={t("nav.newChat")}
              aria-label={t("nav.newChat")}
            >
              <PlusIcon />
            </button>
          </div>

          {tasksByProject.standalone.length === 0 ? (
            <p className="sidebar-empty">{t("sidebar.emptyNoTasks")}</p>
          ) : (
            <TaskList
              tasks={tasksByProject.standalone}
              activeTaskId={activeTaskId}
              onSelectTask={onSelectTask}
              onDeleteTask={onDeleteTask}
              onContextMenuTask={handleTaskContextMenu}
            />
          )}
        </div>
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className="sidebar-action"
          data-active={activeView === "settings"}
          onClick={() => onOpenSettings()}
        >
          <GearIcon />
          <span>{t("nav.settings")}</span>
        </button>
      </div>

      <ContextMenu
        items={ctxMenu.items}
        open={ctxMenu.open}
        anchorPoint={ctxMenu.point}
        onClose={closeCtxMenu}
      />
    </aside>
  );
}

function TaskList({
  tasks,
  activeTaskId,
  onSelectTask,
  onDeleteTask,
  onContextMenuTask,
  isChild = false,
}: {
  tasks: Task[];
  activeTaskId?: string;
  onSelectTask: (task: Task) => void;
  onDeleteTask: (taskId: string) => void;
  onContextMenuTask?: (e: React.MouseEvent, task: Task) => void;
  isChild?: boolean;
}) {
  if (tasks.length === 0) {
    return <p className="sidebar-empty drawer-empty">{t("sidebar.emptyNoTasks")}</p>;
  }
  return (
    <ul
      className={`conv-list ${isChild ? "child-chat-list" : "drawer-conv-list"}`}
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
          <div
            className={`conv-item-row ${isChild ? "child-chat-item-row" : ""}`}
            onContextMenu={
              onContextMenuTask
                ? (e) => onContextMenuTask(e, task)
                : undefined
            }
          >
            <button
              type="button"
              className={`conv-item ${isChild ? "child-chat-item" : ""}`}
              data-active={task.id === activeTaskId}
              onClick={() => onSelectTask(task)}
              title={task.goal}
            >
              <ChatIcon />
              <span className="conv-copy">
                <span className="conv-title">{task.goal}</span>
                {!isChild && (task.artifacts?.length || task.budgetUsage?.toolCalls) ? (
                  <span className="conv-summary">
                    {task.artifacts?.length ? (
                      <span className="conv-summary-chip">📄 {task.artifacts.length} {t("sidebar.unitArtifacts")}</span>
                    ) : null}
                    {task.budgetUsage?.toolCalls ? (
                      <span className="conv-summary-chip">⚙ {task.budgetUsage.toolCalls} {t("sidebar.unitTools")}</span>
                    ) : null}
                  </span>
                ) : null}
                {!isChild && (
                  <span className="conv-meta">
                    <span>{getStatusLabel(task.status)}</span>
                    <span>{getRelativeTime(task.updatedAt)}</span>
                  </span>
                )}
              </span>
            </button>
            <button
              type="button"
              className="conv-delete-btn"
              onClick={(event) => {
                event.stopPropagation();
                onDeleteTask(task.id);
              }}
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

function ChatIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" className="conv-icon-svg">
      <path
        d="M3.5 5.5v7c0 .8.6 1.4 1.4 1.4h9.2l3.2 2.6V5.5c0-.8-.6-1.4-1.4-1.4H4.9c-.8 0-1.4.6-1.4 1.4z"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
