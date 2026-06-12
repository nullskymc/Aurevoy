import type { ToolDescriptor, ToolCall, ToolResult, ToolRiskLevel, Task } from '@aurevoy/shared';

/** 工具执行上下文：携带本次调用所属的任务等信息（如 remember 工具记录来源）。 */
export interface ToolContext {
  taskId?: string;
  taskGoal?: string;
  task?: Task;
  abortSignal?: AbortSignal;
  /** 本次工具调用的工作区根目录（per-task，由 Agent 循环解析） */
  workspaceDir: string;
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
    const validationError = validateToolArgs(tool.descriptor.inputSchema, call.args);
    if (validationError) {
      return {
        callId: call.id,
        ok: false,
        error: `工具参数不符合 schema：${validationError}`,
        output: {
          code: 'schema_validation_failed',
          message: validationError,
        },
      };
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

function validateToolArgs(schema: Record<string, unknown>, args: Record<string, unknown>): string | null {
  return validateSchema(schema, args, 'args');
}

function validateSchema(schema: unknown, value: unknown, path: string): string | null {
  if (!isRecord(schema)) return null;

  const type = schema.type;
  if (typeof type === 'string') {
    const typeError = validateType(type, value, path);
    if (typeError) return typeError;
  }

  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && !enumValues.includes(value)) {
    return `${path} 必须是 ${enumValues.map(String).join(' | ')}`;
  }

  if (type === 'object' || (isRecord(value) && isRecord(schema.properties))) {
    if (!isRecord(value)) return `${path} 必须是对象`;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === 'string' && value[key] === undefined) return `${path}.${key} 必填`;
    }
    for (const [key, item] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (propertySchema === undefined) {
        if (schema.additionalProperties === false) return `${path}.${key} 不允许`;
        if (isRecord(schema.additionalProperties)) {
          const nestedError = validateSchema(schema.additionalProperties, item, `${path}.${key}`);
          if (nestedError) return nestedError;
        }
        continue;
      }
      const nestedError = validateSchema(propertySchema, item, `${path}.${key}`);
      if (nestedError) return nestedError;
    }
  }

  if (type === 'array' || Array.isArray(value)) {
    if (!Array.isArray(value)) return `${path} 必须是数组`;
    const itemSchema = schema.items;
    if (itemSchema !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        const nestedError = validateSchema(itemSchema, value[index], `${path}[${index}]`);
        if (nestedError) return nestedError;
      }
    }
  }

  return null;
}

function validateType(type: string, value: unknown, path: string): string | null {
  switch (type) {
    case 'object':
      return isRecord(value) ? null : `${path} 必须是对象`;
    case 'array':
      return Array.isArray(value) ? null : `${path} 必须是数组`;
    case 'string':
      return typeof value === 'string' ? null : `${path} 必须是字符串`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `${path} 必须是数字`;
    case 'integer':
      return Number.isInteger(value) ? null : `${path} 必须是整数`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path} 必须是布尔值`;
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
