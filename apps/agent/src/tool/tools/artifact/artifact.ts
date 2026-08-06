import { Schema } from "effect"
import { promises as fs } from "node:fs"
import { dirname } from "node:path"
import { make, type ContentPart } from "../../framework/definition.js"
import { assertRealPathInside, pathExists, resolveInWorkspace } from "../../filesystem/workspace-paths.js"

/**
 * 将产物写入工作区，并在创建父目录前后都检查真实路径。
 * 这样既拦截 `..` 越界，也避免已存在的符号链接把写入引向工作区外。
 */
export async function writeArtifactToWorkspace(workspaceDir: string, artifactPath: string, content: string): Promise<string> {
  const target = resolveInWorkspace(artifactPath, workspaceDir, [])
  await assertRealPathInside(target, workspaceDir, [])
  await fs.mkdir(dirname(target), { recursive: true })
  await assertRealPathInside(dirname(target), workspaceDir, [])
  await fs.writeFile(target, content, "utf8")
  return target
}

/** 在审批摘要/结果中说明目标是否会被覆盖；仍复用同一边界检查。 */
export async function artifactTargetExists(workspaceDir: string, artifactPath: string): Promise<boolean> {
  const target = resolveInWorkspace(artifactPath, workspaceDir, [])
  await assertRealPathInside(target, workspaceDir, [])
  return pathExists(target)
}

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
  overwritesExisting: Schema.optional(Schema.Boolean),
})

export const createArtifactTool = make({
  name: "create_artifact",
  riskLevel: "dangerous",
  description:
    "Create a persistent artifact (file) with content. Provide optional path to write it into the workspace immediately.",
  input: Input,
  output: Output,
  // 实际落库与事件由 pi-harness 在带 task 上下文时接管；此处为无 task 场景的降级写入。
  execute: async (input, ctx) => {
    const id = `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const target = input.path ?? input.name
    if (input.path) {
      const overwritesExisting = await artifactTargetExists(ctx.workspaceDir, input.path)
      await writeArtifactToWorkspace(ctx.workspaceDir, input.path, input.content)
      return { artifactId: id, path: target, status: "applied", appliedPath: input.path, overwritesExisting }
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
  riskLevel: "dangerous",
  description: "Apply a created artifact to the workspace.",
  input: Schema.Struct({
    artifactId: Schema.String.annotations({ description: "ID of the artifact to apply." }),
    path: Schema.String.annotations({ description: "Target path to write the artifact to." }),
  }),
  output: Schema.Struct({
    applied: Schema.Boolean,
    path: Schema.String,
    overwritesExisting: Schema.optional(Schema.Boolean),
  }),
  execute: async (input, ctx) => {
    const artifact = ctx.task?.artifacts?.find((item) => item.id === input.artifactId)
    if (!artifact) throw new Error(`找不到产物：${input.artifactId}`)
    if (artifact.status === "rejected") throw new Error(`产物已被拒绝，不能应用：${artifact.name}`)
    const overwritesExisting = await artifactTargetExists(ctx.workspaceDir, input.path)
    await writeArtifactToWorkspace(ctx.workspaceDir, input.path, artifact.content)
    return { applied: true, path: input.path, overwritesExisting }
  },
  toModelOutput: (_in, out): ReadonlyArray<ContentPart> => [
    { type: "text", text: out.applied ? `Artifact applied to ${out.path}` : "Artifact not applied" },
  ],
})
