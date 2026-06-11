import type { HealthResponse, Task, TaskPhase } from "@aurevoy/shared";
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
  onClose: () => void;
}

export function InspectorPanel({
  open,
  events,
  health,
  phase,
  task,
  onClose,
}: InspectorPanelProps) {
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

          <AgentEventFeed events={events} />
        </div>
      </aside>
    </>
  );
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
