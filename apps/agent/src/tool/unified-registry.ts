/**
 * 统一工具注册表（Pi Agent 优先）。
 *
 * 以 Pi Agent 的 AgentTool 接口为核心，提供：
 * 1. 旧框架工具 → AgentTool 桥接
 * 2. Skill 工具动态注册
 * 3. 工具白名单管理（基于 Skill allowed-tools）
 *
 * 设计原则：
 * - Pi Runtime 直接使用本注册表的 toAgentTools() 获取工具列表
 * - 所有工具统一注册到本注册表，不再维护多套注册表
 * - Skill 的 allowed-tools 用于过滤工具列表，而非创建新工具
 */

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TSchema } from 'typebox';
import type { ToolDescriptor, ToolRiskLevel, ToolExecutionPolicy, ToolSource, Task } from '@aurevoy/shared';
import { Type } from 'typebox';

// ---- 工具上下文（统一接口）----

export interface UnifiedToolContext {
  taskId: string;
  taskGoal?: string;
  workspaceDir: string;
  externalPaths?: string[];
  abortSignal?: AbortSignal;
  callId: string;
  publishEvent?: (event: Record<string, unknown>) => void;
  task?: Task;
}

// ---- 工具定义 ----

/** 统一工具定义 */
export interface UnifiedToolDef {
  /** 工具名称 */
  name: string;
  /** 工具描述 */
  description: string;
  /** 输入参数 JSON Schema */
  inputSchema: Record<string, unknown>;
  /** 风险等级 */
  riskLevel: ToolRiskLevel;
  /** 执行策略 */
  executionPolicy?: ToolExecutionPolicy;
  /** 工具来源 */
  source?: ToolSource;
  /** 执行函数 */
  execute: (args: Record<string, unknown>, context: UnifiedToolContext) => Promise<unknown>;
}

// ---- 统一注册表 ----

class UnifiedToolRegistry {
  private tools = new Map<string, UnifiedToolDef>();
  private enabledByName = new Map<string, boolean>();

  /** 注册工具 */
  register(tool: UnifiedToolDef): void {
    this.tools.set(tool.name, tool);
    if (!this.enabledByName.has(tool.name)) {
      this.enabledByName.set(tool.name, true);
    }
  }

  /** 批量注册工具 */
  registerAll(tools: UnifiedToolDef[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /** 注销工具 */
  unregister(name: string): boolean {
    this.enabledByName.delete(name);
    return this.tools.delete(name);
  }

  /** 注销指定来源的工具 */
  unregisterBySource(sourceType: 'builtin' | 'skill' | 'mcp', sourceName?: string): number {
    let count = 0;
    for (const [name, tool] of this.tools.entries()) {
      if (tool.source?.type !== sourceType) continue;
      if (sourceName) {
        if (tool.source.type === 'mcp' && tool.source.serverName !== sourceName) continue;
        if (tool.source.type === 'skill' && tool.source.skillName !== sourceName) continue;
      }
      this.tools.delete(name);
      this.enabledByName.delete(name);
      count++;
    }
    return count;
  }

  /** 获取工具定义 */
  get(name: string): UnifiedToolDef | undefined {
    return this.tools.get(name);
  }

  /** 列出所有工具名称 */
  listNames(): string[] {
    return [...this.tools.keys()].sort();
  }

  /** 列出所有工具描述符 */
  listDescriptors(): ToolDescriptor[] {
    return [...this.tools.values()].map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      riskLevel: tool.riskLevel,
      executionPolicy: tool.executionPolicy,
      source: tool.source,
      enabled: this.isEnabled(tool.name),
    }));
  }

  /** 判断工具是否启用 */
  isEnabled(name: string): boolean {
    return this.enabledByName.get(name) !== false;
  }

  /** 设置工具启用状态 */
  setEnabled(name: string, enabled: boolean): boolean {
    if (!this.tools.has(name)) return false;
    this.enabledByName.set(name, enabled);
    return true;
  }

  /** 查询工具风险等级 */
  riskLevelOf(name: string): ToolRiskLevel {
    return this.tools.get(name)?.riskLevel ?? 'safe';
  }

  /** 查询工具执行策略 */
  executionPolicyOf(name: string): ToolExecutionPolicy {
    return this.tools.get(name)?.executionPolicy ?? { parallelizable: true };
  }

  /**
   * 转换为 Pi Agent 的 AgentTool 数组。
   *
   * @param filter 可选的工具名称白名单（用于 Skill allowed-tools 过滤）
   */
  toAgentTools(filter?: string[]): AgentTool[] {
    const tools = filter
      ? [...this.tools.values()].filter(t => filter.includes(t.name) && this.isEnabled(t.name))
      : [...this.tools.values()].filter(t => this.isEnabled(t.name));

    return tools.map(tool => this.toAgentTool(tool));
  }

  /** 将单个工具转换为 AgentTool */
  private toAgentTool(tool: UnifiedToolDef): AgentTool {
    // 将 JSON Schema 转换为 TypeBox schema
    const parameters = this.jsonSchemaToTypeBox(tool.inputSchema);

    return {
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters,
      executionMode: tool.executionPolicy?.parallelizable === false ? 'sequential' : 'parallel',
      execute: async (toolCallId: string, params: unknown, signal?: AbortSignal, _onUpdate?: (partial: AgentToolResult<any>) => void): Promise<AgentToolResult<any>> => {
        const validationError = validateToolInputSchema(tool.inputSchema, params);
        if (validationError) {
          throw new Error(`schema_validation_failed: ${validationError}`);
        }
        const context: UnifiedToolContext = {
          taskId: '', // 由调用方注入
          workspaceDir: '', // 由调用方注入
          abortSignal: signal,
          callId: toolCallId,
        };

        const result = await tool.execute(params as Record<string, unknown>, context);
        return {
          content: [{ type: 'text', text: this.formatResult(result) }],
          details: result,
        };
      },
    };
  }

  /** 将 JSON Schema 转换为 TypeBox schema（简化版） */
  private jsonSchemaToTypeBox(schema: Record<string, unknown>): TSchema {
    return jsonSchemaToTypeBox(schema);
  }

  /** 格式化工具结果为文本 */
  private formatResult(result: unknown): string {
    if (typeof result === 'string') return result;
    try {
      return JSON.stringify(result ?? null, null, 2);
    } catch {
      return String(result);
    }
  }
}

