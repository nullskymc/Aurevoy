import { Schema } from "effect"
import { make, type ContentPart } from "../../framework/definition.js"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { resolve } from "node:path"

const execFileAsync = promisify(execFile)

const Input = Schema.Struct({
  pattern: Schema.String.annotations({
    description: "Regex pattern to search for in file contents.",
  }),
  path: Schema.optional(Schema.String.annotations({
    description: "Directory or file to search. Defaults to workspace root.",
  })),
  include: Schema.optional(Schema.String.annotations({
    description: 'File glob to include in the search, e.g. "*.js" or "*.{ts,tsx}".',
  })),
  limit: Schema.optional(Schema.Number.annotations({
    description: "Maximum matches to return. Default 100.",
  })),
})

const Output = Schema.Array(Schema.Struct({
  path: Schema.String,
  line: Schema.Number,
  text: Schema.String,
}))

export const grepTool = make({
  name: "grep",
  description:
    "Search file contents by regular expression. Use path to narrow the search, include to filter files by glob, and limit to bound the match count. Returns file paths, line numbers, and matched text.",
  input: Input,
  output: Output,
  execute: async (input) => {
    const cwd = input.path ? resolve(process.cwd(), input.path) : process.cwd()
    const limit = input.limit ?? 100
    const args = ["-rni", "--binary-files=without-match", "-m", String(limit)]

    if (input.include) {
      args.push("--include", input.include)
    }
    args.push("-e", input.pattern, cwd)

    try {
      const { stdout } = await execFileAsync("grep", args, {
        maxBuffer: 512 * 1024,
        timeout: 15000,
      })
      const lines = stdout.trim().split("\n").filter(Boolean)
      return lines.slice(0, limit).map((line) => {
        const colon = line.indexOf(":")
        const file = line.slice(0, colon)
        const rest = line.slice(colon + 1)
        const colon2 = rest.indexOf(":")
        const lineNum = parseInt(rest.slice(0, colon2), 10)
        const text = rest.slice(colon2 + 1)
        return { path: file, line: lineNum, text }
      })
    } catch (err: unknown) {
      const e = err as { code?: string; stderr?: string }
      if (e.code === "ENOENT") {
        throw new Error("grep command not available. Install grep to use this tool.")
      }
      return []
    }
  },
  toModelOutput: (_input, output): ReadonlyArray<ContentPart> => {
    if (output.length === 0) return [{ type: "text", text: "No matches found" }]
    const lines: string[] = []
    let current = ""
    for (const match of output) {
      if (current !== match.path) {
        if (current) lines.push("")
        current = match.path
        lines.push(`${match.path}:`)
      }
      lines.push(`  Line ${match.line}: ${match.text}`)
    }
    return [{ type: "text", text: lines.join("\n") }]
  },
})
