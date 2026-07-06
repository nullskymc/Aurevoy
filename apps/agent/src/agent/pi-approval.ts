interface PiApprovalResult {
  approved: boolean;
}

const pendingPiApprovals = new Map<
  string,
  Map<string, (approved: boolean) => void>
>();
const pendingPlanApprovals = new Map<string, (approved: boolean) => void>();

export function resolvePiApproval(
  taskId: string,
  callId: string,
  approved: boolean,
): boolean {
  const resolve = pendingPiApprovals.get(taskId)?.get(callId);
  if (!resolve) return false;
  resolve(approved);
  return true;
}

export function waitForPiApproval(
  taskId: string,
  callId: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<PiApprovalResult> {
  return new Promise<PiApprovalResult>((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      const map = pendingPiApprovals.get(taskId);
      map?.delete(callId);
      if (map && map.size === 0) pendingPiApprovals.delete(taskId);
    };
    const finish = (approved: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ approved });
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);

    if (signal.aborted) return finish(false);
    signal.addEventListener('abort', onAbort, { once: true });
    let map = pendingPiApprovals.get(taskId);
    if (!map) {
      map = new Map();
      pendingPiApprovals.set(taskId, map);
    }
    map.set(callId, finish);
  });
}

export function cancelPiApprovals(taskId: string): void {
  const map = pendingPiApprovals.get(taskId);
  for (const resolve of map?.values() ?? []) resolve(false);
  pendingPiApprovals.delete(taskId);

  const resolvePlan = pendingPlanApprovals.get(taskId);
  if (resolvePlan) resolvePlan(false);
  pendingPlanApprovals.delete(taskId);
}

export function resolvePlanApproval(taskId: string, approved: boolean): boolean {
  const resolve = pendingPlanApprovals.get(taskId);
  if (!resolve) return false;
  resolve(approved);
  return true;
}

export function waitForPlanApproval(
  taskId: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<PiApprovalResult> {
  return new Promise<PiApprovalResult>((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      pendingPlanApprovals.delete(taskId);
    };
    const finish = (approved: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ approved });
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);

    if (signal.aborted) return finish(false);
    signal.addEventListener('abort', onAbort, { once: true });
    pendingPlanApprovals.set(taskId, finish);
  });
}
