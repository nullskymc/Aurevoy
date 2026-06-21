import type { TaskPhase, TaskStatus } from "@aurevoy/shared";
import { getPhaseLabel, getStatusLabel } from "./status";

interface StatusPillProps {
  status: TaskStatus | null;
  phase?: TaskPhase | null;
}

/**
 * 状态指示：用 icon 表达状态（失败→叉、已取消→斜杠、进行中→脉冲圆点）。
 * 可读文案通过 aria-label/title 提供给屏幕阅读器与悬停提示。
 */
export function StatusPill({ status, phase = null }: StatusPillProps) {
  // 终态任务不再显示残留阶段（如"整理结果"），直接表达终态；进行中才用阶段文案。
  const isTerminal = status === "completed" || status === "failed" || status === "cancelled";
  const label = !isTerminal && phase ? getPhaseLabel(phase) : getStatusLabel(status);

  return (
    <span
      className="status-pill"
      data-status={status ?? "idle"}
      data-phase={phase ?? "none"}
      role="img"
      aria-label={label}
      title={label}
    >
      <StatusGlyph status={status} />
    </span>
  );
}

function StatusGlyph({ status }: { status: TaskStatus | null }) {
  if (status === "failed") return <CrossIcon />;
  if (status === "cancelled") return <SlashIcon />;
  return null;
}

function CrossIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path
        d="M4.5 4.5l7 7M11.5 4.5l-7 7"
        stroke="currentColor"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SlashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <circle cx="8" cy="8" r="5.2" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M4.6 4.6l6.8 6.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
