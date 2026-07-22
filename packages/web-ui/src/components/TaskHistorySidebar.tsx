import { useCallback, useEffect, useMemo, useState } from "react";
import type { TaskSummary, Project } from "@aurevoy/shared";
import { taskDisplayTitle } from "@aurevoy/shared";
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
import {
  IconChat,
  IconChevron,
  IconFolder,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSkills,
  IconTrash,
} from "./shellIcons";
import "./TaskHistorySidebar.css";

type MainView = "chat" | "search" | "skills" | "settings";

interface TaskHistorySidebarProps {
  activeTaskId?: string;
  activeView: MainView;
  tasks: TaskSummary[];
  projects: Project[];
  selectedProjectId?: string;
  onNewTask: (projectId?: string) => void;
  onSelectTask: (task: TaskSummary) => void;
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
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>({ open: false, items: [] });

  const closeCtxMenu = useCallback(() => {
    setCtxMenu((prev) => ({ ...prev, open: false }));
  }, []);

  const projectIds = useMemo(() => projects.map((p) => p.id).join(","), [projects]);

  // Expand newly imported projects.
  useEffect(() => {
    setExpandedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const project of projects) {
        if (!next.has(project.id)) {
          next.add(project.id);
          changed = true;
        }
      }
      if (!next.has("__standalone__")) {
        next.add("__standalone__");
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [projectIds, projects]);

  const tasksByProject = useMemo(() => {
    const map = new Map<string, TaskSummary[]>();
    const standalone: TaskSummary[] = [];
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

  // Keep the drawer containing the active task open.
  useEffect(() => {
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

  function handleProjectContextMenu(e: React.MouseEvent, project: Project) {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = [
      {
        type: "item",
        id: "new-conversation",
        label: t("nav.newChat"),
        icon: <IconPlus size={14} />,
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
        icon: <IconTrash />,
        danger: true,
        action: () => onDeleteProject(project.id),
      },
    ];
    setCtxMenu({ open: true, point: contextMenuPoint(e), items });
  }

  function handleTaskContextMenu(e: React.MouseEvent, task: TaskSummary) {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = [
      {
        type: "item",
        id: "select-task",
        label: "选择对话",
        icon: <IconChat size={14} />,
        action: () => onSelectTask(task),
      },
      copyTextItem("copy-task-title", "复制标题", taskDisplayTitle(task)),
      copyTextItem("copy-task-id", "复制对话 ID", task.id),
      { type: "separator" },
      {
        type: "item",
        id: "delete-task",
        label: t("sidebar.deleteTask"),
        icon: <IconTrash />,
        danger: true,
        action: () => onDeleteTask(task.id),
      },
    ];
    setCtxMenu({ open: true, point: contextMenuPoint(e), items });
  }

  return (
    <aside className="sidebar app-sidebar" aria-label={t("sidebar.label")}>
      <div className="window-drag-strip window-drag-region" data-tauri-drag-region aria-hidden="true" />

      <div className="sidebar-brand">
        <img className="sidebar-brand-logo" src="/aurevoy-wordmark.svg" alt="Aurevoy" />
      </div>

      <nav className="sidebar-nav" aria-label={t("sidebar.label")}>
        <button
          type="button"
          className="sidebar-action"
          data-active={activeView === "chat" && !activeTaskId}
          onClick={() => onNewTask()}
        >
          <IconPlus />
          <span>{t("nav.newChat")}</span>
        </button>
        <button
          type="button"
          className="sidebar-action"
          data-active={activeView === "search"}
          onClick={onOpenSearch}
        >
          <IconSearch />
          <span>{t("nav.search")}</span>
        </button>
        <button
          type="button"
          className="sidebar-action"
          data-active={activeView === "skills"}
          onClick={onOpenSkills}
        >
          <IconSkills />
          <span>{t("nav.skills")}</span>
        </button>
      </nav>

      <div className="sidebar-scroll">
        <section className="sidebar-section">
          <header className="sidebar-section-head">
            <h2 className="sidebar-section-title">{t("nav.projects")}</h2>
            <button
              type="button"
              className="sidebar-icon-btn"
              onClick={onImportProject}
              title={t("projects.import")}
              aria-label={t("projects.import")}
            >
              <IconPlus size={14} />
            </button>
          </header>

          <div className="drawer-list">
            {projects.map((project) => {
              const projectTasks = tasksByProject.map.get(project.id) ?? [];
              const expanded = expandedIds.has(project.id);
              return (
                <div key={project.id} className="drawer-group">
                  <div
                    className="drawer-header-row"
                    data-selected={selectedProjectId === project.id}
                    onContextMenu={(e) => handleProjectContextMenu(e, project)}
                  >
                    <button
                      type="button"
                      className="drawer-header"
                      data-expanded={expanded}
                      data-selected={selectedProjectId === project.id}
                      onClick={() => {
                        toggleExpand(project.id);
                        onSelectProject(project.id);
                      }}
                      title={project.path}
                    >
                      <IconChevron open={expanded} className="drawer-chevron" />
                      <IconFolder />
                      <span className="drawer-name">{project.name}</span>
                      {projectTasks.length > 0 && (
                        <span className="drawer-count">{projectTasks.length}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="sidebar-icon-btn drawer-action"
                      onClick={(e) => {
                        e.stopPropagation();
                        onNewTask(project.id);
                      }}
                      title={t("nav.newChat")}
                      aria-label={t("nav.newChat")}
                    >
                      <IconPlus size={14} />
                    </button>
                    <button
                      type="button"
                      className="sidebar-icon-btn drawer-action is-danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteProject(project.id);
                      }}
                      title={t("projects.delete")}
                      aria-label={t("projects.delete")}
                    >
                      <IconTrash />
                    </button>
                  </div>
                  {expanded && (
                    <TaskList
                      tasks={projectTasks}
                      activeTaskId={activeTaskId}
                      onSelectTask={onSelectTask}
                      onDeleteTask={onDeleteTask}
                      onContextMenuTask={handleTaskContextMenu}
                      nested
                    />
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section className="sidebar-section">
          <header className="sidebar-section-head">
            <h2 className="sidebar-section-title">{t("nav.conversations")}</h2>
            <button
              type="button"
              className="sidebar-icon-btn"
              onClick={() => onNewTask()}
              title={t("nav.newChat")}
              aria-label={t("nav.newChat")}
            >
              <IconPlus size={14} />
            </button>
          </header>

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
        </section>
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className="sidebar-action"
          data-active={activeView === "settings"}
          onClick={() => onOpenSettings()}
        >
          <IconSettings />
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
  nested = false,
}: {
  tasks: TaskSummary[];
  activeTaskId?: string;
  onSelectTask: (task: TaskSummary) => void;
  onDeleteTask: (taskId: string) => void;
  onContextMenuTask?: (e: React.MouseEvent, task: TaskSummary) => void;
  nested?: boolean;
}) {
  if (tasks.length === 0) {
    return <p className="sidebar-empty drawer-empty">{t("sidebar.emptyNoTasks")}</p>;
  }

  return (
    <ul
      className={nested ? "conv-list is-nested" : "conv-list"}
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
            className="conv-item-row"
            onContextMenu={
              onContextMenuTask ? (e) => onContextMenuTask(e, task) : undefined
            }
          >
            <button
              type="button"
              className="conv-item"
              data-active={task.id === activeTaskId}
              onClick={() => onSelectTask(task)}
              title={task.goal}
            >
              <IconChat size={14} />
              <span className="conv-copy">
                <span className="conv-title">{taskDisplayTitle(task)}</span>
                {!nested && (
                  <span className="conv-meta">
                    <span className="conv-status">{getStatusLabel(task.status)}</span>
                    <span className="conv-time">{getRelativeTime(task.updatedAt)}</span>
                  </span>
                )}
              </span>
            </button>
            <button
              type="button"
              className="sidebar-icon-btn conv-delete-btn is-danger"
              onClick={(event) => {
                event.stopPropagation();
                onDeleteTask(task.id);
              }}
              title={t("sidebar.deleteTask")}
              aria-label={t("sidebar.deleteTask")}
            >
              <IconTrash />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
