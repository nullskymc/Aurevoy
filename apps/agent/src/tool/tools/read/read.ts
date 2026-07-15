import { Schema } from "effect"
import { readFile, readdir, stat, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, extname } from "node:path"
import { make, type ContentPart } from "../../framework/definition.js"

function isInsideAllowedRoot(target: string, root: string): boolean {
  const rel = relative(root, target)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/**
 * 解析可读路径：工作区内，或 externalPaths 白名单（用户附件 / 引擎上传目录）。
 * 拒绝 memory:// 等客户端占位协议——那些必须先由上传接口落盘。
 */
const resolveReadablePath = async (
  input: string,
  workspaceRoot: string,
  externalPaths: readonly string[] = [],
): Promise<string> => {
  if (!input || input.startsWith("memory://") || input.startsWith("blob:") || input.startsWith("data:")) {
    throw new Error(
      `Unable to access ${input || "(empty)"}：客户端占位路径不可读。图片应通过消息附件上传，由引擎多模态注入，无需再 read。`,
    )
  }

  const target = isAbsolute(input) ? resolve(input) : resolve(workspaceRoot, input)

  const candidates = [workspaceRoot, ...externalPaths].filter(Boolean)
  try {
    let realTarget: string
    try {
      realTarget = await realpath(target)
    } catch {
      realTarget = target
    }
    for (const root of candidates) {
      try {
        const realRoot = await realpath(root)
        if (isInsideAllowedRoot(realTarget, realRoot) || realTarget === realRoot) return realTarget
      } catch {
        const normalizedRoot = resolve(root)
        if (isInsideAllowedRoot(target, normalizedRoot) || target === normalizedRoot) return target
      }
    }
    for (const root of candidates) {
      const normalizedRoot = resolve(root)
      if (isInsideAllowedRoot(target, normalizedRoot) || target === normalizedRoot) return target
    }
    throw new Error("路径越界：只允许访问工作区或用户附件路径")
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes("路径越界") || message.includes("占位路径")) throw err
    throw new Error(`Unable to access ${input}`)
  }
}

