import { Schema } from "effect"
import { make, type ContentPart } from "../../framework/definition.js"

const Input = Schema.Struct({
  message: Schema.String.annotations({ description: "Message to display to the user asking for clarification." }),
})

const Output = Schema.Struct({
  answered: Schema.Boolean,
  answer: Schema.String,
})

export const askUserTool = make({
  name: "ask_user",
  description: "Ask the user a question and wait for their response. Use when you need clarification before proceeding.",
  input: Input,
  output: Output,
  execute: async () => {
    return { answered: true, answer: "User response will be handled by the Pi harness adapter" }
  },
  toModelOutput: (_in, out): ReadonlyArray<ContentPart> => [
    { type: "text", text: out.answered ? `Answer: ${out.answer}` : "No answer received" },
  ],
})
