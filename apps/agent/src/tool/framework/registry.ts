import { Context, Effect, Layer, Scope } from "effect"
import { ToolFailure, type AnyTool, type ToolContext, validateName, toJsonSchemaForLLM } from "./definition.js"

export interface Materialization {
  readonly toolDefs: ReadonlyArray<Record<string, unknown>>
  readonly settle: (toolName: string, args: unknown, ctx: ToolContext) => Promise<{
    output: unknown
    content: ReadonlyArray<{ type: "text"; text: string } | { type: "file"; data: string; mime: string; name?: string }>
  }>
}

export interface ToolRegistryService {
  readonly register: (tools: ReadonlyArray<AnyTool>) => Effect.Effect<void, never, Scope.Scope>
  readonly materialize: () => Materialization
  readonly listNames: () => ReadonlyArray<string>
  readonly get: (name: string) => AnyTool | undefined
}

export class ToolRegistry extends Context.Tag("ToolRegistry")<
  ToolRegistry,
  ToolRegistryService
>() {}

export const layer = Layer.effect(
  ToolRegistry,
  Effect.sync(() => {
    const local = new Map<string, Array<{ token: object; tool: AnyTool }>>()

    const service: ToolRegistryService = {
      register: (tools) =>
        Effect.gen(function* () {
          if (tools.length === 0) return
          for (const tool of tools) {
            if (!validateName(tool.name)) {
              yield* Effect.die(new Error(`Invalid tool name: ${tool.name}`))
            }
          }
          const token = {}
          for (const tool of tools) {
            const list = local.get(tool.name) ?? []
            local.set(tool.name, [...list, { token, tool }])
          }
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              for (const tool of tools) {
                const filtered = (local.get(tool.name) ?? []).filter((r) => r.token !== token)
                if (filtered.length > 0) local.set(tool.name, filtered)
                else local.delete(tool.name)
              }
            }),
          )
        }),

      materialize: () => {
        const visible = new Map<string, AnyTool>()
        for (const [name, entries] of local) {
          const latest = entries.at(-1)?.tool
          if (latest) visible.set(name, latest)
        }
        return {
          toolDefs: Array.from(visible, ([_name, tool]) => toJsonSchemaForLLM(tool)),
          settle: async (toolName, args, ctx) => {
            const tool = visible.get(toolName)
            if (!tool) throw new ToolFailure({ message: `Unknown tool: ${toolName}` })
            return tool.runtime().settle(args, ctx)
          },
        }
      },

      listNames: () => Array.from(local.keys()),

      get: (name) => local.get(name)?.at(-1)?.tool,
    }

    return service
  }),
)
