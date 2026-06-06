import type { Task } from "@aurevoy/shared";
import { StatusPill } from "./StatusPill";
import { getRelativeTime } from "./status";

interface TaskHistorySidebarProps {
  activeTaskId?: string;
  tasks: Task[];
  onSelectTask: (task: Task) => void;
}

export function TaskHistorySidebar({
  activeTaskId,
  tasks,
  onSelectTask,
}: TaskHistorySidebarProps) {
  const completedCount = tasks.filter((task) => task.status === "completed").length;
  const runningCount = tasks.filter((task) => task.status === "running").length;

  return (
    <aside className="sidebar" aria-label="任务导航">
      <div className="brand-block">
        <div className="brand-mark">A</div>
        <div>
          <h1>Aurevoy</h1>
          <p>个人 Agent 工作台</p>
        </div>
      </div>

      <nav className="nav-list" aria-label="主导航">
        <a className="nav-item active" href="#workspace">
          <span>工作台</span>
          <strong>{runningCount}</strong>
        </a>
        <a className="nav-item" href="#tools">
          <span>工具</span>
        </a>
        <a className="nav-item" href="#memory">
          <span>记忆</span>
        </a>
        <a className="nav-item" href="#settings">
          <span>设置</span>
        </a>
      </nav>

      <div className="sidebar-summary">
        <div>
          <span>今日任务</span>
          <strong>{tasks.length}</strong>
        </div>
        <div>
          <span>已完成</span>
          <strong>{completedCount}</strong>
        </div>
      </div>

      <div className="history-header">
        <h2>任务历史</h2>
        <span>{tasks.length}</span>
      </div>
      <div className="task-list">
        {tasks.length === 0 ? (
          <p className="empty-copy">还没有任务记录</p>
        ) : (
          tasks.map((task) => (
            <button
              key={task.id}
              className="task-row"
              data-active={task.id === activeTaskId}
              type="button"
              onClick={() => onSelectTask(task)}
            >
              <span className="task-title">{task.goal}</span>
              <span className="task-meta">
                <StatusPill status={task.status} />
                <span>{getRelativeTime(task.updatedAt)}</span>
              </span>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
