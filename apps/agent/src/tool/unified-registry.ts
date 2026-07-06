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
  private jsonSchemaToTypeBox(_schema: Record<string, unknown>): TSchema {
    // 简化实现：返回一个通用的 Record schema
    // 实际上 Pi Agent 会使用这个 schema 进行参数验证
    return Type.Record(Type.String(), Type.Unknown()) as TSchema;
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
