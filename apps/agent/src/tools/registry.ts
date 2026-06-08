import type { ToolDescriptor, ToolCall, ToolResult, ToolRiskLevel } from '@aurevoy/shared';

/** 工具执行上下文：携带本次调用所属的任务等信息（如 remember 工具记录来源）。 */
export interface ToolContext {
  taskId?: string;
  taskGoal?: string;
}

/** 一个可被 Agent 调用的工具 */
export interface Tool {
  descriptor: ToolDescriptor;
  execute(args: Record<string, unknown>, context?: ToolContext): Promise<unknown>;
}

/**
 * 工具注册表。
 *
 * Agent 循环通过它发现并调用工具。后续接入 MCP (Model Context Protocol)
 * 时，可在启动阶段把 MCP server 暴露的工具动态注册进来，对 Agent 透明。
 */
class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.descriptor.name, tool);
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()].map((t) => t.descriptor);
  }

  /** 查询某工具的风险等级；未知工具或未声明时返回 'safe' */
  riskLevelOf(name: string): ToolRiskLevel {
    return this.tools.get(name)?.descriptor.riskLevel ?? 'safe';
  }

  async invoke(call: ToolCall, context?: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(call.toolName);
    if (!tool) {
      return { callId: call.id, ok: false, error: `未知工具: ${call.toolName}` };
    }
    try {
      const output = await tool.execute(call.args, context);
      return { callId: call.id, ok: true, output };
    } catch (err) {
      return {
        callId: call.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export const toolRegistry = new ToolRegistry();

// ---- 示例内置工具：返回当前时间，验证工具调用链路 ----
toolRegistry.register({
  descriptor: {
    name: 'get_current_time',
    description: '获取当前的 ISO 时间戳',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    riskLevel: 'safe',
  },
  async execute() {
    return { now: new Date().toISOString() };
  },
});

// 内置基础工具（文件/网络）在 tools/builtins.ts 中注册，由进程入口导入触发。
// TODO: 在此处接入 MCP server 暴露的工具：
//   const mcpTools = await connectMcpServer(...);
//   mcpTools.forEach((t) => toolRegistry.register(t));
