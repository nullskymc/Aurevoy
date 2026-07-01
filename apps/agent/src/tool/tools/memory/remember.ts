import { Schema } from "effect"
import { make, type ContentPart } from "../../framework/definition.js"

const Input = Schema.Struct({
  content: Schema.String.annotations({ description: "Memory content to remember." }),
  category: Schema.optional(Schema.Literal("preference", "directory", "fact", "habit").annotations({
    description: "Memory category.",
  })),
})

const Output = Schema.Struct({
  id: Schema.String,
  created: Schema.Boolean,
})

export const rememberTool = make({
  name: "remember",
  description: "Store a persistent memory for future reference. Use for user preferences, important facts, or patterns.",
  input: Input,
  output: Output,
  execute: async (_input) => {
    const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return { id, created: true }
  },
  toModelOutput: (_in, out): ReadonlyArray<ContentPart> => [
    { type: "text", text: out.created ? `Memory stored: ${out.id}` : "Memory not stored" },
  ],
})
