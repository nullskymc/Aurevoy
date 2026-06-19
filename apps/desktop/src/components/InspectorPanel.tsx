import { useState } from "react";
import type { HealthResponse, Message, Task, TaskPhase } from "@aurevoy/shared";
import { getPhaseLabel } from "./status";
import { t } from "../i18n";

interface InspectorPanelProps {
  open: boolean;
  health: HealthResponse | null;
  phase: TaskPhase | null;
  task: Task | null;
  onClose: () => void;
}

const EXPANDED_SECTIONS = new Set<string>();

export function InspectorPanel({
  open,
  health,
  phase,
  task,
  onClose,
}: InspectorPanelProps) {
  const [expanded, setExpanded] = useState<Set<string>>(EXPANDED_SECTIONS);
  const userMessages = task?.messages.filter((m): m is Message & { role: "user" } => m.role === "user") ?? [];

  function toggleSection(id: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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

          <InspectorCollapsible
            id="artifacts"
            label={t("inspector.artifacts")}
            count={task?.artifacts?.length ?? 0}
            expanded={expanded}
            onToggle={toggleSection}
          >
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
          </InspectorCollapsible>

          <InspectorCollapsible
            id="queries"
            label={t("inspector.queryIndex")}
            count={userMessages.length}
            expanded={expanded}
            onToggle={toggleSection}
          >
            {userMessages.length === 0 ? (
              <p className="inspector-empty">{t("inspector.emptyQueries")}</p>
            ) : (
              <div className="artifact-mini-list">
                {userMessages.map((msg, i) => (
                  <article key={msg.id} className="artifact-mini">
                    <strong>#{i + 1} {msg.content.slice(0, 80)}{msg.content.length > 80 ? "…" : ""}</strong>
                    <span>{new Date(msg.createdAt).toLocaleTimeString()}</span>
                  </article>
                ))}
              </div>
            )}
          </InspectorCollapsible>
        </div>
      </aside>
    </>
  );
}

function InspectorCollapsible({
  id,
  label,
  count,
  expanded,
  onToggle,
  children,
}: {
  id: string;
  label: string;
  count?: number;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}) {
  const isOpen = expanded.has(id);
  return (
    <section className="inspector-section">
      <button
        type="button"
        className="inspector-section-head"
        onClick={() => onToggle(id)}
        aria-expanded={isOpen}
      >
        <span className="inspector-label">{label}</span>
        {count != null && <span className="inspector-count">{count}</span>}
        <ChevronIcon className="inspector-chevron" data-open={isOpen ? "true" : undefined} />
      </button>
      {isOpen && <div className="inspector-section-body">{children}</div>}
    </section>
  );
}

function ChevronIcon({ className, ...rest }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" className={className} {...rest}>
      <path d="M7.2 5.8l4.2 4.2-4.2 4.2" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
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
