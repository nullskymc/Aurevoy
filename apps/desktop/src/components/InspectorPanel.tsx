import type { HealthResponse, Task, ToolDescriptor } from "@aurevoy/shared";
import type { FeedItem } from "./AgentEventFeed";
import { AgentEventFeed } from "./AgentEventFeed";

interface InspectorPanelProps {
  events: FeedItem[];
  health: HealthResponse | null;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  task: Task | null;
  tools: ToolDescriptor[];
}

export function InspectorPanel({
  events,
  health,
  isCollapsed,
  onToggleCollapsed,
  task,
  tools,
}: InspectorPanelProps) {
  const toolEvents = events.filter(
    (item) => item.event.type === "tool_call" || item.event.type === "tool_result",
  );

  return (
    <aside className="inspector" data-collapsed={isCollapsed} aria-label="任务检查器">
      <button className="inspector-toggle" type="button" onClick={onToggleCollapsed}>
        {isCollapsed ? "展开检查器" : "收起检查器"}
      </button>

      <div className="inspector-content">
        <section className="inspector-section">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Context</p>
              <h2>任务上下文</h2>
            </div>
          </div>
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
              <dt>运行时长</dt>
              <dd>{health ? `${Math.round(health.uptimeMs / 1000)} 秒` : "未连接"}</dd>
            </div>
          </dl>
        </section>

        <section id="tools" className="inspector-section">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Tools</p>
              <h2>工具目录</h2>
            </div>
            <span className="section-count">{tools.length}</span>
          </div>
          <div className="tool-list">
            {tools.length === 0 ? (
              <div className="empty-state">未发现可用工具</div>
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
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Calls</p>
              <h2>工具调用</h2>
            </div>
            <span className="section-count">{toolEvents.length}</span>
          </div>
          {toolEvents.length === 0 ? (
            <div className="empty-state">暂无工具调用</div>
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
  );
}
