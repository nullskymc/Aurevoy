import type { AgentEvent } from "@aurevoy/shared";
import { getStatusLabel } from "./status";

export interface FeedItem {
  id: string;
  event: AgentEvent;
  createdAt: string;
}

interface AgentEventFeedProps {
  events: FeedItem[];
}

function getEventTitle(event: AgentEvent): string {
  switch (event.type) {
    case "task_created":
      return "任务已创建";
    case "status":
      return getStatusLabel(event.status);
    case "plan":
      return "计划已生成";
    case "step_update":
      return "步骤状态更新";
    case "token":
      return "正在生成输出";
    case "message":
      return "完整回复";
    case "tool_call":
      return `调用工具：${event.call.toolName}`;
    case "tool_result":
      return event.result.ok ? "工具返回结果" : "工具调用失败";
    case "done":
      return `任务${getStatusLabel(event.status)}`;
    case "error":
      return "执行错误";
  }
}

function getEventDetail(event: AgentEvent): string {
  switch (event.type) {
    case "status":
      return event.status;
    case "plan":
      return `${event.plan.length} 个计划步骤`;
    case "step_update":
      return event.step.description;
    case "token":
      return event.delta.trim() ? event.delta : "流式片段";
    case "message":
      return event.message.content;
    case "tool_call":
      return JSON.stringify(event.call.args, null, 2);
    case "tool_result":
      return event.result.ok
        ? JSON.stringify(event.result.output ?? {}, null, 2)
        : event.result.error ?? "未知错误";
    case "done":
      return event.status;
    case "error":
      return event.message;
    case "task_created":
      return event.task.goal;
  }
}

export function AgentEventFeed({ events }: AgentEventFeedProps) {
  const visibleEvents = events.filter((item) => item.event.type !== "token").slice(-24);

  return (
    <section className="inspector-section" aria-labelledby="event-title">
      <div className="inspector-label-row">
        <p className="inspector-label" id="event-title">事件流</p>
        <span className="inspector-count">{events.length}</span>
      </div>

      {visibleEvents.length === 0 ? (
        <p className="inspector-empty">暂无运行事件</p>
      ) : (
        <div className="event-feed">
          {visibleEvents.map((item) => (
            <article key={item.id} className="event-item" data-type={item.event.type}>
              <div className="event-dot" aria-hidden="true" />
              <div>
                <header>
                  <strong>{getEventTitle(item.event)}</strong>
                  <time>{new Date(item.createdAt).toLocaleTimeString("zh-CN")}</time>
                </header>
                <pre>{getEventDetail(item.event)}</pre>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
