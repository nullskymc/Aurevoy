import type { Task } from "@aurevoy/shared";
import { taskDisplayTitle } from "@aurevoy/shared";
import { t } from "../i18n";
import { getStatusLabel } from "../components/status";

export function SearchPage({
  query,
  tasks,
  onQueryChange,
  onSelectTask,
}: {
  query: string;
  tasks: Task[];
  onQueryChange: (query: string) => void;
  onSelectTask: (task: Task) => void;
}) {
  const normalizedQuery = query.trim().toLowerCase();
  const filteredTasks = normalizedQuery
    ? tasks.filter((task) => {
        const haystack = `${taskDisplayTitle(task)}\n${task.goal}`.toLowerCase();
        return haystack.includes(normalizedQuery);
      })
    : tasks;

  return (
    <section className="page-panel">
      <input
        className="page-search-input"
        value={query}
        placeholder={t("search.placeholder")}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
      />
      <div className="page-list">
        {filteredTasks.length === 0 ? (
          <p className="page-empty">{t("sidebar.emptyNoMatch")}</p>
        ) : (
          filteredTasks.map((task) => (
            <button key={task.id} type="button" className="page-list-row" onClick={() => onSelectTask(task)} title={task.goal}>
              <span className="page-list-title">{taskDisplayTitle(task)}</span>
              <span className="page-list-meta">
                {getStatusLabel(task.status)} · {new Date(task.updatedAt).toLocaleString("zh-CN")}
              </span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}
