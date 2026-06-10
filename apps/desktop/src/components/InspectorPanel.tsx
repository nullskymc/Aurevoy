import type { HealthResponse, Task, TaskPhase, TaskTraceEntry, ToolDescriptor } from "@aurevoy/shared";
import type { FeedItem } from "./AgentEventFeed";
import { AgentEventFeed } from "./AgentEventFeed";
import { getPhaseLabel } from "./status";
import { t } from "../i18n";

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
      <aside className="inspector" data-open={open} aria-label={t("inspector.panelLabel")} aria-hidden={!open}>
        <header className="inspector-head">
          <h2>{t("inspector.title")}</h2>
          <button type="button" className="inspector-close" onClick={onClose} aria-label={t("action.close")}>
            ✕
          </button>
        </header>

        <div className="inspector-content">
          <section className="inspector-section">
            <p className="inspector-label">{t("inspector.taskContext")}</p>
            <dl className="meta-list">
              <div>
                <dt>{t("inspector.currentTask")}</dt>
                <dd>{task ? task.goal : t("inspector.unselected")}</dd>
              </div>
              <div>
                <dt>{t("inspector.messageCount")}</dt>
                <dd>{task?.messages.length ?? 0}</dd>
              </div>
              <div>
                <dt>{t("inspector.currentPhase")}</dt>
                <dd>{getPhaseLabel(phase ?? task?.phase ?? null) || t("inspector.notStarted")}</dd>
              </div>
              <div>
                <dt>{t("inspector.token")}</dt>
                <dd>{formatTokenUsage(task)}</dd>
              </div>
              <div>
                <dt>{t("inspector.budget")}</dt>
                <dd>{formatBudgetUsage(task)}</dd>
              </div>
              <div>
                <dt>{t("inspector.engineVersion")}</dt>
                <dd>{health ? health.version : t("inspector.notConnected")}</dd>
              </div>
              <div>
                <dt>{t("inspector.uptime")}</dt>
                <dd>{health ? `${Math.round(health.uptimeMs / 1000)} ${t("inspector.uptimeUnit")}` : t("inspector.notConnected")}</dd>
              </div>
            </dl>
            {task && <InspectorBudgetBar task={task} />}
          </section>

          <section className="inspector-section">
            <div className="inspector-label-row">
              <p className="inspector-label">{t("inspector.artifacts")}</p>
              <span className="inspector-count">{task?.artifacts?.length ?? 0}</span>
            </div>
            {!task?.artifacts?.length ? (
              <p className="inspector-empty">{t("inspector.emptyArtifacts")}</p>
            ) : (
              <div className="artifact-mini-list">
                {task.artifacts.map((artifact) => (
                  <article key={artifact.id} className="artifact-mini" data-status={artifact.status}>
                    <strong>{artifact.name}</strong>
                    <span>{artifact.type} · {artifact.status}</span>
                    {artifact.appliedPath && <small>{artifact.appliedPath}</small>}
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="inspector-section">
            <div className="inspector-label-row">
              <p className="inspector-label">{t("inspector.clarifications")}</p>
              <span className="inspector-count">{task?.clarifications?.length ?? 0}</span>
            </div>
            {!task?.clarifications?.length ? (
              <p className="inspector-empty">{t("inspector.emptyClarifications")}</p>
            ) : (
              <div className="artifact-mini-list">
                {task.clarifications.map((clarification) => (
                  <article key={clarification.id} className="artifact-mini" data-status={clarification.status}>
                    <strong>{clarification.question}</strong>
                    <span>{clarification.status}</span>
                    {clarification.answer && <small>{clarification.answer}</small>}
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="inspector-section">
            <div className="inspector-label-row">
              <p className="inspector-label">{t("inspector.checkpoints")}</p>
              <span className="inspector-count">{task?.checkpoints?.length ?? 0}</span>
            </div>
            {!task?.checkpoints?.length ? (
              <p className="inspector-empty">{t("inspector.emptyCheckpoints")}</p>
            ) : (
              <div className="artifact-mini-list">
                {task.checkpoints.map((checkpoint) => (
                  <article key={checkpoint.id} className="artifact-mini">
                    <strong>{checkpoint.label}</strong>
                    <span>{new Date(checkpoint.createdAt).toLocaleString("zh-CN")}</span>
                    {checkpoint.message && <small>{checkpoint.message}</small>}
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="inspector-section">
            <div className="inspector-label-row">
              <p className="inspector-label">{t("inspector.traces")}</p>
              <span className="inspector-count">{traces.length}</span>
            </div>
            {traces.length === 0 ? (
              <p className="inspector-empty">{t("inspector.emptyTraces")}</p>
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
              <p className="inspector-label">{t("inspector.toolCatalog")}</p>
              <span className="inspector-count">{tools.length}</span>
            </div>
            <div className="tool-list">
              {tools.length === 0 ? (
                <p className="inspector-empty">{t("inspector.emptyTools")}</p>
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
              <p className="inspector-label">{t("inspector.toolCalls")}</p>
              <span className="inspector-count">{toolEvents.length}</span>
            </div>
            {toolEvents.length === 0 ? (
              <p className="inspector-empty">{t("inspector.emptyToolCalls")}</p>
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
                        <span className="call-row-tag">{t("inspector.callTag")}</span>
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
                        <span className="call-row-name">{ok ? t("inspector.callReturned") : t("inspector.callFailed")}</span>
                        <span className="call-row-tag">{ok ? t("inspector.success") : t("inspector.failure")}</span>
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
      ? `${t("trace.llmRound")}${trace.iteration ? ` #${trace.iteration}` : ""}`
      : trace.kind === "tool_call"
        ? `${t("trace.toolRequest")}${trace.toolName ?? t("trace.unknown")}`
        : trace.kind === "tool_result"
          ? `${t("trace.toolResult")}${trace.toolName ?? t("trace.unknown")}`
          : trace.kind === "approval"
            ? `${t("trace.approval")}${trace.toolName ?? t("trace.unknown")}`
            : trace.kind === "done"
              ? t("trace.taskDone")
              : trace.kind === "error"
                ? t("trace.error")
                : t("trace.phaseChange");
  return phase ? `${base} · ${phase}` : base;
}

function getTraceDetail(trace: TaskTraceEntry): string {
  const parts = [
    trace.summary,
    trace.ok === true ? t("inspector.success") : trace.ok === false ? t("inspector.failure") : undefined,
    trace.errorCategory ? `${t("trace.categoryPrefix")}${trace.errorCategory}` : undefined,
    trace.durationMs != null ? `${trace.durationMs}ms` : undefined,
    trace.tokenUsage == null && trace.kind === "llm" ? t("trace.tokenUnavailable") : undefined,
  ].filter(Boolean);
  return parts.join(" / ") || trace.kind;
}

/** 运行详情内的预算使用可视化（从主对话区迁入，样式独立于对话区 BudgetBar）。 */
function InspectorBudgetBar({ task }: { task: Task }) {
  const usage = task.budgetUsage;
  const budget = task.budget;
  if (!usage && !budget) return null;
  const toolLimit = budget?.maxToolCalls ?? 80;
  const outputLimit = budget?.maxOutputBytes ?? 1024 * 1024;
  const toolRatio = Math.min(100, ((usage?.toolCalls ?? 0) / toolLimit) * 100);
  const outputRatio = Math.min(100, ((usage?.outputBytes ?? 0) / outputLimit) * 100);

  return (
    <div className="inspector-budget">
      <div className="inspector-budget-row">
        <span>{t("inspector.toolCalls")}</span>
        <strong>
          {usage?.toolCalls ?? 0} / {toolLimit}
        </strong>
        <div className="inspector-budget-track">
          <span style={{ width: `${toolRatio}%` }} />
        </div>
      </div>
      <div className="inspector-budget-row">
        <span>{t("inspector.outputBytes")}</span>
        <strong>
          {formatBytes(usage?.outputBytes ?? 0)} / {formatBytes(outputLimit)}
        </strong>
        <div className="inspector-budget-track">
          <span style={{ width: `${outputRatio}%` }} />
        </div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function formatTokenUsage(task: Task | null): string {
  const usage = task?.tokenUsage;
  if (!usage) return t("inspector.notRecorded");
  if (!usage.available) return t("inspector.unavailable");
  return `${usage.totalTokens ?? 0} total / ${usage.promptTokens ?? 0} in / ${usage.completionTokens ?? 0} out`;
}

function formatBudgetUsage(task: Task | null): string {
  const usage = task?.budgetUsage;
  if (!usage) return t("inspector.notStarted");
  return `${usage.iterations} ${t("budget.unitIterations")} / ${usage.toolCalls} ${t("budget.tools")} / ${usage.outputBytes} bytes`;
}
