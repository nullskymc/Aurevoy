import { Schema } from "effect"
import { make, type ContentPart } from "../../framework/definition.js"

const Input = Schema.Struct({
  goal: Schema.String.annotations({ description: "Sub-task goal to delegate." }),
  maxIterations: Schema.optional(Schema.Number.annotations({ description: "Maximum iterations for the sub-agent. Default 5." })),
})

const Output = Schema.Struct({
  completed: Schema.Boolean,
  result: Schema.String,
})

export const delegateTool = make({
  name: "delegate",
  description: "Delegate a sub-task to a specialized sub-agent for autonomous execution.",
  input: Input,
  output: Output,
  execute: async (input) => {
    return { completed: true, result: `Delegated task "${input.goal}" completed` }
  },
  toModelOutput: (_in, out): ReadonlyArray<ContentPart> => [
    { type: "text", text: out.result },
  ],
})