const MAX_READ_LINES = 2000
const MAX_READ_BYTES = 50 * 1024
const MAX_MEDIA_INGEST_BYTES = 20 * 1024 * 1024
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`

const BINARY_EXTENSIONS = new Set([
  ".zip", ".tar", ".gz", ".exe", ".dll", ".so", ".class", ".jar", ".war",
  ".7z", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".odt", ".ods", ".odp", ".bin", ".dat", ".obj", ".o", ".a", ".lib",
  ".wasm", ".pyc", ".pyo", ".pdf",
])

const imageMime = (bytes: Uint8Array) => {
  const s = (p: number[]) => p.every((v, i) => bytes[i] === v)
  if (s([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (s([0xff, 0xd8, 0xff])) return "image/jpeg"
  if (s([0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (s([0x52, 0x49, 0x46, 0x46]) && s([0x57, 0x45, 0x42, 0x50])) return "image/webp"
}

const isBinary = (bytes: Uint8Array) => {
  if (bytes.length === 0) return false
  let np = 0
  for (const b of bytes) { if (b === 0) return true; if (b < 9 || (b > 13 && b < 32)) np++ }
  return np / bytes.length > 0.3
}

const Input = Schema.Struct({
  path: Schema.String.annotations({
    description: "File path to read or directory to list. Relative paths resolve from the workspace root.",
  }),
  offset: Schema.optional(Schema.Number.annotations({
    description: "1-based line number (for files) or entry number (for directories) to start from. Default 1.",
  })),
  limit: Schema.optional(Schema.Number.annotations({
    description: `Maximum lines/entries to return. Default ${MAX_READ_LINES}.`,
  })),
})

const Output = Schema.Union(
  Schema.Struct({ type: Schema.Literal("text-page"), content: Schema.String, offset: Schema.Number, truncated: Schema.Boolean, next: Schema.optional(Schema.Number) }),
  Schema.Struct({ type: Schema.Literal("image"), content: Schema.String, mime: Schema.String }),
  Schema.Struct({ type: Schema.Literal("full-text"), content: Schema.String }),
  Schema.Struct({ type: Schema.Literal("directory"), entries: Schema.Array(Schema.Struct({ path: Schema.String, type: Schema.Literal("file", "directory") })), truncated: Schema.Boolean, next: Schema.optional(Schema.Number) }),
)

export const readTool = make({
  name: "read",
  description: `Read a text file or image, page through a large text file by line offset, or list a directory. Supports PNG/JPEG/GIF/WebP images (base64, max ${MAX_MEDIA_INGEST_BYTES / 1024 / 1024}MB).`,
  input: Input,
  output: Output,
  execute: async (input, ctx) => {
    const path = await resolveReadablePath(input.path, ctx.workspaceDir, ctx.externalPaths ?? [])

    let info
    try { info = await stat(path) } catch { throw new Error(`Unable to access ${input.path}`) }

    if (info.isDirectory()) {
      const raw = await readdir(path, { withFileTypes: true })
      const entries = raw.filter((d) => d.isFile() || d.isDirectory()).map((d) => ({
        path: d.name + (d.isDirectory() ? "/" : ""),
        type: d.isDirectory() ? "directory" as const : "file" as const,
      })).sort((a, b) => a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1)
      const off = input.offset ?? 1
      const lim = Math.min(input.limit ?? MAX_READ_LINES, MAX_READ_LINES)
      const slotted = entries.slice(off - 1, off - 1 + lim)
      const truncated = off - 1 + slotted.length < entries.length
      return { type: "directory" as const, entries: slotted, truncated, ...(truncated ? { next: off + slotted.length } : {}) }
    }

    const raw = await readFile(path)
    const mime = imageMime(raw)

    if (mime) {
      if (raw.length > MAX_MEDIA_INGEST_BYTES) throw new Error(`Image exceeds ${MAX_MEDIA_INGEST_BYTES / 1024 / 1024}MB limit`)
      return { type: "image" as const, content: Buffer.from(raw).toString("base64"), mime }
    }

    if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) throw new Error(`Cannot read binary file: ${input.path}`)
    if (isBinary(raw.slice(0, 1024))) throw new Error(`Cannot read binary file: ${input.path}`)

    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw)
    const shouldPage = raw.length > MAX_READ_BYTES || input.offset !== undefined || input.limit !== undefined

    if (!shouldPage) return { type: "full-text" as const, content: text }

    const offset = input.offset ?? 1
    const maxLines = Math.min(input.limit ?? MAX_READ_LINES, MAX_READ_LINES)
    const lines: string[] = []
    let lnum = 1, bcount = 0, nx: number | undefined
    const all = text.split("\n")
    for (const line of all) {
      if (lnum < offset) { lnum++; continue }
      if (lines.length >= maxLines || bcount >= MAX_READ_BYTES) { nx = lnum; break }
      const t = line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : line
      const sz = Buffer.byteLength(t, "utf-8") + (lines.length > 0 ? 1 : 0)
      if (bcount + sz > MAX_READ_BYTES) { nx = lnum; break }
      lines.push(t)
      bcount += sz
      lnum++
    }
    if (lines.length === 0 && offset !== 1) throw new Error(`Offset ${offset} is out of range`)
    return { type: "text-page" as const, content: lines.join("\n"), offset, truncated: nx !== undefined, ...(nx !== undefined ? { next: nx } : {}) }
  },
  toModelOutput: (_in, out): ReadonlyArray<ContentPart> => {
    if (out.type === "image") return [{ type: "text", text: "Image read successfully" }, { type: "file", data: out.content, mime: out.mime }]
    if (out.type === "directory") return [{ type: "text", text: out.entries.map((e) => e.path).join("\n") + (out.truncated ? "\n(results truncated)" : "") }]
    return [{ type: "text", text: out.content }]
  },
})
