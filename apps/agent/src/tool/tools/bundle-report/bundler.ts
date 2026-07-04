import { readFile } from "node:fs/promises"
import { statSync } from "node:fs"
import { dirname, resolve, relative, isAbsolute, basename, extname } from "node:path"
import { fileURLToPath } from "node:url"

function findDefaultComponentsPath(): string {
  const candidates: string[] = []
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url))
    candidates.push(resolve(thisDir, "..", "..", "..", "..", "skills", "builtin", "report-design", "components.js"))
  } catch {
    // ignore
  }
  candidates.push(
    resolve(process.cwd(), "skills", "builtin", "report-design", "components.js"),
    resolve(process.cwd(), "apps", "agent", "skills", "builtin", "report-design", "components.js"),
    resolve(process.cwd(), "src", "skills", "builtin", "report-design", "components.js"),
  )
  for (const p of candidates) {
    try {
      const stats = statSync(p)
      if (stats.isFile()) return p
    } catch {
      // continue
    }
  }
  return candidates[0] ?? ""
}

const DEFAULT_COMPONENTS_PATH = findDefaultComponentsPath()

export interface BundleReportOptions {
  readonly htmlPath: string
  readonly outputPath?: string
  readonly componentsPath?: string
  readonly workspaceDir: string
  readonly inlineImages?: boolean
  readonly inlineScripts?: boolean
  readonly inlineStyles?: boolean
}

export interface BundleReportResult {
  readonly outputPath: string
  readonly bytesRead: number
  readonly bytesWritten: number
  readonly inlinedScripts: number
  readonly inlinedImages: number
  readonly inlinedStyles: number
  readonly warnings: readonly string[]
}

interface InlineContext {
  readonly baseDir: string
  readonly workspaceDir: string
  readonly componentsPath: string
  readonly inlineImages: boolean
  readonly inlineScripts: boolean
  readonly inlineStyles: boolean
  readonly warnings: string[]
  stats: {
    scripts: number
    images: number
    styles: number
    bytesRead: number
  }
}

function isPathUnder(filePath: string, root: string): boolean {
  const rel = relative(root, filePath)
  return !rel.startsWith("..") && rel !== ".."
}

function assertReadable(filePath: string, ctx: InlineContext): void {
  if (
    !isPathUnder(filePath, ctx.workspaceDir) &&
    filePath !== ctx.componentsPath &&
    !isPathUnder(filePath, dirname(ctx.componentsPath))
  ) {
    throw new Error(`Refused to read file outside workspace or trusted components dir: ${filePath}`)
  }
}

async function tryRead(filePath: string, ctx: InlineContext): Promise<Buffer | null> {
  try {
    const data = await readFile(filePath)
    ctx.stats.bytesRead += data.length
    return data
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "EACCES") return null
    throw err
  }
}

function mimeTypeFor(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  switch (ext) {
    case ".png":
      return "image/png"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".gif":
      return "image/gif"
    case ".webp":
      return "image/webp"
    case ".svg":
      return "image/svg+xml"
    case ".css":
      return "text/css"
    case ".js":
    case ".mjs":
      return "text/javascript"
    default:
      return "application/octet-stream"
  }
}

function inlineScript(text: string): string {
  // If the script contains a literal </script>, HTML parsers will close the tag early.
  // Fall back to a base64 data URI to keep the output robust.
  if (/<\/script>/i.test(text)) {
    const b64 = Buffer.from(text, "utf-8").toString("base64")
    return `<script src="data:text/javascript;base64,${b64}"></script>`
  }
  return `<script>\n${text}\n</script>`
}

function inlineStyle(text: string): string {
  return `<style>\n${text}\n</style>`
}

async function resolveScriptSrc(src: string, ctx: InlineContext): Promise<string | null> {
  if (src === "" || src.startsWith("data:") || src.startsWith("http://") || src.startsWith("https://")) {
    return null
  }

  // Prefer the trusted components.js path when the reference looks like the report component library.
  if (basename(src) === "components.js") {
    return ctx.componentsPath
  }

  const resolved = isAbsolute(src) ? resolve(src) : resolve(ctx.baseDir, src)
  assertReadable(resolved, ctx)
  return resolved
}

async function resolveLocalSrc(src: string, ctx: InlineContext): Promise<string | null> {
  if (src === "" || src.startsWith("data:") || src.startsWith("http://") || src.startsWith("https://")) {
    return null
  }
  const resolved = isAbsolute(src) ? resolve(src) : resolve(ctx.baseDir, src)
  assertReadable(resolved, ctx)
  return resolved
}

