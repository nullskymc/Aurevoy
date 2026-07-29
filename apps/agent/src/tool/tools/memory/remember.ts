import { Schema } from "effect"
import { randomUUID } from "node:crypto"
import type { MemoryCategory, MemoryEntry } from "@aurevoy/shared"
import { make, type ContentPart } from "../../framework/definition.js"
import { invalidateMemorySummary, memoryStore } from "../../../store/db.js"

/** 与 shared 的 MemoryCategory 对齐；模型不传时归入 other。 */
const CATEGORIES = ["preference", "directory", "model", "habit", "fact", "other"] as const

const Input = Schema.Struct({
  content: Schema.String.annotations({ description: "Memory content to remember." }),
  category: Schema.optional(Schema.Literal(...CATEGORIES).annotations({
    description: "Memory category. Defaults to other.",
  })),
  confidence: Schema.optional(Schema.Number.annotations({
    description: "Confidence 0~1 that this is worth remembering long-term. Default 0.8.",
  })),
  why: Schema.optional(Schema.String.annotations({
    description: "Why this is worth remembering — shown to the user for auditability.",
  })),
  howToApply: Schema.optional(Schema.String.annotations({
    description: "When and how a future turn should use this memory.",
  })),
})

const Output = Schema.Struct({
  id: Schema.String,
  created: Schema.Boolean,
})

export const rememberTool = make({
  name: "remember",
  riskLevel: "safe",
  description:
    "Store a persistent memory for future reference. Use for user preferences, important facts, or patterns. " +
    "Memories are user-visible and editable; record why it matters so the user can audit it.",
  input: Input,
  output: Output,
  execute: async (input, ctx) => {
    const content = input.content.trim()
    // 写入前失败，好过写一条空记忆再谎报成功。
    if (!content) throw new Error("remember: content 不能为空")

    const now = new Date().toISOString()
    const entry: MemoryEntry = {
      id: randomUUID(),
      category: (input.category ?? "other") as MemoryCategory,
      content,
      confidence: clampConfidence(input.confidence),
      enabled: true,
      source: {
        origin: "agent",
        taskId: ctx.taskID || undefined,
        taskGoal: ctx.task?.goal,
        createdAt: now,
      },
      createdAt: now,
      updatedAt: now,
      why: input.why?.trim() || undefined,
      howToApply: input.howToApply?.trim() || undefined,
    }

    memoryStore.create(entry)
    // 记忆摘要有缓存，不失效的话本轮之后的上下文读不到这条。
    invalidateMemorySummary()
    return { id: entry.id, created: true }
  },
  toModelOutput: (_in, out): ReadonlyArray<ContentPart> => [
    { type: "text", text: out.created ? `Memory stored: ${out.id}` : "Memory not stored" },
  ],
})

function clampConfidence(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.8
  return Math.min(1, Math.max(0, value))
}
