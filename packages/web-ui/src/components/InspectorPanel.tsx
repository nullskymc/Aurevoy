import type {
  HealthResponse,
  RuntimeSettings,
  Task,
  TaskPhase,
} from "@aurevoy/shared";
import { getPhaseLabel } from "./status";
import { t } from "../i18n";

interface InspectorPanelProps {
  open: boolean;
  health: HealthResponse | null;
  phase: TaskPhase | null;
  settings: RuntimeSettings | null;
  task: Task | null;
  onClose: () => void;
}

export function InspectorPanel({
  open,
  health,
  phase,
  settings,
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
                <dt>{t("inspector.currentPhase")}</dt>
                <dd>{getPhaseLabel(phase ?? task?.phase ?? null) || t("inspector.notStarted")}</dd>
              </div>
              {task?.contextTokens != null && (
                <div>
                  <dt>{t("inspector.contextWindow")}</dt>
                  <dd>{formatContextUsage(task.contextTokens, health?.contextTokenBudget)}</dd>
                </div>
              )}
              {task?.tokenUsage && (
                <div>
                  <dt>{t("inspector.token")}</dt>
                  <dd>{formatTokenUsage(task)}</dd>
                </div>
              )}
              {task?.budgetUsage && (
                <div>
                  <dt>{t("inspector.budget")}</dt>
                  <dd>{formatBudgetUsage(task)}</dd>
                </div>
              )}
              {(task?.plan?.length ?? 0) > 0 && (
                <div>
                  <dt>{t("inspector.planProgress")}</dt>
                  <dd>{formatPlanProgress(task)}</dd>
                </div>
              )}
              {(task?.pendingApprovals?.length ?? 0) > 0 && (
                <div>
                  <dt>{t("inspector.pendingApprovals")}</dt>
                  <dd>{task?.pendingApprovals?.length ?? 0}</dd>
                </div>
              )}
            </dl>
          </section>

          <section className="inspector-section">
            <p className="inspector-label">{t("inspector.piRuntime")}</p>
            <div className="runtime-chip-grid">
              <RuntimeChip label={t("inspector.provider")} value={formatRuntimeProvider(health, settings)} />
              <RuntimeChip label={t("inspector.thinking")} value={settings?.agentThinkingLevel ?? t("inspector.notConnected")} />
              <RuntimeChip label={t("inspector.toolExecution")} value={settings?.agentToolExecution ?? t("inspector.notConnected")} />
              <RuntimeChip label={t("inspector.autoMode")} value={settings?.autoModeLevel ?? t("inspector.notConnected")} />
            </div>
          </section>
        </div>
      </aside>
    </>
  );
}

function RuntimeChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="runtime-chip">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatTokenUsage(task: Task | null): string {
  const usage = task?.tokenUsage;
  if (!usage) return t("inspector.notRecorded");
  if (!usage.available) return t("inspector.unavailable");
  const parts: string[] = [
    `${usage.totalTokens ?? 0} total`,
    `${usage.promptTokens ?? 0} in`,
    `${usage.completionTokens ?? 0} out`,
  ];
  if (usage.reasoningTokens) parts.push(`${usage.reasoningTokens} reasoning`);
  if (usage.cacheReadTokens) parts.push(`${usage.cacheReadTokens} cache read`);
  if (usage.cacheWriteTokens) parts.push(`${usage.cacheWriteTokens} cache write`);
  return parts.join(" / ");
}

function formatRuntimeProvider(health: HealthResponse | null, settings: RuntimeSettings | null): string {
  if (health?.provider && health.provider !== "unconfigured") return health.provider;
  if (settings?.llm.provider && settings.llm.model) return `${settings.llm.provider}:${settings.llm.model}`;
  return t("inspector.notConnected");
}

function formatContextUsage(tokens?: number, budget?: number): string {
  if (tokens == null) return t("inspector.notRecorded");
  if (!budget) return `~${formatCompactNumber(tokens)}`;
  const percent = Math.min(999, Math.round((tokens / budget) * 100));
  return `~${formatCompactNumber(tokens)} / ${formatCompactNumber(budget)} (${percent}%)`;
}

function formatBudgetUsage(task: Task | null): string {
  const usage = task?.budgetUsage;
  if (!usage) return t("inspector.notStarted");
  return `${usage.iterations} ${t("budget.unitIterations")} / ${usage.toolCalls} ${t("budget.tools")} / ${formatCompactNumber(usage.outputBytes)} bytes / ${formatDuration(usage.wallTimeMs)}`;
}

function formatPlanProgress(task: Task | null): string {
  const steps = task?.plan ?? [];
  if (steps.length === 0) return t("inspector.notStarted");
  const completed = steps.filter((step) => step.status === "completed").length;
  const running = steps.filter((step) => step.status === "running").length;
  return `${completed}/${steps.length}${running > 0 ? ` · ${running} running` : ""}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function formatCompactNumber(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}
