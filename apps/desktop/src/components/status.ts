import type { TaskPhase, TaskStatus } from "@aurevoy/shared";
import { t } from "../i18n";

export function getStatusLabel(status: TaskStatus | null): string {
  switch (status) {
    case "pending":
      return t("status.pending");
    case "planning":
      return t("status.planning");
    case "running":
      return t("status.running");
    case "paused":
      return t("status.paused");
    case "completed":
      return t("status.completed");
    case "failed":
      return t("status.failed");
    case "cancelled":
      return t("status.cancelled");
    default:
      return t("status.idle");
  }
}

export function getPhaseLabel(phase: TaskPhase | null): string {
  switch (phase) {
    case "initializing":
      return t("phase.initializing");
    case "thinking":
      return t("phase.thinking");
    case "calling_tool":
      return t("phase.calling_tool");
    case "waiting_approval":
      return t("phase.waiting_approval");
    case "waiting_clarification":
      return t("phase.waiting_clarification");
    case "finalizing":
      return t("phase.finalizing");
    case "failed":
      return t("phase.failed");
    case "cancelled":
      return t("phase.cancelled");
    default:
      return "";
  }
}

export function getRelativeTime(value: string): string {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "";

  const diffMs = Date.now() - time;
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) return t("time.justNow");
  if (diffMinutes < 60) return `${diffMinutes} ${t("time.minutesAgo")}`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} ${t("time.hoursAgo")}`;

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
