import { Context, Effect, Layer, Data, Schema } from "effect"
import { extname } from "node:path"
import { FSUtil } from "./fs-util.js"

export const MAX_READ_LINES = 2000
export const MAX_READ_BYTES = 50 * 1024
export const MAX_MEDIA_INGEST_BYTES = 20 * 1024 * 1024
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`

const BINARY_EXTENSIONS = new Set([
  ".zip", ".tar", ".gz", ".exe", ".dll", ".so", ".class", ".jar", ".war",
  ".7z", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".odt", ".ods", ".odp", ".bin", ".dat", ".obj", ".o", ".a", ".lib",
  ".wasm", ".pyc", ".pyo", ".pdf",
])

const startsWith = (bytes: Uint8Array, prefix: number[]) =>
  prefix.every((value, index) => bytes[index] === value)

const imageMime = (bytes: Uint8Array) => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) return "image/webp"
}

const isBinary = (bytes: Uint8Array) => {
  if (bytes.length === 0) return false
  let nonPrintable = 0
  for (const byte of bytes) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable++
  }
  return nonPrintable / bytes.length > 0.3
}

export class BinaryFileError extends Data.TaggedError("BinaryFileError")<{
  readonly resource: string
}> {}

export class MediaIngestLimitError extends Data.TaggedError("MediaIngestLimitError")<{
  readonly resource: string
  readonly maximumBytes: number
}> {}

export class MalformedUtf8Error extends Data.TaggedError("MalformedUtf8Error")<{
  readonly resource: string
}> {}

export class OffsetOutOfRangeError extends Data.TaggedError("OffsetOutOfRangeError")<{
  readonly offset: number
}> {}

export class PathKindError extends Data.TaggedError("PathKindError")<{
  readonly resource: string
}> {}

export class TextPage extends Schema.Class<TextPage>("TextPage")({
  type: Schema.Literal("text-page"),
  content: Schema.String,
  mime: Schema.String,
  offset: Schema.Number,
  truncated: Schema.Boolean,
  next: Schema.optional(Schema.Number),
}) {}

export class ListPage extends Schema.Class<ListPage>("ListPage")({
  entries: Schema.Array(Schema.Struct({
    path: Schema.String,
    type: Schema.Literal("file", "directory"),
  })),
  truncated: Schema.Boolean,
  next: Schema.optional(Schema.Number),
}) {}

export type ReadResult =
  | TextPage
  | { type: "image"; content: string; mime: string; encoding: "base64" }
  | { type: "full-text"; content: string; mime: string; encoding: "utf8" }

export interface ReadFileSystemService {
  readonly inspect: (path: string) => Effect.Effect<
    "file" | "directory",
    BinaryFileError | PathKindError
  >
  readonly read: (params: {
    path: string
    resource: string
    offset?: number | undefined
    limit?: number | undefined
  }) => Effect.Effect<
    ReadResult,
    BinaryFileError | MediaIngestLimitError | MalformedUtf8Error | OffsetOutOfRangeError | PathKindError
  >
  readonly list: (params: {
    path: string
    offset?: number | undefined
    limit?: number | undefined
  }) => Effect.Effect<ListPage, Error>
}

export class ReadFileSystem extends Context.Tag("ReadFileSystem")<
  ReadFileSystem,
  ReadFileSystemService
>() {}

export const layer = Layer.effect(
  ReadFileSystem,
  Effect.gen(function* () {
    const fs = yield* FSUtil

    const checkBinary = (resource: string, bytes: Uint8Array) => {
      if (BINARY_EXTENSIONS.has(extname(resource).toLowerCase())) return true
      if (bytes.length >= 4 && imageMime(bytes)) return false
      return isBinary(bytes)
    }

    const asIOError = (resource: string) =>
      (_: Error) => new PathKindError({ resource })

    const service: ReadFileSystemService = {
      inspect: (path) =>
        Effect.gen(function* () {
          const info = yield* fs.stat(path).pipe(
            Effect.mapError(asIOError(path)),
          )
          if (info.type === "File") return "file" as const
          if (info.type === "Directory") return "directory" as const
          return yield* new PathKindError({ resource: path })
        }),

      read: ({ path, resource, offset: inputOffset, limit: inputLimit }) =>
        Effect.gen(function* () {
          const real = yield* fs.realPath(path).pipe(
            Effect.mapError(asIOError(resource)),
          )
          const info = yield* fs.stat(real).pipe(
            Effect.mapError(asIOError(resource)),
          )

          if (info.type !== "File") return yield* new PathKindError({ resource })

          const raw = yield* fs.readFile(real).pipe(
            Effect.mapError(asIOError(resource)),
          )
          const mimeType = imageMime(raw)
          const resourceMime = fs.mimeType(real)

          if (mimeType) {
            if (raw.length > MAX_MEDIA_INGEST_BYTES) {
              return yield* new MediaIngestLimitError({
                resource,
                maximumBytes: MAX_MEDIA_INGEST_BYTES,
              })
            }
            return {
              type: "image" as const,
              content: Buffer.from(raw).toString("base64"),
              mime: mimeType,
              encoding: "base64" as const,
            }
          }

          if (checkBinary(resource, raw.slice(0, 1024))) {
            return yield* new BinaryFileError({ resource })
          }

          const decoder = new TextDecoder("utf-8", { fatal: true })
          let text: string
          try {
            text = decoder.decode(raw)
          } catch {
            return yield* new MalformedUtf8Error({ resource })
          }

          const shouldPage = raw.length > MAX_READ_BYTES ||
            inputOffset !== undefined ||
            inputLimit !== undefined

          if (!shouldPage) {
            return {
              type: "full-text" as const,
              content: text,
              mime: resourceMime,
              encoding: "utf8" as const,
            }
          }

          const offset = inputOffset ?? 1
          const maxLines = Math.min(inputLimit ?? MAX_READ_LINES, MAX_READ_LINES)
          const lines: string[] = []
          let lineNum = 1
          let byteCount = 0
          let nextOffset: number | undefined
          let pending = ""

          const processLine = (line: string): "continue" | "stop" => {
            if (lineNum < offset) { lineNum++; return "continue" }
            if (lines.length >= maxLines || byteCount >= MAX_READ_BYTES) {
              nextOffset = lineNum
              return "stop"
            }
            const truncated = line.length > MAX_LINE_LENGTH
              ? line.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX
              : line
            const size = Buffer.byteLength(truncated, "utf-8") + (lines.length > 0 ? 1 : 0)
            if (byteCount + size > MAX_READ_BYTES) {
              nextOffset = lineNum
              return "stop"
            }
            lines.push(truncated)
            byteCount += size
            lineNum++
            return "continue"
          }

          let i = 0
          while (i < text.length) {
            const nl = text.indexOf("\n", i)
            if (nl === -1) {
              pending = text.slice(i)
              break
            }
            const line = pending + text.slice(i, nl)
            pending = ""
            i = nl + 1
            const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line
            if (processLine(trimmed) === "stop") break
          }
          if (pending.trim().length > 0 && nextOffset === undefined) {
            processLine(pending)
          }

          if (lines.length === 0 && offset !== 1) {
            return yield* new OffsetOutOfRangeError({ offset })
          }

          return new TextPage({
            type: "text-page",
            content: lines.join("\n"),
            mime: resourceMime,
            offset,
            truncated: nextOffset !== undefined,
            ...(nextOffset !== undefined ? { next: nextOffset } : {}),
          })
        }),

      list: ({ path, offset: inputOffset, limit: inputLimit }) =>
        Effect.gen(function* () {
          const real = yield* fs.realPath(path)
          const raw = yield* fs.readDirectoryEntries(real)
          const sorted = [...raw].sort((a, b) =>
            a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1,
          )
          const offset = inputOffset ?? 1
          const maxEntries = Math.min(inputLimit ?? MAX_READ_LINES, MAX_READ_LINES)
          const slotted = sorted.slice(offset - 1, offset - 1 + maxEntries)
          const truncated = offset - 1 + slotted.length < sorted.length
          return new ListPage({
            entries: slotted.map((e) => ({ path: e.name + (e.type === "directory" ? "/" : ""), type: e.type })),
            truncated,
            ...(truncated ? { next: offset + slotted.length } : {}),
          })
        }),
    }

    return service
  }),
)
