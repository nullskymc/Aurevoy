import { Context, Effect, Layer, Data } from "effect"
import { FSUtil } from "./fs-util.js"

export class StaleContentError extends Data.TaggedError("StaleContentError")<{
  readonly resource: string
}> {}

export interface FileMutationService {
  readonly writeTextPreservingBom: (params: {
    path: string
    content: string
  }) => Effect.Effect<
    { operation: "created" | "wrote" | "appended"; resource: string; existed: boolean },
    Error
  >

  readonly writeIfUnchanged: (params: {
    path: string
    expected: Uint8Array
    content: Uint8Array | string
  }) => Effect.Effect<
    { operation: "modified"; resource: string },
    StaleContentError | Error
  >

  readonly detectLineEnding: (text: string) => "\n" | "\r\n"

  readonly normalizeLineEndings: (text: string, ending: "\n" | "\r\n") => string
}

export class FileMutation extends Context.Tag("FileMutation")<
  FileMutation,
  FileMutationService
>() {}

export const layer = Layer.effect(
  FileMutation,
  Effect.gen(function* () {
    const fs = yield* FSUtil

    const bomSplit = (text: string) =>
      text.startsWith("\uFEFF")
        ? { bom: true, text: text.slice(1) }
        : { bom: false, text }

    const bomJoin = (text: string, bom: boolean) =>
      bom ? `\uFEFF${text}` : text

    const detectLineEnding = (text: string): "\n" | "\r\n" =>
      text.includes("\r\n") ? "\r\n" : "\n"

    const normalizeLineEndings = (text: string, ending: "\n" | "\r\n") => {
      const normalized = text.replaceAll("\r\n", "\n")
      return ending === "\n" ? normalized : normalized.replaceAll("\n", "\r\n")
    }

    return FileMutation.of({
      detectLineEnding,
      normalizeLineEndings,

      writeTextPreservingBom: ({ path, content }) =>
        Effect.gen(function* () {
          let existingBom = false
          let existed = true
          try {
            const stat = yield* fs.stat(path)
            if (stat.type === "File") {
              const rawContent = yield* fs.readFile(path)
              const { bom } = bomSplit(new TextDecoder("utf-8").decode(rawContent))
              existingBom = bom
            } else {
              existed = false
            }
          } catch {
            existed = false
          }

          const final = bomJoin(content, existingBom)
          yield* fs.writeFile(path, final)

          return {
            operation: existed ? "wrote" as const : "created" as const,
            resource: path,
            existed,
          }
        }),

      writeIfUnchanged: ({ path, expected, content }) =>
        Effect.gen(function* () {
          const current = yield* fs.readFile(path)
          if (Buffer.compare(Buffer.from(expected), Buffer.from(current)) !== 0) {
            return yield* new StaleContentError({
              resource: path,
            })
          }
          const toWrite = typeof content === "string" ? Buffer.from(content, "utf-8") : content
          yield* fs.writeFile(path, toWrite)
          return { operation: "modified" as const, resource: path }
        }),
    })
  }),
)