// ---- 导出单例 ----

export const unifiedToolRegistry = new UnifiedToolRegistry();

export function validateToolInputSchema(schema: unknown, value: unknown): string | null {
  return validateSchema(schema, value, 'args');
}

function jsonSchemaToTypeBox(schema: unknown): TSchema {
  if (!isRecord(schema)) return Type.Unknown();

  const options = schemaOptions(schema);
  const anyOf = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(anyOf)) {
    const variants = anyOf.map(jsonSchemaToTypeBox);
    return unionOrSingle(variants, options);
  }

  if (Array.isArray(schema.enum)) {
    const variants = schema.enum
      .filter((value) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null)
      .map((value) => value === null ? Type.Null() : Type.Literal(value));
    return unionOrSingle(variants, options);
  }

  const type = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (type.length > 1) {
    const variants = type.map((item) => jsonSchemaToTypeBox({ ...schema, type: item }));
    return unionOrSingle(variants, options);
  }

  switch (type[0]) {
    case 'object': {
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []);
      const mapped: Record<string, TSchema> = {};
      for (const [key, value] of Object.entries(properties)) {
        const child = jsonSchemaToTypeBox(value);
        mapped[key] = required.has(key) ? child : Type.Optional(child);
      }
      return Type.Object(mapped, {
        ...options,
        additionalProperties: schema.additionalProperties === false ? false : undefined,
      });
    }
    case 'array':
      return Type.Array(jsonSchemaToTypeBox(schema.items), options);
    case 'string':
      return Type.String(options);
    case 'number':
      return Type.Number(options);
    case 'integer':
      return Type.Integer(options);
    case 'boolean':
      return Type.Boolean(options);
    case 'null':
      return Type.Null(options);
    default:
      if (isRecord(schema.properties)) return jsonSchemaToTypeBox({ ...schema, type: 'object' });
      return Type.Unknown(options);
  }
}

function unionOrSingle(variants: TSchema[], options: Record<string, unknown>): TSchema {
  if (variants.length === 0) return Type.Unknown(options);
  if (variants.length === 1) return variants[0];
  return Type.Union(variants as unknown as [TSchema, TSchema, ...TSchema[]], options);
}

function schemaOptions(schema: Record<string, unknown>): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const key of ['description', 'title', 'default', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern']) {
    if (schema[key] !== undefined) options[key] = schema[key];
  }
  return options;
}

function validateSchema(schema: unknown, value: unknown, path: string): string | null {
  if (!isRecord(schema)) return null;

  const anyOf = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(anyOf) && anyOf.length > 0) {
    const errors = anyOf.map((item) => validateSchema(item, value, path)).filter(Boolean);
    return errors.length === anyOf.length ? `${path} 不匹配任何允许的 schema：${errors.join('; ')}` : null;
  }

  const type = schema.type;
  if (Array.isArray(type)) {
    const errors = type.map((item) => validateSchema({ ...schema, type: item }, value, path)).filter(Boolean);
    return errors.length === type.length ? `${path} 类型不匹配：${errors.join('; ')}` : null;
  }

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
    if (schema.items !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        const nestedError = validateSchema(schema.items, value[index], `${path}[${index}]`);
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
    case 'null':
      return value === null ? null : `${path} 必须是 null`;
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
