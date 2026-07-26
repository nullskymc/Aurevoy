import { Schema } from "effect"
import type { PlanStep } from "@aurevoy/shared"
import { make, type ContentPart } from "../../framework/definition.js"

export interface UpdatePlanStepInput {
  id?: string
  description: string
  status?: PlanStep["status"]
  toolsExpected?: readonly string[]
  dependsOn?: readonly string[]
  blockedReason?: string
  verifiable?: boolean
}

const StepStatus = Schema.Literal("pending", "running", "completed", "blocked", "proposed")

const Input = Schema.Struct({
  steps: Schema.Array(Schema.Struct({
    id: Schema.optional(Schema.String),
    description: Schema.String,
    status: Schema.optional(StepStatus),
    toolsExpected: Schema.optional(Schema.Array(Schema.String)),
    dependsOn: Schema.optional(Schema.Array(Schema.String)),
    blockedReason: Schema.optional(Schema.String),
    verifiable: Schema.optional(Schema.Boolean),
  })),
})

const Output = Schema.Struct({
  updated: Schema.Boolean,
  stepCount: Schema.Number,
})

/** 模型显式维护计划；计划模式只记录待执行步骤，不把调研过程伪装成已执行。 */
export const updatePlanTool = make({
  name: "update_plan",
  riskLevel: "safe",
  executionPolicy: { parallelizable: false },
  description: [
    "Create or replace the visible task plan for genuinely multi-step actionable work.",
    "Do not use for simple questions or work completed by the current answer.",
    "In Plan mode, use only when remaining steps require later side-effecting Agent execution; travel advice, explanations, research answers, and other deliverables completed in the current response do not need a plan card.",
    "In Agent mode, update statuses as work progresses.",
  ].join(" "),
  input: Input,
  output: Output,
  execute: async (input, ctx) => {
    const task = ctx.task
    if (!task) return { updated: false, stepCount: 0 }

    const { taskStore } = await import("../../../store/db.js")
    const { taskEvents } = await import("../../../agent/events.js")
    const plan = buildPlanSteps(input.steps, task.executionMode ?? "auto")
    task.plan = plan
    task.updatedAt = new Date().toISOString()
    taskStore.save(task)
    taskEvents.publish({ type: "plan", taskId: task.id, plan })
    taskEvents.publish({ type: "plan_generated", taskId: task.id, plan, source: "llm" })
    return { updated: true, stepCount: plan.length }
  },
  toModelOutput: (_input, output): ReadonlyArray<ContentPart> => [{
    type: "text",
    text: output.updated ? `Plan updated (${output.stepCount} steps).` : "Plan was not updated.",
  }],
})

/** 将模型输入规范化为持久计划；导出纯函数便于验证模式边界。 */
export function buildPlanSteps(
  steps: readonly UpdatePlanStepInput[],
  mode: "auto" | "plan",
): PlanStep[] {
  const usedIds = new Set<string>()
  const ids = steps.map((step, index) => {
    const candidate = normalizeStepId(step.id, index)
    const id = usedIds.has(candidate) ? `step-${index + 1}` : candidate
    usedIds.add(id)
    return id
  })
  const idSet = new Set(ids)
  return steps
      .map((step, index): PlanStep | null => {
        const description = step.description.trim()
        if (!description) return null
        return {
          id: ids[index]!,
          description,
          status: mode === "plan"
            ? "proposed"
            : step.status ?? (index === 0 ? "running" : "pending"),
          toolsExpected: cleanStrings(step.toolsExpected),
          dependsOn: cleanStrings(step.dependsOn)?.filter((id) => idSet.has(id)),
          blockedReason: step.blockedReason?.trim() || undefined,
          verifiable: step.verifiable,
          source: "llm",
        }
      })
      .filter((step): step is PlanStep => step !== null)
}

function normalizeStepId(value: string | undefined, index: number): string {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  return normalized ? normalized.slice(0, 64) : `step-${index + 1}`
}

function cleanStrings(values: readonly string[] | undefined): string[] | undefined {
  const cleaned = [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))]
  return cleaned.length > 0 ? cleaned : undefined
}
