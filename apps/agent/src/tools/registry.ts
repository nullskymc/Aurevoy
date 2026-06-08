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
  private enabledByName = new Map<string, boolean>();

  register(tool: Tool): void {
    const descriptor: ToolDescriptor = {
      ...tool.descriptor,
      source: tool.descriptor.source ?? { type: 'builtin' },
    };
    this.tools.set(descriptor.name, { ...tool, descriptor });
    if (!this.enabledByName.has(descriptor.name)) this.enabledByName.set(descriptor.name, true);
  }

  list(): ToolDescriptor[] {
    return this.listAll().filter((tool) => tool.enabled !== false);
  }

  listAll(): ToolDescriptor[] {
    return [...this.tools.values()].map((t) => ({
      ...t.descriptor,
      enabled: this.isEnabled(t.descriptor.name),
    }));
  }

  /** 查询某工具的风险等级；未知工具或未声明时返回 'safe' */
  riskLevelOf(name: string): ToolRiskLevel {
    return this.tools.get(name)?.descriptor.riskLevel ?? 'safe';
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  isEnabled(name: string): boolean {
    return this.enabledByName.get(name) !== false;
  }

  setEnabled(name: string, enabled: boolean): boolean {
    if (!this.tools.has(name)) return false;
    this.enabledByName.set(name, enabled);
    return true;
  }

  applySettings(settings: Map<string, boolean>): void {
    for (const [name, enabled] of settings) {
      if (this.tools.has(name)) this.enabledByName.set(name, enabled);
    }
  }

  unregisterMcpTools(): void {
    for (const [name, tool] of this.tools.entries()) {
      if (tool.descriptor.source?.type === 'mcp') {
        this.tools.delete(name);
        this.enabledByName.delete(name);
      }
    }
  }

  async invoke(call: ToolCall, context?: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(call.toolName);
    if (!tool) {
      return { callId: call.id, ok: false, error: `未知工具: ${call.toolName}` };
    }
    if (!this.isEnabled(call.toolName)) {
      return { callId: call.id, ok: false, error: `工具已禁用: ${call.toolName}` };
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
