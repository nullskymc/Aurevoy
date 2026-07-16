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
})

const Output = Schema.Struct({
  runId: Schema.String,
  completed: Schema.Boolean,
  result: Schema.String,
  role: Schema.optional(Schema.String),
  toolCallCount: Schema.optional(Schema.Number),
  iterations: Schema.optional(Schema.Number),
  stopReason: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
  truncated: Schema.optional(Schema.Boolean),
})

export const delegateTool = make({
  name: "delegate",
  description:
    "Delegate an independent sub-task to a specialized sub-agent; you keep the user conversation and final answer. " +
    "Roles: explore (readonly scout), research (web+local), coder (edit code), " +
    "shell (commands), writer (docs/reports), general (broad default). " +
    "Use for parallel scouting/research or focused coding/docs work that would bloat your context. " +
    "Issue multiple delegate calls in one turn only for independent parallel work. " +
    "Skip for trivial single-file edits or tightly sequential steps. " +
    "Inherits parent agent permissions; cannot nest further delegates.",
  input: Input,
  output: Output,
  execute: async (input, ctx) => {
    const { runSubTask } = await import("../../../agent/subagent.js")
    const { approvalConfigFromTask } = await import("../../../agent/approval.js")
    const { isSubagentRole } = await import("../../../agent/subagent-profiles.js")
    const { taskStore } = await import("../../../store/db.js")
    const { completeSubagentRun, recordSubagentProgress } = await import("../../../agent/subagent-state.js")

    const goal = input.goal.trim()
    const prompt = (input.prompt?.trim() || goal)
    if (!goal) {
      return {
        runId: "not-started",
        completed: false,
        result: "goal must be a non-empty string",
        stopReason: "error",
      }
    }

    const role = isSubagentRole(input.role) ? input.role : undefined
    const subagentRole = role ?? "general"
    const parentTask = ctx.task ?? (ctx.taskID ? taskStore.get(ctx.taskID) : undefined)
    const approvalConfig = parentTask
      ? approvalConfigFromTask(parentTask, "auto")
      : { autoModeLevel: "auto" as const, autoModePaused: false }

    const result = await runSubTask({
      goal,
      prompt,
      role,
      allowedTools: input.tools ? [...input.tools] : undefined,
      workspaceDir: ctx.workspaceDir || process.cwd(),
      signal: ctx.abortSignal,
      parentCallId: ctx.toolCallID,
      externalPaths: [...ctx.externalPaths],
      publishEvent: ctx.publishEvent,
      onProgress: (progress) => {
        if (parentTask && progress.phase !== "completed") {
          recordSubagentProgress(parentTask, ctx.toolCallID, subagentRole, goal, progress)
        }
        ctx.publishEvent?.({
          type: "tool_progress",
          taskId: ctx.taskID,
          callId: ctx.toolCallID,
          message: progress.message,
        })
      },
      approvalConfig,
      parentTask,
    })
    if (parentTask) {
      completeSubagentRun(parentTask, ctx.toolCallID, result.role, goal, result)
    }

    return {
      runId: result.runId,
      completed: result.ok,
      result: result.ok
        ? result.content
        : [result.error, result.content].filter(Boolean).join("\n\n") || "sub-agent failed",
      role: result.role,
      toolCallCount: result.toolCallCount,
      iterations: result.iterations,
      stopReason: result.stopReason,
      durationMs: result.durationMs,
      truncated: result.truncated,
    }
  },
  toModelOutput: (_in, out): ReadonlyArray<ContentPart> => [
    { type: "text", text: out.role ? `[${out.role}] ${out.result}` : out.result },
  ],
})
