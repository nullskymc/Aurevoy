import type { HealthResponse, Task, ToolDescriptor } from "@aurevoy/shared";
import type { FeedItem } from "./AgentEventFeed";
import { AgentEventFeed } from "./AgentEventFeed";

interface InspectorPanelProps {
  open: boolean;
  events: FeedItem[];
  health: HealthResponse | null;
  task: Task | null;
  tools: ToolDescriptor[];
  onClose: () => void;
}

export function InspectorPanel({
  open,
  events,
  health,
  task,
  tools,
  onClose,
}: InspectorPanelProps) {
  const toolEvents = events.filter(
    (item) => item.event.type === "tool_call" || item.event.type === "tool_result",
  );

  return (
    <>
      <div
        className="drawer-overlay"
        data-open={open}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside className="inspector" data-open={open} aria-label="任务检查器" aria-hidden={!open}>
        <header className="inspector-head">
          <h2>运行详情</h2>
          <button type="button" className="inspector-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        <div className="inspector-content">
          <section className="inspector-section">
            <p className="inspector-label">任务上下文</p>
            <dl className="meta-list">
              <div>
                <dt>当前任务</dt>
                <dd>{task ? task.goal : "未选择"}</dd>
              </div>
              <div>
                <dt>消息数</dt>
                <dd>{task?.messages.length ?? 0}</dd>
              </div>
              <div>
                <dt>引擎版本</dt>
                <dd>{health ? health.version : "未连接"}</dd>
              </div>
              <div>
                <dt>运行时长</dt>
                <dd>{health ? `${Math.round(health.uptimeMs / 1000)} 秒` : "未连接"}</dd>
              </div>
            </dl>
          </section>

          <section className="inspector-section">
            <div className="inspector-label-row">
              <p className="inspector-label">工具目录</p>
              <span className="inspector-count">{tools.length}</span>
            </div>
            <div className="tool-list">
              {tools.length === 0 ? (
                <p className="inspector-empty">未发现可用工具</p>
              ) : (
                tools.map((tool) => (
                  <article key={tool.name} className="tool-item">
                    <strong>{tool.name}</strong>
                    <p>{tool.description}</p>
                  </article>
                ))
              )}
            </div>
          </section>

          <section className="inspector-section">
            <div className="inspector-label-row">
              <p className="inspector-label">工具调用</p>
              <span className="inspector-count">{toolEvents.length}</span>
            </div>
            {toolEvents.length === 0 ? (
              <p className="inspector-empty">暂无工具调用</p>
            ) : (
              <div className="call-list">
                {toolEvents.map((item) => (
                  <code key={item.id}>{item.event.type}</code>
                ))}
              </div>
            )}
          </section>

          <AgentEventFeed events={events} />
        </div>
      </aside>
    </>
  );
}
