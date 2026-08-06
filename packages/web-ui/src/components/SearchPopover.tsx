import { useEffect, useMemo, useRef, useState } from "react";
import type { Project, TaskSummary } from "@aurevoy/shared";
import { taskDisplayTitle } from "@aurevoy/shared";
import { IconFolder, IconPencil, IconSearch } from "../icons";
import { t } from "../i18n";
import { useFocusTrap } from "../hooks/useFocusTrap";
import "./SearchPopover.css";

interface SearchPopoverProps {
  tasks: TaskSummary[];
  projects: Project[];
  onClose: () => void;
  onSelectTask: (task: TaskSummary) => void;
  onNewTask: () => void;
  onOpenFolder: () => void;
  onSearchFiles: () => void;
}

/** 侧栏搜索弹窗只负责本地任务历史，不再切换主工作区视图。 */
export function SearchPopover({
  tasks,
  projects,
  onClose,
  onSelectTask,
  onNewTask,
  onOpenFolder,
  onSearchFiles,
}: SearchPopoverProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useFocusTrap<HTMLElement>(true);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const modifierKey = useMemo(() => {
    if (typeof navigator === "undefined") return "⌘";
    return /Mac|iPhone|iPad/.test(`${navigator.platform} ${navigator.userAgent}`) ? "⌘" : "Ctrl";
  }, []);
  const filteredTasks = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matched = normalizedQuery
      ? tasks.filter((task) => `${taskDisplayTitle(task)}\n${task.goal}`.toLocaleLowerCase().includes(normalizedQuery))
      : tasks;
    return matched.slice(0, 9);
  }, [query, tasks]);

  useEffect(() => {
    inputRef.current?.focus();
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      const command = event.metaKey || event.ctrlKey;
      if (!command) return;
      const shortcutIndex = Number(event.key) - 1;
      if (Number.isInteger(shortcutIndex) && shortcutIndex >= 0 && shortcutIndex < filteredTasks.length) {
        event.preventDefault();
        onSelectTask(filteredTasks[shortcutIndex]);
        return;
      }
      const shortcut = event.key.toLowerCase();
      if (shortcut === "n") {
        event.preventDefault();
        onNewTask();
      } else if (shortcut === "o") {
        event.preventDefault();
        onOpenFolder();
      } else if (shortcut === "p") {
        event.preventDefault();
        onSearchFiles();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [filteredTasks, onClose, onNewTask, onOpenFolder, onSearchFiles, onSelectTask]);

  function handleQueryChange(value: string): void {
    setQuery(value);
    setSelectedIndex(0);
  }

  function handleInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((index) => Math.min(index + 1, Math.max(filteredTasks.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && filteredTasks[selectedIndex]) {
      event.preventDefault();
      onSelectTask(filteredTasks[selectedIndex]);
    }
  }

  return (
    <div
      className="search-popover-layer"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={popoverRef}
        className="search-popover"
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-popover-title"
        tabIndex={-1}
      >
        <div className="search-popover-input-wrap">
          <input
            ref={inputRef}
            id="search-popover-title"
            className="search-popover-input"
            type="search"
            value={query}
            placeholder={t("search.placeholder")}
            aria-label={t("search.placeholder")}
            onChange={(event) => handleQueryChange(event.currentTarget.value)}
            onKeyDown={handleInputKeyDown}
          />
        </div>

        <div className="search-popover-section">
          <h2>{t("search.chats")}</h2>
          {filteredTasks.length === 0 ? (
            <p className="search-popover-empty">{t("search.empty")}</p>
          ) : (
            <div className="search-task-list" role="listbox" aria-label={t("search.chats")}>
              {filteredTasks.map((task, index) => (
                <button
                  key={task.id}
                  type="button"
                  className="search-task-row"
                  data-selected={index === selectedIndex}
                  role="option"
                  aria-selected={index === selectedIndex}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => onSelectTask(task)}
                >
                  <span className="search-task-title">{taskDisplayTitle(task)}</span>
                  <span className="search-task-meta">
                    <span>{projectNames.get(task.projectId ?? "") ?? t("search.localProject")}</span>
                    <kbd>{modifierKey}{index + 1}</kbd>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="search-popover-section search-popover-recommendations">
          <h2>{t("search.recommended")}</h2>
          <button type="button" className="search-recommendation" onClick={onNewTask}>
            <IconPencil size={22} />
            <span>{t("search.newChat")}</span>
            <kbd>{modifierKey}N</kbd>
          </button>
          <button type="button" className="search-recommendation" onClick={onOpenFolder}>
            <IconFolder size={22} />
            <span>{t("search.openFolder")}</span>
            <kbd>{modifierKey}O</kbd>
          </button>
          <button type="button" className="search-recommendation" onClick={onSearchFiles}>
            <IconSearch size={22} />
            <span>{t("search.searchFiles")}</span>
            <kbd>{modifierKey}P</kbd>
          </button>
        </div>
      </section>
    </div>
  );
}
