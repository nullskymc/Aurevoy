import { Schema } from "effect"
import { make, type ContentPart } from "../../framework/definition.js"
import { spawn } from "node:child_process"
import { config } from "../../../config.js"
import {
  assertRealPathInside,
  resolveInWorkspace,
  rootAndExternals,
} from "../../filesystem/workspace-paths.js"
import { assertShellCommandBoundary } from "./command-policy.js"
import { prepareIsolatedSpawn } from "../../../sandbox/os-isolation.js"

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
  isolation: Schema.String,
})

export const bashTool = make({
  name: "bash",
  riskLevel: "dangerous",
  executionPolicy: { parallelizable: false, requiresExplicitApproval: true },
  description:
    `Execute a shell command after explicit user approval, with a workspace path boundary, OS isolation when supported, and bounded process/output policy. ` +
    `The workspace root is the default working directory; host system commands and dynamic nested shells are blocked. Shell: ${defaultShell()}. ` +
    `Supports pipes, redirects, and glob expansion via shell. ` +
    `Timeout: default ${DEFAULT_TIMEOUT_MS / 1000}s, max ${MAX_TIMEOUT_MS / 1000}s. ` +
    `Output is capped at ${MAX_CAPTURE_BYTES / 1024}KB.`,
  input: Input,
  output: Output,
  execute: async (input, ctx) => {
    const { root, externalPaths } = rootAndExternals(ctx)
    const allowedExternalPaths = externalPaths ?? []
    const cwd = resolveInWorkspace(input.workdir ?? ".", root, allowedExternalPaths)
    await assertRealPathInside(cwd, root, allowedExternalPaths)
    await assertShellCommandBoundary(input.command, cwd, root, allowedExternalPaths)
    const timeoutMs = Math.min(input.timeout ?? config.sandbox.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const captureBytes = Math.max(1, Math.min(config.sandbox.commandOutputLimitBytes ?? MAX_CAPTURE_BYTES, MAX_CAPTURE_BYTES))
    const shell = defaultShell()
    const isolated = await prepareIsolatedSpawn({
      program: shell,
      args: shellArgs(input.command),
      cwd,
      workspaceRoot: root,
      externalPaths: allowedExternalPaths,
      env: buildAllowedEnvironment(config.sandbox.commandEnvAllowlist),
      requested: config.sandbox.commandIsolation,
    })

    return await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(isolated.program, isolated.args, {
        cwd,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        // 只注入设置页允许的环境变量，避免把 API key、代理和其他进程态泄露给 shell。
        env: isolated.env,
      })

      const chunks: Buffer[] = []
      let totalBytes = 0
      let truncated = false
      let timedOut = false
      let cleaned = false
      let forceKillTimeout: ReturnType<typeof setTimeout> | undefined

      const cleanup = async (): Promise<void> => {
        if (cleaned) return
        cleaned = true
        if (forceKillTimeout) clearTimeout(forceKillTimeout)
        await isolated.cleanup()
      }

      const timeout = setTimeout(() => {
        timedOut = true
        killChildProcess(child, "SIGTERM")
        forceKillTimeout = setTimeout(() => {
          if (child.exitCode === null) killChildProcess(child, "SIGKILL")
        }, 3000)
      }, timeoutMs)

      child.stdout.on("data", (chunk: Buffer) => {
        if (truncated) return
        if (totalBytes + chunk.length > captureBytes) {
          chunks.push(chunk.slice(0, captureBytes - totalBytes))
          truncated = true
        } else {
          chunks.push(chunk)
        }
        totalBytes += chunk.length
      })

      let stderrChunks: Buffer[] = []
      child.stderr.on("data", (chunk: Buffer) => {
        if (truncated) return
        if (totalBytes + chunk.length > captureBytes) {
          stderrChunks.push(chunk.slice(0, captureBytes - totalBytes))
          truncated = true
        } else {
          stderrChunks.push(chunk)
        }
        totalBytes += chunk.length
      })

      child.on("close", (code) => {
        clearTimeout(timeout)
        void cleanup().catch(() => {}).finally(() => {
          const output = Buffer.concat([...chunks, ...stderrChunks]).toString("utf-8") || "(no output)"
          const truncatedNote = truncated ? `\n\n[output truncated at ${Math.round(captureBytes / 1024)}KB safety limit]` : ""

          resolvePromise({
            exit: code ?? undefined,
            output: output + truncatedNote,
            truncated,
            isolation: isolated.mode,
            ...(timedOut ? { timeout: true } : {}),
          })
        })
      })

      child.on("error", (err) => {
        clearTimeout(timeout)
        void cleanup().catch(() => {}).finally(() => {
          rejectPromise(new Error(`Failed to execute command: ${err.message}`))
        })
      })
    })
  },
  toModelOutput: (_input, output): ReadonlyArray<ContentPart> => {
    const header = output.timeout
      ? "Command timed out before completion."
      : `Command exited with code ${output.exit ?? "?"}.`
    const isolation = output.isolation ? ` Isolation: ${output.isolation}.` : ""
    return [
      { type: "text", text: output.output },
      { type: "text", text: header + isolation },
    ]
  },
})

function shellArgs(command: string): string[] {
  return process.platform === "win32"
    ? ["/d", "/s", "/c", command]
    : ["-c", command]
}

export function buildAllowedEnvironment(allowlist: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of allowlist) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  if (!env.PATH) {
    env.PATH = process.platform === "win32"
      ? (process.env.Path ?? "C:\\Windows\\System32;C:\\Windows")
      : "/usr/local/bin:/usr/bin:/bin"
  }
  return env
}

function killChildProcess(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // 进程组可能已经退出，继续尝试杀主进程。
    }
  }
  child.kill(signal)
}
