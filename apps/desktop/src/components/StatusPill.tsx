import type { TaskStatus } from "@aurevoy/shared";
import { getStatusLabel } from "./status";

interface StatusPillProps {
  status: TaskStatus | null;
}

export function StatusPill({ status }: StatusPillProps) {
  return (
    <span className="status-pill" data-status={status ?? "idle"}>
      {getStatusLabel(status)}
    </span>
  );
}
