import type { HealthResponse, Task, TaskPhase, TaskTraceEntry, ToolDescriptor } from "@aurevoy/shared";
import type { FeedItem } from "./AgentEventFeed";
import { AgentEventFeed } from "./AgentEventFeed";
import { getPhaseLabel } from "./status";

interface InspectorPanelProps {
  open: boolean;
  events: FeedItem[];
  health: HealthResponse | null;
  phase: TaskPhase | null;
  task: Task | null;
  traces: TaskTraceEntry[];
  tools: ToolDescriptor[];
  onClose: () => void;
}

export function InspectorPanel({
  open,
  events,
  health,
  phase,
  task,
  traces,
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
                <dt>当前阶段</dt>
                <dd>{getPhaseLabel(phase ?? task?.phase ?? null) || "未开始"}</dd>
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
              <p className="inspector-label">轨迹日志</p>
              <span className="inspector-count">{traces.length}</span>
            </div>
            {traces.length === 0 ? (
              <p className="inspector-empty">暂无持久轨迹</p>
            ) : (
              <div className="trace-list">
                {traces.slice(-32).map((trace) => (
                  <article key={trace.id} className="trace-item" data-kind={trace.kind}>
                    <header>
                      <strong>{getTraceTitle(trace)}</strong>
                      <time>{new Date(trace.startedAt).toLocaleTimeString("zh-CN")}</time>
                    </header>
                    <p>{getTraceDetail(trace)}</p>
                  </article>
                ))}
              </div>
            )}
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
                {toolEvents.map((item) => {
                  const event = item.event;
                  if (event.type === "tool_call") {
                    return (
                      <div key={item.id} className="call-row" data-kind="call">
                        <span className="call-row-icon" aria-hidden="true">
                          →
                        </span>
                        <span className="call-row-name">{event.call.toolName}</span>
                        <span className="call-row-tag">调用</span>
                      </div>
                    );
                  }
                  if (event.type === "tool_result") {
                    const ok = event.result.ok;
                    return (
                      <div key={item.id} className="call-row" data-kind={ok ? "ok" : "error"}>
                        <span className="call-row-icon" aria-hidden="true">
                          {ok ? "✓" : "✕"}
                        </span>
                        <span className="call-row-name">{ok ? "返回结果" : "调用失败"}</span>
                        <span className="call-row-tag">{ok ? "成功" : "失败"}</span>
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            )}
          </section>

          <AgentEventFeed events={events} />
        </div>
      </aside>
    </>
  );
}

function getTraceTitle(trace: TaskTraceEntry): string {
  const phase = getPhaseLabel(trace.phase);
  const base =
    trace.kind === "llm"
      ? `模型轮次${trace.iteration ? ` #${trace.iteration}` : ""}`
      : trace.kind === "tool_call"
        ? `工具请求：${trace.toolName ?? "unknown"}`
        : trace.kind === "tool_result"
          ? `工具结果：${trace.toolName ?? "unknown"}`
          : trace.kind === "approval"
            ? `审批：${trace.toolName ?? "unknown"}`
            : trace.kind === "done"
              ? "任务结束"
              : trace.kind === "error"
                ? "错误"
                : "阶段变化";
  return phase ? `${base} · ${phase}` : base;
}

function getTraceDetail(trace: TaskTraceEntry): string {
  const parts = [
    trace.summary,
    trace.ok === true ? "成功" : trace.ok === false ? "失败" : undefined,
    trace.errorCategory ? `分类：${trace.errorCategory}` : undefined,
    trace.durationMs != null ? `${trace.durationMs}ms` : undefined,
    trace.tokenUsage == null && trace.kind === "llm" ? "token: 不可用" : undefined,
  ].filter(Boolean);
  return parts.join(" / ") || trace.kind;
}
