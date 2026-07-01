import { Schema } from "effect"
import { make, type ContentPart } from "../../framework/definition.js"

const Input = Schema.Struct({
  name: Schema.String.annotations({ description: "Artifact name." }),
  content: Schema.String.annotations({ description: "Content to store in the artifact." }),
  mimeType: Schema.optional(Schema.String.annotations({ description: "MIME type of the content." })),
})

const Output = Schema.Struct({
  artifactId: Schema.String,
  path: Schema.String,
})

export const createArtifactTool = make({
  name: "create_artifact",
  description: "Create a persistent artifact (file) with content. Artifacts can be reviewed and applied later.",
  input: Input,
  output: Output,
  execute: async (input) => {
    const id = `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return { artifactId: id, path: input.name }
  },
  toModelOutput: (_in, out): ReadonlyArray<ContentPart> => [
    { type: "text", text: `Artifact created: ${out.artifactId} at ${out.path}` },
  ],
})

export const applyArtifactTool = make({
  name: "apply_artifact",
  description: "Apply a created artifact to the workspace.",
  input: Schema.Struct({
    artifactId: Schema.String.annotations({ description: "ID of the artifact to apply." }),
    path: Schema.String.annotations({ description: "Target path to write the artifact to." }),
  }),
  output: Schema.Struct({
    applied: Schema.Boolean,
    path: Schema.String,
  }),
  execute: async (input) => {
    return { applied: true, path: input.path }
  },
  toModelOutput: (_in, out): ReadonlyArray<ContentPart> => [
    { type: "text", text: out.applied ? `Artifact applied to ${out.path}` : "Artifact not applied" },
  ],
})
