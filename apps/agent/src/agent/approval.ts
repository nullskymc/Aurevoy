export type ToolRiskLevel = "safe" | "caution" | "dangerous"
export type AutoModeLevel = "off" | "plan" | "auto-edit" | "full"

export interface ApprovalConfig {
  autoModeLevel: AutoModeLevel
  autoModePaused: boolean
  approvedApprovalKeys: string[]
  sessionApprovedCallIds: Set<string>
}

export interface ApprovalRequest {
  callId: string
  toolName: string
  risk: ToolRiskLevel
  args: Record<string, unknown>
}

export type ApprovalDecision =
  | { approved: false }
  | { approved: true; sessionApprove: boolean; prefixKey?: string }

const APPROVAL_FREE_TOOLS = new Set([
  "list_directory", "load_skill", "open_file", "scroll", "search_grep",
  "read", "grep", "glob",
])

const PLANMODE_TOOLS = new Set([
  "list_directory", "get_current_time", "load_skill",
  "open_file", "scroll", "search_grep",
  "read", "grep", "glob",
])

const AUTO_EDIT_TOOLS = new Set([
  ...PLANMODE_TOOLS,
  "apply_artifact", "move_file", "copy_file", "rename_file",
  "create_file", "write_file", "edit_lines", "append_file",
  "session_open", "session_write", "session_close",
  "create_artifact",
  "write", "edit",
])

const EXECUTION_POLICY = new Map<string, { parallelizable: boolean; waitsFor?: string[] }>()
for (const name of ["load_skill", "install_skill", "edit"]) {
  EXECUTION_POLICY.set(name, { parallelizable: false })
}
for (const name of ["ask_user", "delegate"]) {
  EXECUTION_POLICY.set(name, { parallelizable: false })
}

export function approvalKeyForCall(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "execute_command" || toolName === "bash") {
    return JSON.stringify({ tool: toolName, command: args.command, args, cwd: args.workdir })
  }
  return `tool:${toolName}`
}

export function prefixApprovalKeyForCall(toolName: string, args: Record<string, unknown>): string | undefined {
  if (toolName === "execute_command" || toolName === "bash") {
    const command = typeof args.command === "string" ? args.command.trim() : ""
    const prefix = command.split(/\s+/)[0]
    if (prefix) return `cmd:${prefix}`
  }
}

export function isApprovalFree(toolName: string): boolean {
  return APPROVAL_FREE_TOOLS.has(toolName)
}

export function isPlanModeTool(toolName: string): boolean {
  return PLANMODE_TOOLS.has(toolName)
}

export function isAutoEditTool(toolName: string): boolean {
  return AUTO_EDIT_TOOLS.has(toolName)
}

export function executionPolicyOf(toolName: string): { parallelizable: boolean; waitsFor?: string[] } {
  return EXECUTION_POLICY.get(toolName) ?? { parallelizable: true }
}

export function computeAutoApproval(
  config: ApprovalConfig,
  toolName: string,
  _risk: ToolRiskLevel,
  args: Record<string, unknown>,
  _riskLevelOf: (name: string) => ToolRiskLevel,
): {
  autoApproved: boolean
  reason?: string
} {
  if (isApprovalFree(toolName)) {
    return { autoApproved: true }
  }

  const approvalKey = approvalKeyForCall(toolName, args)
  if (config.approvedApprovalKeys.includes(approvalKey)) {
    return { autoApproved: true }
  }

  const prefixKey = prefixApprovalKeyForCall(toolName, args)
  if (prefixKey && config.approvedApprovalKeys.includes(prefixKey)) {
    return { autoApproved: true }
  }

  if (config.autoModePaused || config.autoModeLevel === "off") {
    return { autoApproved: false, reason: "Auto mode is off or paused" }
  }

  if (config.autoModeLevel === "plan") {
    if (isPlanModeTool(toolName)) return { autoApproved: true }
    return { autoApproved: false, reason: `Tool "${toolName}" not available in Plan Mode` }
  }

  if (config.autoModeLevel === "full") {
    return { autoApproved: true }
  }

  if (config.autoModeLevel === "auto-edit") {
    if (isAutoEditTool(toolName)) return { autoApproved: true }
    return { autoApproved: false, reason: `Tool "${toolName}" requires manual approval in auto-edit mode` }
  }

  return { autoApproved: false }
}

export function partitionCalls(
  calls: Array<{
    callId: string
    toolName: string
    args: Record<string, unknown>
    risk: ToolRiskLevel
    autoApproved: boolean
    skipReason?: string
  }>,
) {
  const skipped: typeof calls = []
  const safe: typeof calls = []
  const sequential: typeof calls = []
  const needsApproval: typeof calls = []

  for (const c of calls) {
    if (c.skipReason) {
      skipped.push(c)
      continue
    }
    if (!c.autoApproved) {
      needsApproval.push(c)
      continue
    }
    const policy = executionPolicyOf(c.toolName)
    if (policy.parallelizable === false) {
      sequential.push(c)
    } else {
      safe.push(c)
    }
  }

  return { skipped, safe, sequential, needsApproval }
}
