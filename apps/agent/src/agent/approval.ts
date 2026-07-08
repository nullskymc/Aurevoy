import type { AutoModeLevel } from "@aurevoy/shared"

export type ToolRiskLevel = "safe" | "caution" | "dangerous"

export interface ApprovalConfig {
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

export function decideToolPermission(
  config: ApprovalConfig,
  toolName: string,
  risk: ToolRiskLevel,
): {
  allowed: boolean
  reason?: string
} {
  if (risk === "safe") {
    return { allowed: true }
  }

  if (config.autoModePaused) {
    return { allowed: false, reason: "Auto mode paused" }
  }

  if (config.autoModeLevel === "auto") {
    return { allowed: true }
  }

  if (config.autoModeLevel === "plan") {
    return { allowed: false, reason: `Tool "${toolName}" requires plan approval before execution` }
  }

  return { allowed: false }
}
