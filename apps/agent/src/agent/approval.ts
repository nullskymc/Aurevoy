import type { AutoModeLevel, AutoModeState, Task } from "@aurevoy/shared"

export type ToolRiskLevel = "safe" | "caution" | "dangerous"

export interface ApprovalConfig {
  /** 当前任务的执行模式。 */
  autoModeLevel: AutoModeLevel
  autoModePaused: boolean
}

export interface ApprovalRequest {
  callId: string
  toolName: string
  risk: ToolRiskLevel
  args: Record<string, unknown>
}

export type ApprovalDecision =
  | { approved: false }
  | { approved: true }

/** 从任务构造审批配置（子代理复用同一 paused 状态）。 */
export function approvalConfigFromTask(
  task: Pick<Task, "autoModeState">,
  level: AutoModeLevel = "auto",
): ApprovalConfig {
  return {
    autoModeLevel: task.autoModeState?.level ?? level,
    autoModePaused: !!task.autoModeState?.paused,
  }
}

/** 创建任务时的初始 auto mode 状态。 */
export function createInitialAutoModeState(level: AutoModeLevel = "auto"): AutoModeState {
  return {
    level,
    autoApprovedCalls: 0,
    blockedByRules: 0,
    paused: false,
  }
}

/** 同步任务上的执行模式快照，并保留已有的计数与暂停状态。 */
export function syncAutoModeState(task: Task, level: AutoModeLevel = "auto"): AutoModeState {
  const prev = task.autoModeState
  const next: AutoModeState = {
    level,
    autoApprovedCalls: prev?.autoApprovedCalls ?? 0,
    blockedByRules: prev?.blockedByRules ?? 0,
    paused: prev?.paused ?? false,
    pausedReason: prev?.pausedReason,
  }
  task.autoModeState = next
  return next
}

/**
 * 工具权限决策。
 *
 * - safe：始终放行
 * - paused：非 safe 拒绝（需 resume）
 * - 否则：非 safe 自动放行
 */
export function decideToolPermission(
  config: ApprovalConfig,
  _toolName: string,
  risk: ToolRiskLevel,
): {
  allowed: boolean
  reason?: string
  autoApproved?: boolean
} {
  if (risk === "safe") {
    return { allowed: true }
  }

  if (config.autoModePaused) {
    return { allowed: false, reason: "Auto mode paused" }
  }

  return { allowed: true, autoApproved: true }
}
