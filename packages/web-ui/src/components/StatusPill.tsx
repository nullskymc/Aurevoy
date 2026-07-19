import type { TaskPhase, TaskStatus } from "@aurevoy/shared";
import { getPhaseLabel, getStatusLabel } from "./status";
import { IconBan, IconX } from "../icons";

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
  if (status === "failed") return <IconX size={13} strokeWidth={2} />;
  if (status === "cancelled") return <IconBan size={13} strokeWidth={1.75} />;
  return null;
}
