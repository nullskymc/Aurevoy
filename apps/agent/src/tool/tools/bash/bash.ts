import { Schema } from "effect"
import { make, type ContentPart } from "../../framework/definition.js"
import { spawn } from "node:child_process"
import { resolve } from "node:path"

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000
const MAX_TIMEOUT_MS = 10 * 60 * 1000
const MAX_CAPTURE_BYTES = 1024 * 1024

const defaultShell = () =>
  process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh"

const Input = Schema.Struct({
  command: Schema.String.annotations({
    description: "Shell command string to execute.",
  }),
  workdir: Schema.optional(Schema.String.annotations({
    description: "Working directory. Defaults to workspace root.",
  })),
  timeout: Schema.optional(Schema.Number.annotations({
    description: `Timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`,
  })),
})

const Output = Schema.Struct({
  exit: Schema.optional(Schema.Number),
  output: Schema.String,
  truncated: Schema.Boolean,
  timeout: Schema.optional(Schema.Boolean),
})

export const bashTool = make({
  name: "bash",
  description:
    `Execute a shell command with the host user's filesystem, process, and network authority. ` +
    `The workspace root is the default working directory. Shell: ${defaultShell()}. ` +
    `Supports pipes, redirects, and glob expansion via shell. ` +
    `Timeout: default ${DEFAULT_TIMEOUT_MS / 1000}s, max ${MAX_TIMEOUT_MS / 1000}s. ` +
    `Output is capped at ${MAX_CAPTURE_BYTES / 1024}KB.`,
  input: Input,
  output: Output,
  execute: (input, ctx) => {
    const cwd = input.workdir ? resolve(ctx.workspaceDir, input.workdir) : ctx.workspaceDir
    const timeoutMs = Math.min(input.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const shell = defaultShell()

    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(input.command, [], {
        cwd,
        shell,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: process.env.HOME ?? "/tmp",
        },
      })

      const chunks: Buffer[] = []
      let totalBytes = 0
      let truncated = false
      let timedOut = false

      const timeout = setTimeout(() => {
        timedOut = true
        child.kill("SIGTERM")
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL")
        }, 3000)
      }, timeoutMs)

      child.stdout.on("data", (chunk: Buffer) => {
        if (truncated) return
        if (totalBytes + chunk.length > MAX_CAPTURE_BYTES) {
          chunks.push(chunk.slice(0, MAX_CAPTURE_BYTES - totalBytes))
          truncated = true
        } else {
          chunks.push(chunk)
        }
        totalBytes += chunk.length
      })

      let stderrChunks: Buffer[] = []
      child.stderr.on("data", (chunk: Buffer) => {
        if (truncated) return
        if (totalBytes + chunk.length > MAX_CAPTURE_BYTES) {
          stderrChunks.push(chunk.slice(0, MAX_CAPTURE_BYTES - totalBytes))
          truncated = true
        } else {
          stderrChunks.push(chunk)
        }
        totalBytes += chunk.length
      })

      child.on("close", (code) => {
        clearTimeout(timeout)
        const output = Buffer.concat([...chunks, ...stderrChunks]).toString("utf-8") || "(no output)"
        const truncatedNote = truncated ? "\n\n[output truncated at 1MB safety limit]" : ""

        resolvePromise({
          exit: code ?? undefined,
          output: output + truncatedNote,
          truncated,
          ...(timedOut ? { timeout: true } : {}),
        })
      })

      child.on("error", (err) => {
        clearTimeout(timeout)
        rejectPromise(new Error(`Failed to execute command: ${err.message}`))
      })
    })
  },
  toModelOutput: (_input, output): ReadonlyArray<ContentPart> => {
    const header = output.timeout
      ? "Command timed out before completion."
      : `Command exited with code ${output.exit ?? "?"}.`
    return [
      { type: "text", text: output.output },
      { type: "text", text: header },
    ]
  },
})
