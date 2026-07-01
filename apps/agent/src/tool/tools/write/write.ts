import { Schema } from "effect"
import { resolve } from "node:path"
import { promises as fs } from "node:fs"
import { make, type ContentPart } from "../../framework/definition.js"

const Input = Schema.Struct({
  path: Schema.String.annotations({
    description: "File path to write. Relative paths resolve from the workspace root.",
  }),
  content: Schema.String.annotations({
    description: "Content to write to the file.",
  }),
  mode: Schema.optional(Schema.Literal("create", "overwrite", "append").annotations({
    description: "Write mode: create (fail if exists), overwrite (default, replaces existing), append (adds to end).",
  })),
})

const Output = Schema.Struct({
  operation: Schema.Literal("created", "wrote", "appended"),
  resource: Schema.String,
  existed: Schema.Boolean,
})

export const writeTool = make({
  name: "write",
  description:
    "Write content to a file. Supports create (fail if exists), overwrite (default), and append modes. " +
    "Preserves UTF-8 BOM if the file already has one. Relative paths resolve from the workspace root.",
  input: Input,
  output: Output,
  execute: async (input) => {
    const path = resolve(process.cwd(), input.path)
    const mode = input.mode ?? "overwrite"

    if (mode === "create") {
      try {
        await fs.stat(path)
        throw new Error(`File already exists: ${input.path}. Use overwrite mode to replace.`)
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException
        if (e.code !== "ENOENT") throw err
      }
    }

    let existed = false
    try {
      const s = await fs.stat(path)
      existed = s.isFile()
    } catch {}

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
    }
  },
  toModelOutput: (_input, output): ReadonlyArray<ContentPart> => [
    { type: "text", text: output.operation === "created" ? `Created file: ${output.resource}` : output.operation === "appended" ? `Appended to: ${output.resource}` : `Wrote file: ${output.resource}` },
  ],
})
