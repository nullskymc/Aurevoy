import type { TaskPhase, TaskStatus } from "@aurevoy/shared";
import { getPhaseLabel, getStatusLabel } from "./status";

interface StatusPillProps {
  status: TaskStatus | null;
  phase?: TaskPhase | null;
}

export function StatusPill({ status, phase = null }: StatusPillProps) {
  const label = phase ? getPhaseLabel(phase) : getStatusLabel(status);

  return (
    <span className="status-pill" data-status={status ?? "idle"} data-phase={phase ?? "none"}>
      {label}
    </span>
  );
}
