import { Schema } from "effect"
import { make, type ContentPart } from "../../framework/definition.js"

const Role = Schema.Literal("explore", "research", "coder", "shell", "writer", "general")

const Input = Schema.Struct({
  goal: Schema.String.annotations({ description: "Sub-task goal to delegate." }),
  prompt: Schema.optional(Schema.String.annotations({ description: "Detailed instructions for the sub-agent. Defaults to goal." })),
  role: Schema.optional(Role.annotations({
    description: "Sub-agent role: explore | research | coder | shell | writer | general (default).",
  })),
  tools: Schema.optional(Schema.Array(Schema.String).annotations({ description: "Optional tool allowlist override." })),
  maxIterations: Schema.optional(Schema.Number.annotations({ description: "Maximum iterations for the sub-agent (reserved)." })),
})

const Output = Schema.Struct({
  completed: Schema.Boolean,
  result: Schema.String,
  role: Schema.optional(Schema.String),
  toolCallCount: Schema.optional(Schema.Number),
  iterations: Schema.optional(Schema.Number),
})

export const delegateTool = make({
  name: "delegate",
  description:
    "Delegate a sub-task to a specialized sub-agent. " +
    "Roles: explore (readonly scout), research (web+local), coder (edit code), " +
    "shell (commands), writer (docs/reports), general (broad default). " +
    "Inherits parent auto/plan permissions; cannot nest further delegates.",
  input: Input,
  output: Output,
  execute: async (input, ctx) => {
    const { runSubTask } = await import("../../../agent/subagent.js")
    const { approvalConfigFromTask } = await import("../../../agent/approval.js")
    const { isSubagentRole } = await import("../../../agent/subagent-profiles.js")
    const { config } = await import("../../../config.js")
    const { taskStore } = await import("../../../store/db.js")

    const goal = input.goal.trim()
    const prompt = (input.prompt?.trim() || goal)
    if (!goal) {
      return { completed: false, result: "goal must be a non-empty string" }
    }

    const role = isSubagentRole(input.role) ? input.role : undefined
    const level = config.autoMode.level === "plan" ? ("plan" as const) : ("auto" as const)
    const parentTask = ctx.taskID ? taskStore.get(ctx.taskID) : undefined
    const approvalConfig = parentTask
      ? approvalConfigFromTask(parentTask, level)
      : { autoModeLevel: level, autoModePaused: false, planApproved: level === "auto" }

    const result = await runSubTask({
      goal,
      prompt,
      role,
      allowedTools: input.tools ? [...input.tools] : undefined,
      workspaceDir: ctx.workspaceDir || process.cwd(),
      approvalConfig,
      parentTask: parentTask
        ? { id: parentTask.id, autoModeState: parentTask.autoModeState, goal: parentTask.goal }
        : undefined,
    })

    return {
      completed: result.ok,
      result: result.ok
        ? result.content
        : (result.error ?? (result.content || "sub-agent failed")),
      role: result.role,
      toolCallCount: result.toolCallCount,
      iterations: result.iterations,
    }
  },
  toModelOutput: (_in, out): ReadonlyArray<ContentPart> => [
    { type: "text", text: out.role ? `[${out.role}] ${out.result}` : out.result },
  ],
})
