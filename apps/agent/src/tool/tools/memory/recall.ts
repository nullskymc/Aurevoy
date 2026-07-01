import { Schema } from "effect"
import { make, type ContentPart } from "../../framework/definition.js"

const Input = Schema.Struct({
  query: Schema.String.annotations({ description: "Search query for relevant memories." }),
  topK: Schema.optional(Schema.Number.annotations({ description: "Number of memories to return. Default 5." })),
})

const Output = Schema.Array(Schema.Struct({
  id: Schema.String,
  content: Schema.String,
  category: Schema.String,
  confidence: Schema.Number,
}))

export const recallTool = make({
  name: "recall",
  description: "Recall stored memories matching a query.",
  input: Input,
  output: Output,
  execute: async () => {
    return []
  },
  toModelOutput: (_in, out): ReadonlyArray<ContentPart> => {
    if (out.length === 0) return [{ type: "text", text: "No matching memories found" }]
    return [{ type: "text", text: out.map((m) => `[${m.category}] ${m.content}`).join("\n") }]
  },
})
