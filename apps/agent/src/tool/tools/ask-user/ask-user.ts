import { Schema } from "effect"
import { make, type ContentPart } from "../../framework/definition.js"

/**
 * 与 pi-harness executeAskUserTool 对齐：
 * - message / question：用户可见问题（二选一，message 优先）
 * - options / context：可选引导
 */
const Input = Schema.Struct({
  message: Schema.optional(
    Schema.String.annotations({ description: "Message to display to the user asking for clarification." }),
  ),
  question: Schema.optional(
    Schema.String.annotations({ description: "Alias of message (legacy / model-friendly)." }),
  ),
  options: Schema.optional(
    Schema.Array(Schema.String).annotations({ description: "Optional multiple-choice options." }),
  ),
  context: Schema.optional(
    Schema.String.annotations({ description: "Optional background context for the question." }),
  ),
})

const Output = Schema.Struct({
  answered: Schema.Boolean,
  answer: Schema.String,
})

export const askUserTool = make({
  name: "ask_user",
  description:
    "Ask the user a question and wait for their response. Use when you need clarification before proceeding. Prefer field `message` (or `question`).",
  input: Input,
  output: Output,
  execute: async () => {
    // 实际交互由 pi-harness 的 executeAskUserTool 接管；此处仅为 Schema/注册占位。
    return { answered: true, answer: "User response will be handled by the Pi harness adapter" }
  },
  toModelOutput: (_in, out): ReadonlyArray<ContentPart> => [
    { type: "text", text: out.answered ? `Answer: ${out.answer}` : "No answer received" },
  ],
})
