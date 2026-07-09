import type { AutoModeLevel, AutoModeState, Task } from "@aurevoy/shared"

export type ToolRiskLevel = "safe" | "caution" | "dangerous"

export interface ApprovalConfig {
  autoModeLevel: AutoModeLevel
  autoModePaused: boolean
  /**
   * Plan 模式：执行计划是否已获用户批准。
   * auto 模式下忽略；plan 且为 true 时执行期与 auto 相同。
   */
  planApproved: boolean
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

/** 从任务 + 当前全局等级构造审批配置（子代理应复用同一配置以继承父权限）。 */
export function approvalConfigFromTask(
  task: Pick<Task, "autoModeState">,
  level: AutoModeLevel,
): ApprovalConfig {
  return {
    autoModeLevel: level,
    autoModePaused: !!task.autoModeState?.paused,
    planApproved: !!task.autoModeState?.planApproved,
  }
}

/** 创建任务时的初始 auto mode 状态。 */
export function createInitialAutoModeState(level: AutoModeLevel): AutoModeState {
  return {
    level,
    autoApprovedCalls: 0,
    blockedByRules: 0,
    paused: false,
    planApproved: false,
  }
}

/**
 * 同步任务上的 auto mode 快照（等级来自当前全局配置）。
 * 不擅自将 planApproved 置 true；仅在 auto 下该字段不参与决策。
 */
export function syncAutoModeState(task: Task, level: AutoModeLevel): AutoModeState {
  const prev = task.autoModeState
  const next: AutoModeState = {
    level,
    autoApprovedCalls: prev?.autoApprovedCalls ?? 0,
    blockedByRules: prev?.blockedByRules ?? 0,
    paused: prev?.paused ?? false,
    pausedReason: prev?.pausedReason,
    planApproved: prev?.planApproved ?? false,
    planReady: prev?.planReady,
    planContent: prev?.planContent,
  }
  task.autoModeState = next
  return next
}

/**
 * 工具权限决策（唯一策略入口）。
 *
 * - safe：始终放行
 * - paused：非 safe 拒绝
 * - auto：非 safe 自动放行
 * - plan + planApproved：非 safe 自动放行（执行期等同 auto）
 * - plan + !planApproved：非 safe 拒绝（需先批计划，或走单次审批回退）
 */
export function decideToolPermission(
  config: ApprovalConfig,
  toolName: string,
  risk: ToolRiskLevel,
): {
  allowed: boolean
  reason?: string
  /** 是否因 auto/plan 已批而自动放行（用于统计） */
  autoApproved?: boolean
} {
  if (risk === "safe") {
    return { allowed: true }
  }

  if (config.autoModePaused) {
    return { allowed: false, reason: "Auto mode paused" }
  }

  if (config.autoModeLevel === "auto") {
    return { allowed: true, autoApproved: true }
  }

  if (config.autoModeLevel === "plan") {
    if (config.planApproved) {
      return { allowed: true, autoApproved: true }
    }
    return {
      allowed: false,
      reason: `Tool "${toolName}" requires plan approval before execution`,
    }
  }

  return { allowed: false }
}
