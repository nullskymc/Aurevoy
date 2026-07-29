import { Schema } from "effect"
import { resolve } from "node:path"
import { promises as fs } from "node:fs"
import { diffLines } from "diff"
import { make, type ContentPart } from "../../framework/definition.js"

const normalizeLineEndings = (text: string): string => text.replaceAll("\r\n", "\n")
const detectLineEnding = (text: string): "\n" | "\r\n" =>
  text.includes("\r\n") ? "\r\n" : "\n"
const convertToLineEnding = (text: string, ending: "\n" | "\r\n"): string =>
  ending === "\n" ? normalizeLineEndings(text) : normalizeLineEndings(text).replaceAll("\n", "\r\n")

const countOccurrences = (content: string, search: string): number => {
  if (search === "") return content.length + 1
  let count = 0
  let offset = 0
  while ((offset = content.indexOf(search, offset)) !== -1) {
    count++
    offset += search.length
  }
  return count
}

const Input = Schema.Struct({
  path: Schema.String.annotations({
    description: "File path to edit. Relative paths resolve from the workspace root.",
  }),
  oldString: Schema.String.annotations({ description: "Exact text to replace." }),
  newString: Schema.String.annotations({
    description: "Replacement text, which must differ from oldString.",
  }),
  replaceAll: Schema.optional(Schema.Boolean.annotations({
    description: "Replace all exact occurrences of oldString (default false).",
  })),
})

const Output = Schema.Struct({
  replacements: Schema.Number,
  file: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
})

const previewLines = (value: string, prefix: "+" | "-"): string[] => {
  const lines = normalizeLineEndings(value).split("\n")
  const shown = lines.slice(0, 6).map(
    (line) => `${prefix}${line.length > 240 ? `${line.slice(0, 240)}...` : line}`,
  )
  if (lines.length > shown.length) shown.push(`${prefix}...`)
  return shown
}

export const editTool = make({
  name: "edit",
  riskLevel: "dangerous",
  executionPolicy: { parallelizable: false },
  description:
    "Preferred way to revise an existing file: replace exact oldString with newString (include enough surrounding context so the match is unique). " +
    "Use this for report/section fixes, wording, and small structural changes instead of rewrite-via-write. " +
    "oldString must match exactly including whitespace and indentation; set replaceAll=true only when every occurrence should change. " +
    "Relative paths resolve from the workspace root. To create a new file or intentionally replace the entire file, use write.",
  input: Input,
  output: Output,
  execute: async (input, ctx) => {
    const path = resolve(ctx.workspaceDir, input.path)

    if (input.oldString === input.newString) {
      throw new Error("No changes: oldString and newString are identical.")
    }
    if (input.oldString === "") {
      throw new Error("oldString must not be empty. Use write to create or overwrite a file.")
    }

    const source = await fs.readFile(path, "utf-8")
    const ending = detectLineEnding(source)
    const oldString = convertToLineEnding(input.oldString, ending)
    const newString = convertToLineEnding(input.newString, ending)

    const occurrences = countOccurrences(source, oldString)
    if (occurrences === 0) {
      throw new Error(
        "Could not find oldString in the file. It must match exactly, including whitespace and indentation.",
      )
    }
    if (occurrences > 1 && input.replaceAll !== true) {
      throw new Error(
        "Found multiple exact matches for oldString. Provide more surrounding context or set replaceAll to true.",
      )
    }

    const replaced =
      input.replaceAll === true
        ? source.replaceAll(oldString, newString)
        : source.replace(oldString, newString)

    const counts = diffLines(source, replaced).reduce(
      (result, item) => ({
        additions: result.additions + (item.added ? (item.count ?? 0) : 0),
        deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
      }),
      { additions: 0, deletions: 0 },
    )

    await fs.writeFile(path, replaced, "utf-8")

    return {
      replacements: occurrences,
      file: input.path,
      ...counts,
    }
  },
  toModelOutput: (input, output): ReadonlyArray<ContentPart> => [
    {
      type: "text",
      text: [
        `Edited file: ${output.file}`,
        `Replacements: ${output.replacements}`,
        `Lines: +${output.additions} -${output.deletions}`,
        "```diff",
        ...previewLines(input.oldString, "-"),
        ...previewLines(input.newString, "+"),
        "```",
      ].join("\n"),
    },
  ],
})
