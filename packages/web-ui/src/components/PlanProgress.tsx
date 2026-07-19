/**
 * Compact multi-step plan strip: status chips + blocked reason.
 * Shown when the task has a real multi-step plan (not single `exec`).
 */
import type { PlanStep } from "@aurevoy/shared";
import { t } from "../i18n";
import {
  getPlanStepStatusLabel,
  mapPlanStepToUiStatus,
  planBlockedReason,
  shouldShowPlanProgress,
  type PlanUiStatus,
} from "./planStatus";
import "./PlanProgress.css";

export function PlanProgress({ plan }: { plan: PlanStep[] }) {
  if (!shouldShowPlanProgress(plan)) return null;

  const blocked = plan.find((s) => s.status === "blocked" || s.status === "paused");
  const blockedReason = blocked ? planBlockedReason(blocked) : undefined;
  const completed = plan.filter((s) => s.status === "completed").length;

  return (
    <section className="plan-progress" aria-label={t("plan.title")}>
      <div className="plan-progress-header">
        <span className="plan-progress-title">{t("plan.title")}</span>
        <span className="plan-progress-meta">
          {completed}/{plan.length} {t("plan.progress.done")}
        </span>
      </div>
      <ol className="plan-progress-list">
        {plan.map((step, index) => {
          const ui = mapPlanStepToUiStatus(step.status);
          return (
            <li
              key={step.id}
              className="plan-progress-item"
              data-status={ui}
              title={step.blockedReason ?? step.description}
            >
              <span className="plan-progress-index" aria-hidden="true">
                {index + 1}
              </span>
              <span className="plan-progress-desc">{step.description}</span>
              <span className={`plan-progress-badge is-${ui}`}>{statusBadge(ui)}</span>
            </li>
          );
        })}
      </ol>
      {blockedReason ? (
        <p className="plan-progress-blocker" role="status">
          <span className="plan-progress-blocker-label">{t("plan.step.blocked")}</span>
          {blockedReason}
        </p>
      ) : null}
    </section>
  );
}

function statusBadge(ui: PlanUiStatus): string {
  return getPlanStepStatusLabel(ui);
}
