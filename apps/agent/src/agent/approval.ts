export type ToolRiskLevel = "safe" | "caution" | "dangerous"
export type AutoModeLevel = "off" | "plan" | "auto-edit" | "full"

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

const AUTO_EDIT_WRITE_TOOLS = new Set([
  "apply_artifact",
  "append_file",
  "bundle_report",
  "copy_file",
  "create_artifact",
  "create_file",
  "edit",
  "edit_lines",
  "move_file",
  "rename_file",
  "session_close",
  "session_open",
  "session_write",
  "write",
  "write_file",
])

const ALWAYS_MANUAL_TOOLS = new Set([
  "bash",
  "delete_file",
  "execute_command",
  "install_skill",
])

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

  if (config.autoModePaused || config.autoModeLevel === "off") {
    return { allowed: false, reason: "Auto mode is off or paused" }
  }

  if (config.autoModeLevel === "plan") {
    return { allowed: false, reason: `Tool "${toolName}" is not available in Plan mode` }
  }

  if (config.autoModeLevel === "full") {
    return { allowed: true }
  }

  if (config.autoModeLevel === "auto-edit") {
    if (risk === "caution") return { allowed: true }
    if (AUTO_EDIT_WRITE_TOOLS.has(toolName) && !ALWAYS_MANUAL_TOOLS.has(toolName)) {
      return { allowed: true }
    }
    return { allowed: false, reason: `Tool "${toolName}" requires one-time approval in Auto-edit mode` }
  }

  return { allowed: false }
}


