import { ToolFailure, type ToolContext } from "./definition.js"
import type { Materialization } from "./registry.js"

export interface ToolExecutionConfig {
  readonly toolTimeoutMs: number
  readonly toolOutputMaxChars: number
}

export interface ExecutionResult {
  readonly callId: string
  readonly toolName: string
  readonly ok: boolean
  readonly output?: unknown
  readonly error?: string
  readonly content?: ReadonlyArray<
    { type: "text"; text: string } | { type: "file"; data: string; mime: string; name?: string }
  >
}

export class ToolExecutionPipeline {
  constructor(
    private materialization: Materialization,
    private config: ToolExecutionConfig,
  ) {}

  async executeOne(
    toolName: string,
    args: unknown,
    ctx: ToolContext,
  ): Promise<ExecutionResult> {
    try {
      const settle = this.materialization.settle
      const result = await Promise.race([
        settle(toolName, args, ctx),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new ToolFailure({
                  message: `Tool ${toolName} timed out after ${this.config.toolTimeoutMs}ms`,
                }),
              ),
            this.config.toolTimeoutMs,
          ),
        ),
      ])
      return {
        callId: ctx.toolCallID,
        toolName,
        ok: true,
        output: result.output,
        content: result.content,
      }
    } catch (err: unknown) {
      const message =
        err instanceof ToolFailure
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      return {
        callId: ctx.toolCallID,
        toolName,
        ok: false,
        error: message,
      }
    }
  }

  async executeParallel(
    calls: ReadonlyArray<{ toolName: string; args: unknown; ctx: ToolContext }>,
  ): Promise<ReadonlyArray<ExecutionResult>> {
    return Promise.all(calls.map((c) => this.executeOne(c.toolName, c.args, c.ctx)))
  }

  async executeSequential(
    calls: ReadonlyArray<{ toolName: string; args: unknown; ctx: ToolContext }>,
  ): Promise<ReadonlyArray<ExecutionResult>> {
    const results: ExecutionResult[] = []
    for (const c of calls) {
      results.push(await this.executeOne(c.toolName, c.args, c.ctx))
    }
    return results
  }
}