async function processScripts(html: string, ctx: InlineContext): Promise<string> {
  if (!ctx.inlineScripts) return html
  const scriptRe = /<script\s+[^>]*src=["']([^"']+)["'][^>]*>(?:<\/script>)?/gi
  const replacements: Array<{ original: string; replacement: string }> = []

  let m: RegExpExecArray | null
  while ((m = scriptRe.exec(html)) !== null) {
    const original = m[0]
    const src = m[1]
    const path = await resolveScriptSrc(src, ctx)
    if (path == null) continue

    const data = await tryRead(path, ctx)
    if (data == null) {
      ctx.warnings.push(`Could not read script: ${src}`)
      continue
    }

    const text = data.toString("utf-8")
    replacements.push({ original, replacement: inlineScript(text) })
    ctx.stats.scripts++
  }

  let result = html
  for (const { original, replacement } of replacements) {
    result = result.replace(original, replacement)
  }
  return result
}

async function processStyles(html: string, ctx: InlineContext): Promise<string> {
  if (!ctx.inlineStyles) return html
  const linkRe = /<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*\/?>/gi
  const replacements: Array<{ original: string; replacement: string }> = []

  let m: RegExpExecArray | null
  while ((m = linkRe.exec(html)) !== null) {
    const original = m[0]
    const href = m[1]
    const path = await resolveLocalSrc(href, ctx)
    if (path == null) continue

    const data = await tryRead(path, ctx)
    if (data == null) {
      ctx.warnings.push(`Could not read stylesheet: ${href}`)
      continue
    }

    replacements.push({ original, replacement: inlineStyle(data.toString("utf-8")) })
    ctx.stats.styles++
  }

  let result = html
  for (const { original, replacement } of replacements) {
    result = result.replace(original, replacement)
  }
  return result
}

async function processImages(html: string, ctx: InlineContext): Promise<string> {
  if (!ctx.inlineImages) return html
  const imgRe = /<img\s+([^>]*)src=["']([^"']+)["']([^>]*)>/gi
  const replacements: Array<{ original: string; replacement: string }> = []

  let m: RegExpExecArray | null
  while ((m = imgRe.exec(html)) !== null) {
    const original = m[0]
    const before = m[1]
    const src = m[2]
    const after = m[3]
    const path = await resolveLocalSrc(src, ctx)
    if (path == null) continue

    const data = await tryRead(path, ctx)
    if (data == null) {
      ctx.warnings.push(`Could not read image: ${src}`)
      continue
    }

    const mime = mimeTypeFor(path)
    const b64 = data.toString("base64")
    replacements.push({
      original,
      replacement: `<img ${before}src="data:${mime};base64,${b64}"${after}>`,
    })
    ctx.stats.images++
  }

  let result = html
  for (const { original, replacement } of replacements) {
    result = result.replace(original, replacement)
  }
  return result
}

export async function bundleReportHtml(options: BundleReportOptions): Promise<BundleReportResult> {
  const htmlPath = resolve(options.workspaceDir, options.htmlPath)
  const outputPath = options.outputPath
    ? resolve(options.workspaceDir, options.outputPath)
    : htmlPath
  const componentsPath = options.componentsPath
    ? resolve(options.workspaceDir, options.componentsPath)
    : DEFAULT_COMPONENTS_PATH

  const html = await readFile(htmlPath, "utf-8")

  const ctx: InlineContext = {
    baseDir: dirname(htmlPath),
    workspaceDir: resolve(options.workspaceDir),
    componentsPath,
    inlineImages: options.inlineImages ?? true,
    inlineScripts: options.inlineScripts ?? true,
    inlineStyles: options.inlineStyles ?? true,
    warnings: [],
    stats: { scripts: 0, images: 0, styles: 0, bytesRead: 0 },
  }

  let result = html
  result = await processScripts(result, ctx)
  result = await processStyles(result, ctx)
  result = await processImages(result, ctx)

  const { writeFile } = await import("node:fs/promises")
  await writeFile(outputPath, result, "utf-8")

  return {
    outputPath: outputPath,
    bytesRead: ctx.stats.bytesRead + Buffer.byteLength(html, "utf-8"),
    bytesWritten: Buffer.byteLength(result, "utf-8"),
    inlinedScripts: ctx.stats.scripts,
    inlinedImages: ctx.stats.images,
    inlinedStyles: ctx.stats.styles,
    warnings: ctx.warnings,
  }
}
