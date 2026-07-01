import { Schema } from "effect"
import { make, type ContentPart } from "../../framework/definition.js"
import { readdir } from "node:fs/promises"
import { resolve, relative, join, basename } from "node:path"
import { minimatch } from "minimatch"

const matchGlob = (filePath: string, pattern: string): boolean => {
  const name = basename(filePath)
  if (pattern.includes("/")) return minimatch(filePath, pattern, { dot: true })
  if (pattern.includes("**")) return minimatch(relative(".", filePath), pattern, { dot: true })
  return minimatch(name, pattern, { dot: true })
}

async function scanRecursive(dir: string, pattern: string, limit: number): Promise<Array<{ path: string; type: "file" | "directory" }>> {
  const results: Array<{ path: string; type: "file" | "directory" }> = []
  const queue = [dir]

  while (queue.length > 0 && results.length < limit) {
    const current = queue.shift()!
    let entries
    try { entries = await readdir(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (results.length >= limit) break
      if (entry.name.startsWith(".") && !pattern.startsWith(".")) continue
      if (entry.name === "node_modules" || entry.name === ".git") continue
      const full = join(current, entry.name)
      const rel = relative(dir, full)
      if (entry.isDirectory()) {
        queue.push(full)
      }
      if (!entry.isFile() && !entry.isDirectory()) continue
      const type = entry.isDirectory() ? "directory" as const : "file" as const
      if (matchGlob(rel, pattern)) {
        results.push({ path: rel + (type === "directory" ? "/" : ""), type })
      }
    }
  }
  return results.slice(0, limit)
}

const Input = Schema.Struct({
  pattern: Schema.String.annotations({
    description: "Glob pattern to match files against, e.g. '**/*.ts' or 'src/**/*.tsx'.",
  }),
  path: Schema.optional(Schema.String.annotations({
    description: "Relative directory to search. Defaults to workspace root.",
  })),
  limit: Schema.optional(Schema.Number.annotations({
    description: "Maximum results to return. Default 200.",
  })),
})

const Output = Schema.Array(Schema.Struct({
  path: Schema.String,
  type: Schema.Literal("file", "directory"),
}))

export const globTool = make({
  name: "glob",
  description: "Find files by glob pattern. Use ** to match directories recursively. Returns relative file paths.",
  input: Input,
  output: Output,
  execute: async (input) => {
    const cwd = input.path ? resolve(process.cwd(), input.path) : process.cwd()
    const limit = input.limit ?? 200
    return scanRecursive(cwd, input.pattern, limit)
  },
  toModelOutput: (_input, output): ReadonlyArray<ContentPart> => {
    if (output.length === 0) return [{ type: "text", text: "No files found" }]
    return [{ type: "text", text: output.map((e) => e.path).join("\n") }]
  },
})
