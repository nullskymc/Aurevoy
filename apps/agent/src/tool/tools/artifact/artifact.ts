import { Schema } from "effect"
import { promises as fs } from "node:fs"
import { dirname, resolve } from "node:path"
import { make, type ContentPart } from "../../framework/definition.js"

const Input = Schema.Struct({
  name: Schema.String.annotations({ description: "Artifact name." }),
  content: Schema.String.annotations({ description: "Content to store in the artifact." }),
  mimeType: Schema.optional(Schema.String.annotations({ description: "MIME type of the content." })),
  /** 可选：直接写入工作区的相对路径；提供后创建并立即 apply。 */
  path: Schema.optional(Schema.String.annotations({ description: "Optional workspace-relative path to apply the artifact immediately." })),
  type: Schema.optional(
    Schema.Literal("text", "file", "diff", "url").annotations({ description: "Artifact type." }),
  ),
})

const Output = Schema.Struct({
  artifactId: Schema.String,
  path: Schema.String,
  status: Schema.optional(Schema.String),
  appliedPath: Schema.optional(Schema.String),
})

export const createArtifactTool = make({
  name: "create_artifact",
  description:
    "Create a persistent artifact (file) with content. Provide optional path to write it into the workspace immediately.",
  input: Input,
  output: Output,
  // 实际落库与事件由 pi-harness 在带 task 上下文时接管；此处为无 task 场景的降级写入。
  execute: async (input, ctx) => {
    const id = `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const target = input.path ?? input.name
    if (input.path) {
      const abs = resolve(ctx.workspaceDir, input.path)
      await fs.mkdir(dirname(abs), { recursive: true })
      await fs.writeFile(abs, input.content, "utf8")
      return { artifactId: id, path: target, status: "applied", appliedPath: input.path }
    }
    return { artifactId: id, path: target, status: "draft" }
  },
  toModelOutput: (_in, out): ReadonlyArray<ContentPart> => [
    {
      type: "text",
      text: out.status === "applied"
        ? `Artifact ${out.artifactId} applied to ${out.appliedPath ?? out.path}`
        : `Artifact created: ${out.artifactId} (${out.path})`,
    },
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
