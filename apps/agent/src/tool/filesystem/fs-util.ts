import { Context, Effect, Layer } from "effect"
import { promises as fs } from "node:fs"
import { extname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

export interface FSUtilService {
  readonly stat: (p: string) => Effect.Effect<
    { type: "File" | "Directory" | "Other"; size: number; mtimeMs: number },
    Error
  >
  readonly readFile: (p: string) => Effect.Effect<Uint8Array, Error>
  readonly writeFile: (p: string, data: Uint8Array | string) => Effect.Effect<void, Error>
  readonly realPath: (p: string) => Effect.Effect<string, Error>
  readonly isDirectory: (p: string) => Effect.Effect<boolean, Error>
  readonly contains: (parent: string, child: string) => boolean
  readonly resolve: (...segments: string[]) => string
  readonly readDirectoryEntries: (p: string) => Effect.Effect<
    ReadonlyArray<{ name: string; type: "file" | "directory" }>,
    Error
  >
  readonly mimeType: (p: string) => string
  readonly uri: (p: string) => string
}

export class FSUtil extends Context.Tag("FSUtil")<
  FSUtil,
  FSUtilService
>() {}

export const layer = Layer.succeed(
  FSUtil,
  FSUtil.of({
    stat: (p) =>
      Effect.tryPromise({
        try: async () => {
          const stats = await fs.stat(p)
          const type = stats.isDirectory()
            ? "Directory"
            : stats.isFile()
              ? "File"
              : "Other"
          return { type, size: stats.size, mtimeMs: stats.mtimeMs }
        },
        catch: (e) => e as Error,
      }),

    readFile: (p) =>
      Effect.tryPromise({
        try: () => fs.readFile(p),
        catch: (e) => e as Error,
      }),

    writeFile: (p, data) =>
      Effect.tryPromise({
        try: () => fs.writeFile(p, data),
        catch: (e) => e as Error,
      }),

    realPath: (p) =>
      Effect.tryPromise({
        try: () => fs.realpath(p),
        catch: (e) => e as Error,
      }),

    isDirectory: (p) =>
      Effect.gen(function* () {
        try {
          const stats = yield* Effect.tryPromise(() => fs.stat(p))
          return stats.isDirectory()
        } catch {
          return false
        }
      }),

    contains: (parent, child) => {
      const rp = resolve(parent)
      const rc = resolve(child)
      return rc.startsWith(rp + "/") || rc === rp
    },

    resolve: (...segments) => resolve(...segments),

    readDirectoryEntries: (p) =>
      Effect.tryPromise({
        try: async () => {
          const names = await fs.readdir(p, { withFileTypes: true })
          return names.map((d) => ({
            name: d.name,
            type: d.isDirectory() ? "directory" as const : "file" as const,
          }))
        },
        catch: (e) => e as Error,
      }),

    mimeType: (p) => {
      const ext = extname(p).toLowerCase()
      const map: Record<string, string> = {
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".json": "application/json",
        ".js": "text/javascript",
        ".ts": "text/typescript",
        ".tsx": "text/typescript",
        ".jsx": "text/javascript",
        ".html": "text/html",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".pdf": "application/pdf",
        ".py": "text/x-python",
        ".rs": "text/rust",
        ".go": "text/x-go",
        ".c": "text/x-c",
        ".h": "text/x-c",
        ".cpp": "text/x-c++",
        ".java": "text/x-java",
        ".rb": "text/x-ruby",
        ".yaml": "text/yaml",
        ".yml": "text/yaml",
        ".xml": "text/xml",
        ".sql": "text/x-sql",
        ".sh": "text/x-shellscript",
      }
      return map[ext] ?? "application/octet-stream"
    },

    uri: (p) => pathToFileURL(resolve(p)).href,
  }),
)

export const resolveSafe = (base: string, relativePath: string) => resolve(base, relativePath)
