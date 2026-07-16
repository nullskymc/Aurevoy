import { Schema } from "effect"
import { resolve } from "node:path"
import { promises as fs } from "node:fs"
import { make, type ContentPart } from "../../framework/definition.js"

const Input = Schema.Struct({
  path: Schema.String.annotations({
    description: "File path to write. Relative paths resolve from the workspace root.",
  }),
  content: Schema.String.annotations({
    description: "Full file content for create / overwrite / append. Prefer the edit tool for small changes to an existing file.",
  }),
  mode: Schema.optional(Schema.Literal("create", "overwrite", "append").annotations({
    description:
      "create: fail if the file exists. " +
      "overwrite: replace the entire file (required when the file already exists). " +
      "append: add to the end. " +
      "Omit mode only when creating a new file; existing files need an explicit mode.",
  })),
})

const Output = Schema.Struct({
  operation: Schema.Literal("created", "wrote", "appended"),
  resource: Schema.String,
  existed: Schema.Boolean,
  note: Schema.optional(Schema.String),
})

export const writeTool = make({
  name: "write",
  description:
    "Create a new file or intentionally rewrite/append an entire file. " +
    "For local revisions to an existing file, prefer `edit` (exact oldString → newString) instead of rewriting the whole document. " +
    "If the path already exists you must pass mode=\"overwrite\" (full replace) or mode=\"append\"; omitting mode fails so accidental full rewrites are harder. " +
    "Preserves UTF-8 BOM when overwriting a file that already has one. Relative paths resolve from the workspace root.",
  input: Input,
  output: Output,
  execute: async (input, ctx) => {
    const path = resolve(ctx.workspaceDir, input.path)

    let existed = false
    try {
      const s = await fs.stat(path)
      existed = s.isFile()
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== "ENOENT") throw err
    }

    // 已存在文件必须显式 mode，避免模型默认 overwrite 把报告整篇重写。
    let mode = input.mode
    if (existed) {
      if (mode === undefined) {
        throw new Error(
          `File already exists: ${input.path}. ` +
            `For small/local changes use the edit tool (oldString → newString). ` +
            `For intentional full rewrite pass mode="overwrite". To add at the end pass mode="append".`,
        )
      }
      if (mode === "create") {
        throw new Error(`File already exists: ${input.path}. Use edit for partial changes, or mode="overwrite" / mode="append".`)
      }
    } else {
      // 新文件：未指定 mode 视为创建
      mode = mode ?? "create"
      if (mode === "append") {
        // 不存在时 append 等价于创建
        mode = "create"
      }
    }

    let existingBom = false
    if (mode === "overwrite" && existed) {
      const raw = await fs.readFile(path)
      const decoded = new TextDecoder("utf-8").decode(raw)
      existingBom = decoded.startsWith("\uFEFF")
    }

    const output = existingBom ? `\uFEFF${input.content}` : input.content

    if (mode === "append") {
      await fs.appendFile(path, output, "utf-8")
      return { operation: "appended" as const, resource: input.path, existed: true }
    }

    await fs.writeFile(path, output, "utf-8")
    return {
      operation: existed ? "wrote" as const : "created" as const,
      resource: input.path,
      existed,
      note:
        existed && mode === "overwrite"
          ? "Full file overwrite applied. Prefer edit for future small revisions of this path."
          : undefined,
    }
  },
  toModelOutput: (_input, output): ReadonlyArray<ContentPart> => {
    const head =
      output.operation === "created"
        ? `Created file: ${output.resource}`
        : output.operation === "appended"
          ? `Appended to: ${output.resource}`
          : `Wrote file (full overwrite): ${output.resource}`
    return [{ type: "text", text: output.note ? `${head}\n${output.note}` : head }]
  },
})
