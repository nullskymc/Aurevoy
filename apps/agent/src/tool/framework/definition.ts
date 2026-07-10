import { Schema, Data } from "effect"
import { fromAST } from "effect/JSONSchema"
import type { Task } from "@aurevoy/shared"

export interface ToolContext {
  readonly sessionID: string
  readonly taskID: string
  readonly agent: string
  readonly assistantMessageID: string
  readonly toolCallID: string
  readonly workspaceDir: string
  readonly externalPaths: readonly string[]
  /** 由主 harness 透传，确保 delegate 等长任务能随父任务取消。 */
  readonly abortSignal?: AbortSignal
  /** 仅供需要渐进反馈的工具发布既有 SSE 事件。 */
  readonly publishEvent?: (event: Record<string, unknown>) => void
  /** 父任务快照；工具不得绕过 store 把它当作独立真相源。 */
  readonly task?: Task
}

export class ToolFailure extends Data.TaggedError("ToolFailure")<{
  readonly message: string
}> {}

export class InvalidToolInput extends Data.TaggedError("InvalidToolInput")<{
  readonly message: string
}> {}

export class ToolExecutionError extends Data.TaggedError("ToolExecutionError")<{
  readonly toolName: string
  readonly message: string
}> {}

export class RegistrationError extends Data.TaggedError("RegistrationError")<{
  readonly name: string
  readonly message: string
}> {}

export type ContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly data: string; readonly mime: string; readonly name?: string }

function schemaToJSONSchema(s: Schema.Schema<any>): Record<string, unknown> {
  const ts = Schema.typeSchema(s)
  const json = fromAST(ts.ast, { definitions: {}, definitionPath: "#/$defs/" })
  return json as unknown as Record<string, unknown>
}

export interface ToolConfig<I, O> {
  readonly name: string
  readonly description: string
  readonly input: Schema.Schema<I>
  readonly output: Schema.Schema<O>
  readonly execute: (input: I, ctx: ToolContext) => Promise<O>
  readonly toModelOutput?: (input: I, output: O) => ReadonlyArray<ContentPart>
}

export interface ToolRuntime<I, O> {
  readonly config: ToolConfig<I, O>
  readonly inputJSONSchema: Record<string, unknown>
  readonly settle: (args: unknown, ctx: ToolContext) => Promise<{
    output: unknown
    content: ReadonlyArray<{ type: "text"; text: string } | { type: "file"; data: string; mime: string; name?: string }>
  }>
}

export interface AnyTool {
  readonly _I: any
  readonly _O: any
  readonly name: string
  readonly description: string
  readonly inputJSONSchema: Record<string, unknown>
  readonly runtime: () => ToolRuntime<any, any>
}

export function make<I, O>(config: ToolConfig<I, O>): AnyTool {
  const inputJSONSchema = schemaToJSONSchema(config.input)
  const runtime: ToolRuntime<I, O> = {
    config,
    inputJSONSchema,
    settle: async (rawArgs: unknown, ctx: ToolContext) => {
      const decoded = Schema.decodeUnknownSync(config.input)(rawArgs)
      const output = await config.execute(decoded, ctx)
      const encoded = Schema.encodeSync(config.output)(output)
      const content = config.toModelOutput
        ? config.toModelOutput(decoded, output)
        : typeof encoded === "string"
          ? [{ type: "text" as const, text: encoded }]
          : [{ type: "text" as const, text: JSON.stringify(encoded, null, 2) }]
      return {
        output: encoded,
        content: content.map((p) =>
          p.type === "text"
            ? { type: "text" as const, text: p.text }
            : { type: "file" as const, data: p.data, mime: p.mime, name: p.name },
        ),
      }
    },
  }
  return {
    _I: undefined as I,
    _O: undefined as O,
    name: config.name,
    description: config.description,
    inputJSONSchema,
    runtime: () => runtime,
  }
}

export function validateName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)
}

export function toJsonSchemaForLLM(tool: AnyTool): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputJSONSchema,
    },
  }
}
