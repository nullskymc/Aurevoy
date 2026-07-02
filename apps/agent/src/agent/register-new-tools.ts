import type { ToolExecutionPolicy, ToolRiskLevel } from "@aurevoy/shared"
import { resolve } from "node:path"
import { bundleReportHtml } from "../tool/tools/bundle-report/bundler.js"

const resolvePath = (workspaceDir: string, segment: unknown): string => {
  const path = typeof segment === "string" ? segment : "."
  if (path.startsWith("/")) return path
  return resolvePathImpl(workspaceDir, path)
}
const resolvePathImpl = (base: string, segment: string): string =>
  resolve(base, segment)

async function runTool(name: string, args: Record<string, unknown>, workspaceDir: string): Promise<unknown> {
  switch (name) {
    case "read": {
      const { readFile, readdir, stat } = await import("node:fs/promises")
      const { extname } = await import("node:path")
      const pathArg = resolvePath(workspaceDir, args.path)
      const info = await stat(pathArg)

      if (info.isDirectory()) {
        const raw = await readdir(pathArg, { withFileTypes: true })
        const entries = raw
          .filter((d) => d.isFile() || d.isDirectory())
          .map((d) => ({ path: d.name + (d.isDirectory() ? "/" : ""), type: d.isDirectory() ? "directory" : "file" }))
          .sort((a, b) => a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1)
        const off = Number(args.offset ?? 1)
        const lim = Math.min(Number(args.limit ?? 2000), 2000)
        const slotted = entries.slice(off - 1, off - 1 + lim)
        return { type: "directory", entries: slotted, truncated: off - 1 + slotted.length < entries.length }
      }

      const raw = await readFile(pathArg)
      const detectImage = (b: Uint8Array) => {
        const s = (p: number[]) => p.every((v, i) => b[i] === v)
        if (s([0x89, 0x50, 0x4e, 0x47])) return "image/png"
        if (s([0xff, 0xd8, 0xff])) return "image/jpeg"
        if (s([0x47, 0x49, 0x46])) return "image/gif"
        return null
      }
      const mime = detectImage(raw)
      if (mime) {
        return { type: "image", mime, content: Buffer.from(raw).toString("base64") }
      }

      const binExts = new Set([".zip", ".exe", ".dll", ".so", ".class", ".jar", ".wasm", ".pyc", ".pdf"])
      if (binExts.has(extname(pathArg).toLowerCase())) {
        throw new Error(`Cannot read binary file: ${args.path}`)
      }

      const text = new TextDecoder("utf-8", { fatal: true }).decode(raw)
      if (raw.length > 50 * 1024 || args.offset !== undefined || args.limit !== undefined) {
        const offset = Number(args.offset ?? 1)
        const maxLines = Math.min(Number(args.limit ?? 2000), 2000)
        const lines: string[] = []
        let lnum = 1
        for (const line of text.split("\n")) {
          if (lnum < offset) { lnum++; continue }
          if (lines.length >= maxLines) break
          lines.push(line.length > 2000 ? line.slice(0, 2000) + "..." : line)
          lnum++
        }
        return { type: "text-page", content: lines.join("\n"), offset, total_lines: text.split("\n").length }
      }
      return { type: "read", content: text }
    }

    case "write": {
      const { writeFile, appendFile, stat } = await import("node:fs/promises")
      const pathArg = resolvePath(workspaceDir, args.path)
      const content = String(args.content)
      const mode = String(args.mode ?? "overwrite")
      let existed = false
      try { existed = (await stat(pathArg)).isFile() } catch {}
      if (mode === "append") {
        await appendFile(pathArg, content, "utf-8")
        return `Appended to: ${args.path}`
      }
      await writeFile(pathArg, content, "utf-8")
      return existed ? `Wrote file: ${args.path}` : `Created file: ${args.path}`
    }

    case "edit": {
      const { readFile, writeFile } = await import("node:fs/promises")
      const pathArg = resolvePath(workspaceDir, args.path)
      const oldStr = String(args.oldString)
      const newStr = String(args.newString)
      const replaceAll = args.replaceAll === true

      const source = await readFile(pathArg, "utf-8")
      const escaped = oldStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const count = (source.match(new RegExp(escaped, "g")) || []).length
      if (count === 0) throw new Error("Could not find oldString in the file. It must match exactly, including whitespace.")
      if (count > 1 && !replaceAll) throw new Error("Found multiple matches. Provide more context or set replaceAll to true.")
      const replaced = replaceAll ? source.replaceAll(oldStr, newStr) : source.replace(oldStr, newStr)
      await writeFile(pathArg, replaced, "utf-8")
      return `Edited file: ${args.path}\nReplacements: ${replaceAll ? count : 1}`
    }

    case "grep": {
      const { execFile } = await import("node:child_process")
      const { promisify } = await import("node:util")
      const execFileAsync = promisify(execFile)
      const cwdPath = args.path ? resolvePath(workspaceDir, args.path) : workspaceDir
      const limit = Number(args.limit ?? 100)
      const grepArgs = ["-rni", "--binary-files=without-match", "-m", String(limit)]
      if (args.include) grepArgs.push("--include", String(args.include))
      grepArgs.push("-e", String(args.pattern), cwdPath)
      try {
        const { stdout } = await execFileAsync("grep", grepArgs, { maxBuffer: 512 * 1024, timeout: 15000 })
        const lines = stdout.trim().split("\n").filter(Boolean).slice(0, limit)
        return lines.map((line) => {
          const c1 = line.indexOf(":")
          const c2 = line.indexOf(":", c1 + 1)
          return `${line.slice(0, c1)}:${line.slice(c1 + 1, c2)}:${line.slice(c2 + 1)}`
        }).join("\n") || "No matches found"
      } catch {
        return "No matches found"
      }
    }

    case "glob": {
      const { readdir } = await import("node:fs/promises")
      const { basename, join, relative } = await import("node:path")
      const { minimatch } = await import("minimatch")
      const cwdPath = args.path ? resolvePath(workspaceDir, args.path) : workspaceDir
      const pattern = String(args.pattern)
      const limit = Number(args.limit ?? 200)
      const results: string[] = []
      const queue = [cwdPath]
      const matchGlob = (fp: string, pat: string) => pat.includes("**") ? minimatch(fp, pat, { dot: true }) : minimatch(basename(fp), pat, { dot: true })
      while (queue.length > 0 && results.length < limit) {
        const current = queue.shift()!
        let entries
        try { entries = await readdir(current, { withFileTypes: true }) } catch { continue }
        for (const e of entries) {
          if (results.length >= limit) break
          if (e.name.startsWith(".") && !pattern.startsWith(".")) continue
          if (e.name === "node_modules" || e.name === ".git") continue
          const full = join(current, e.name)
          const rel = relative(cwdPath, full)
          if (e.isDirectory()) queue.push(full)
          if (!e.isFile() && !e.isDirectory()) continue
          if (matchGlob(rel, pattern)) results.push(rel + (e.isDirectory() ? "/" : ""))
        }
      }
      return results.join("\n") || "No files found"
    }

    case "bash": {
      const { spawn } = await import("node:child_process")
      const cwdPath = args.workdir ? resolvePath(workspaceDir, args.workdir) : workspaceDir
      const command = String(args.command)
      const timeoutMs = Math.min(Number(args.timeout ?? 120000), 600000)
      const shell = process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh"
      return new Promise((resolve, reject) => {
        const child = spawn(command, [], { cwd: cwdPath, shell, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } })
        const chunks: Buffer[] = []
        let total = 0
        let truncated = false
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          child.kill("SIGTERM")
          setTimeout(() => { if (!child.killed) child.kill("SIGKILL") }, 3000)
        }, timeoutMs)
        child.stdout.on("data", (chunk: Buffer) => {
          if (truncated) return
          if (total + chunk.length > 1024 * 1024) { chunks.push(chunk.slice(0, 1024 * 1024 - total)); truncated = true }
          else { chunks.push(chunk) }
          total += chunk.length
        })
        child.stderr.on("data", (chunk: Buffer) => {
          if (truncated) return
          if (total + chunk.length > 1024 * 1024) { chunks.push(chunk.slice(0, 1024 * 1024 - total)); truncated = true }
          else { chunks.push(chunk) }
          total += chunk.length
        })
        child.on("close", (code) => {
          clearTimeout(timer)
          const output = Buffer.concat(chunks).toString("utf-8") || "(no output)"
          resolve({ exit: code, output, truncated, ...(timedOut ? { timeout: true } : {}) })
        })
        child.on("error", (err) => reject(err))
      })
    }

    case "web_search": {
      const query = encodeURIComponent(String(args.query))
      const resp = await fetch(`https://lite.duckduckgo.com/lite/?q=${query}`, {
        headers: { "User-Agent": "Aurevoy/1.0" },
        signal: AbortSignal.timeout(15000),
      })
      const html = await resp.text()
      const results: Array<{ title: string; url: string; snippet: string }> = []
      const linkRe = /<a[^>]*href="([^"]*)"[^>]*class="result-link"[^>]*>([^<]*)<\/a>/gi
      let m
      while ((m = linkRe.exec(html)) !== null) {
        if (m[1].includes("duckduckgo.com")) continue
        results.push({ title: m[2].replace(/<[^>]+>/g, ""), url: m[1], snippet: "" })
      }
      return results.slice(0, 10).map((r) => `**${r.title}**\n${r.url}\n${r.snippet}`).join("\n\n") || "No results found"
    }

    case "web_fetch": {
      const urlStr = String(args.url)
      const url = new URL(urlStr)
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") {
        throw new Error("Fetching from localhost is not allowed")
      }
      const resp = await fetch(urlStr, {
        headers: { "User-Agent": "Aurevoy/1.0" },
        signal: AbortSignal.timeout(30000),
        redirect: "follow",
      })
      const text = await resp.text()
      return text.slice(0, 10000)
    }

    case "bundle_report": {
      return bundleReportHtml({
        htmlPath: String(args.htmlPath),
        outputPath: args.outputPath ? String(args.outputPath) : undefined,
        componentsPath: args.componentsPath ? String(args.componentsPath) : undefined,
        workspaceDir,
        inlineImages: args.inlineImages === undefined ? true : Boolean(args.inlineImages),
        inlineScripts: args.inlineScripts === undefined ? true : Boolean(args.inlineScripts),
        inlineStyles: args.inlineStyles === undefined ? true : Boolean(args.inlineStyles),
      })
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

export interface NewToolEntry {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  riskLevel: ToolRiskLevel
  executionPolicy?: ToolExecutionPolicy
  execute: (args: Record<string, unknown>, ctx?: { workspaceDir: string }) => Promise<unknown>
}

export const NEW_TOOLS: NewToolEntry[] = [
  {
    name: "read",
    description:
      "Read a text file or image, page through a large text file by line offset, or list a directory. " +
      "Supports PNG/JPEG/GIF/WebP (base64). Use offset/limit for pagination.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to read or directory to list" },
        offset: { type: "number", description: "1-based line number (files) or entry number (directories). Default 1" },
        limit: { type: "number", description: "Maximum lines or entries to return. Default 2000, max 2000" },
      },
      required: ["path"],
    },
    riskLevel: "safe" as ToolRiskLevel,
    execute: (args, ctx) => runTool("read", args, ctx?.workspaceDir ?? process.cwd()),
  },
  {
    name: "write",
    description: "Write content to a file. Modes: create (fail if exists), overwrite (default), append. Preserves UTF-8 BOM.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        content: { type: "string", description: "Content to write" },
        mode: { type: "string", enum: ["create", "overwrite", "append"], description: "Write mode" },
      },
      required: ["path", "content"],
    },
    riskLevel: "dangerous" as ToolRiskLevel,
    executionPolicy: { parallelizable: false },
    execute: (args, ctx) => runTool("write", args, ctx?.workspaceDir ?? process.cwd()),
  },
  {
    name: "edit",
    description:
      "Replace exact text in a file. oldString must match exactly including whitespace. Set replaceAll to replace all occurrences.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        oldString: { type: "string", description: "Exact text to replace" },
        newString: { type: "string", description: "Replacement text (must differ from oldString)" },
        replaceAll: { type: "boolean", description: "Replace all exact occurrences (default false)" },
      },
      required: ["path", "oldString", "newString"],
    },
    riskLevel: "dangerous" as ToolRiskLevel,
    executionPolicy: { parallelizable: false },
    execute: (args, ctx) => runTool("edit", args, ctx?.workspaceDir ?? process.cwd()),
  },
  {
    name: "grep",
    description: "Search file contents by regular expression. Returns file:line:match results.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "Directory to search. Defaults to workspace root" },
        include: { type: "string", description: 'File glob to filter, e.g. "*.ts" or "*.{ts,tsx}"' },
        limit: { type: "number", description: "Maximum matches. Default 100" },
      },
      required: ["pattern"],
    },
    riskLevel: "safe" as ToolRiskLevel,
    execute: (args, ctx) => runTool("grep", args, ctx?.workspaceDir ?? process.cwd()),
  },
  {
    name: "glob",
    description: "Find files by glob pattern. Use ** for recursive matching. Returns relative file paths.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: 'Glob pattern, e.g. "**/*.ts" or "src/**/*.tsx"' },
        path: { type: "string", description: "Directory to search. Defaults to workspace root" },
        limit: { type: "number", description: "Maximum results. Default 200" },
      },
      required: ["pattern"],
    },
    riskLevel: "safe" as ToolRiskLevel,
    execute: (args, ctx) => runTool("glob", args, ctx?.workspaceDir ?? process.cwd()),
  },
  {
    name: "bash",
    description:
      "Execute a shell command. Supports pipes, redirects, glob. Default timeout 2 minutes, max 10 minutes. Output capped at 1MB.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        workdir: { type: "string", description: "Working directory. Defaults to workspace root" },
        timeout: { type: "number", description: "Timeout in milliseconds. Default 120000, max 600000" },
      },
      required: ["command"],
    },
    riskLevel: "dangerous" as ToolRiskLevel,
    execute: (args, ctx) => runTool("bash", args, ctx?.workspaceDir ?? process.cwd()),
  },
  {
    name: "web_search",
    description: "Search the web using DuckDuckGo. Returns top results with titles and URLs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query string" },
      },
      required: ["query"],
    },
    riskLevel: "safe" as ToolRiskLevel,
    execute: (args, ctx) => runTool("web_search", args, ctx?.workspaceDir ?? process.cwd()),
  },
  {
    name: "web_fetch",
    description: "Fetch content from a URL. Localhost is blocked. Returns text content.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch content from" },
      },
      required: ["url"],
    },
    riskLevel: "caution" as ToolRiskLevel,
    execute: (args, ctx) => runTool("web_fetch", args, ctx?.workspaceDir ?? process.cwd()),
  },
  {
    name: "bundle_report",
    description:
      "Bundle a report HTML draft into a single self-contained file. Inlines the report components.js library, local stylesheets, and base64-encodes local images so the report can be opened without file:// subresource restrictions.",
    inputSchema: {
      type: "object",
      properties: {
        htmlPath: { type: "string", description: "Path to the input HTML draft. Relative to workspace root." },
        outputPath: { type: "string", description: "Optional output path. Defaults to overwriting htmlPath." },
        componentsPath: { type: "string", description: "Optional override path to components.js. Defaults to built-in report-design skill library." },
        inlineImages: { type: "boolean", description: "Base64-encode local images. Default true." },
        inlineScripts: { type: "boolean", description: "Inline local scripts. Default true." },
        inlineStyles: { type: "boolean", description: "Inline local stylesheets. Default true." },
      },
      required: ["htmlPath"],
    },
    riskLevel: "safe" as ToolRiskLevel,
    execute: (args, ctx) => runTool("bundle_report", args, ctx?.workspaceDir ?? process.cwd()),
  },
]
