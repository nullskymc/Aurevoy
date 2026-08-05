/**
 * Plan step status helpers for UI (maps shared PlanStepStatus → display).
 * Keeps Timeline / Conversation from treating `blocked` as completed.
 */
import type { PlanStep, PlanStepStatus } from "@aurevoy/shared";
import { t } from "../i18n";

/** Group / chip status used in timeline plan UI */
export type PlanUiStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "cancelled";

/**
 * Map a durable PlanStep.status to a UI group status.
 * - blocked / paused → blocked (waiting on user/env)
 * - cancelled → cancelled (distinct from failure and pending)
 */
export function mapPlanStepToUiStatus(status: PlanStepStatus): PlanUiStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "blocked":
    case "paused":
      return "blocked";
    case "running":
      return "running";
    case "cancelled":
      return "cancelled";
    case "pending":
    case "proposed":
      return "pending";
    default:
      return "pending";
  }
}

/** Prefer plan step status; when tools in the group already failed, escalate to failed. */
export function mapPlanStepGroupStatus(
  planStatus: PlanStepStatus,
  toolFailed = false,
  phaseFailed = false,
  phaseCancelled = false,
): PlanUiStatus {
  if (phaseFailed) return "failed";
  // 已完成步骤的历史结果仍应保留；取消造成的计划失败没有真实工具失败时仍显示 cancelled。
  if (phaseCancelled && planStatus !== "completed" && !toolFailed) {
    return "cancelled";
  }
  if (toolFailed && planStatus !== "completed") return "failed";
  return mapPlanStepToUiStatus(planStatus);
}

export function getPlanStepStatusLabel(status: PlanStepStatus | PlanUiStatus): string {
  switch (status) {
    case "completed":
      return t("plan.step.completed");
    case "failed":
      return t("plan.step.failed");
    case "blocked":
    case "paused":
      return t("plan.step.blocked");
    case "running":
      return t("plan.step.running");
    case "cancelled":
      return t("plan.step.cancelled");
    case "pending":
    case "proposed":
    default:
      return t("plan.step.pending");
  }
}

/** Multi-step plans that are worth showing as a progress strip */
export function shouldShowPlanProgress(plan: PlanStep[]): boolean {
  return plan.length >= 2;
}

export function planBlockedReason(step: PlanStep): string | undefined {
  if (step.status !== "blocked" && step.status !== "paused") return undefined;
  const reason = step.blockedReason?.trim();
  return reason || undefined;
}
