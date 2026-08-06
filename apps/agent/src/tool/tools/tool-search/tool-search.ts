import { Schema } from "effect"
import { make, type ContentPart } from "../../framework/definition.js"
import {
  getDeferredToolSummaries,
  getDeferredToolSchema,
  executeDeferredTool,
} from "../../mcp-integration.js"

const Input = Schema.Struct({
  query: Schema.String.annotations({ description: "搜索关键词，匹配延迟加载的工具名称和描述。" }),
  tool_name: Schema.optional(
    Schema.String.annotations({ description: "要调用的工具全名（精确指定时跳过搜索）。" }),
  ),
  arguments: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }).annotations({
      description: "传给目标工具的参数。提供时直接执行该工具。",
    }),
  ),
})

const Output = Schema.Struct({
  action: Schema.Literal("search_results", "schema", "executed", "error"),
  message: Schema.String,
  tools: Schema.optional(
    Schema.Array(Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      serverName: Schema.String,
    })),
  ),
  schema: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  result: Schema.optional(Schema.Unknown),
})

export const toolSearchTool = make({
  name: "tool_search",
  riskLevel: "caution",
  // 延迟 MCP 工具最终会在本工具内部执行，不能让 tool_search 成为审批绕过通道。
  executionPolicy: { parallelizable: false, requiresExplicitApproval: true },
  description:
    "在用户明确批准后搜索并调用延迟加载的 MCP 工具。" +
    "仅传 query 时返回匹配工具列表；" +
    "传 tool_name 时返回该工具的参数 schema；" +
    "同时传 tool_name 和 arguments 时直接执行该工具并返回结果。",
  input: Input,
  output: Output,
  execute: async (input) => {
    const summaries = getDeferredToolSummaries();

    if (summaries.length === 0) {
      return {
        action: "error" as const,
        message: "当前没有延迟加载的工具。所有 MCP 工具已直接暴露。",
      }
    }

    if (input.tool_name) {
      const toolName = input.tool_name;
      const schema = getDeferredToolSchema(toolName);
      if (!schema) {
        const available = summaries.map((s) => s.name).join(", ");
        return {
          action: "error" as const,
          message: `未找到延迟工具 "${toolName}"。可用：${available}`,
        }
      }

      if (input.arguments) {
        try {
          const result = await executeDeferredTool(toolName, input.arguments);
          return {
            action: "executed" as const,
            message: `工具 ${toolName} 执行成功`,
            result,
          }
        } catch (err) {
          return {
            action: "error" as const,
            message: `工具 ${toolName} 执行失败：${err instanceof Error ? err.message : String(err)}`,
          }
        }
      }

      return {
        action: "schema" as const,
        message: `工具 ${toolName} 的参数 schema`,
        schema,
      }
    }

    const q = input.query.toLowerCase();
    const matched = summaries.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );

    if (matched.length === 0) {
      return {
        action: "search_results" as const,
        message: `没有匹配 "${input.query}" 的延迟工具。共 ${summaries.length} 个可用工具。`,
        tools: summaries.slice(0, 10),
      }
    }

    return {
      action: "search_results" as const,
      message: `找到 ${matched.length} 个匹配工具`,
      tools: matched,
    }
  },
  toModelOutput: (_in, out): ReadonlyArray<ContentPart> => {
    if (out.action === "error") {
      return [{ type: "text", text: out.message }]
    }
    if (out.action === "executed") {
      const text = typeof out.result === "string"
        ? out.result
        : JSON.stringify(out.result, null, 2);
      return [{ type: "text", text: `${out.message}\n\n${text}` }]
    }
    if (out.action === "schema") {
      return [{ type: "text", text: `${out.message}\n\n${JSON.stringify(out.schema, null, 2)}` }]
    }
    const lines = (out.tools ?? []).map(
      (t) => `- **${t.name}** (${t.serverName}): ${t.description}`,
    );
    return [{ type: "text", text: `${out.message}\n\n${lines.join("\n")}` }]
  },
})
