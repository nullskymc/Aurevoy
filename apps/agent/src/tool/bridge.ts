/**
 * 工具桥接层：将旧框架工具转换为统一工具格式。
 *
 * 本文件负责：
 * 1. 将旧注册表（tools/registry.ts）的工具桥接到统一注册表
 * 2. 将 NEW_TOOLS（register-new-tools.ts）桥接到统一注册表
 * 3. 为 Pi Runtime 提供统一的工具获取接口
 */

import type { ToolCall } from '@aurevoy/shared';
import { toolRegistry as oldRegistry } from '../tools/registry.js';
import { NEW_TOOLS } from '../agent/register-new-tools.js';
import { unifiedToolRegistry, type UnifiedToolDef } from './unified-registry.js';

/** 旧框架工具上下文 */
interface OldToolContext {
  taskId?: string;
  taskGoal?: string;
  task?: any;
  abortSignal?: AbortSignal;
  workspaceDir: string;
  externalPaths?: string[];
  publishEvent?: (event: Record<string, unknown>) => void;
  callId?: string;
}

/**
 * 桥接旧注册表中的所有工具到统一注册表。
 */
export function bridgeOldRegistryTools(): void {
  const descriptors = oldRegistry.listAll();

  for (const descriptor of descriptors) {
    // 跳过已注册的工具
    if (unifiedToolRegistry.get(descriptor.name)) continue;

    const unifiedTool: UnifiedToolDef = {
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      riskLevel: descriptor.riskLevel ?? 'safe',
      executionPolicy: descriptor.executionPolicy,
      source: descriptor.source ?? { type: 'builtin' },
      execute: async (args, context) => {
        // 转换为旧框架的 ToolCall
        const call: ToolCall = {
          id: context.callId,
          toolName: descriptor.name,
          args,
        };

        // 转换为旧框架的上下文
        const oldContext: OldToolContext = {
          taskId: context.taskId,
          taskGoal: context.taskGoal,
          workspaceDir: context.workspaceDir,
          externalPaths: context.externalPaths,
          abortSignal: context.abortSignal,
          publishEvent: context.publishEvent,
          callId: context.callId,
        };

        // 调用旧注册表的 invoke 方法
        const result = await oldRegistry.invoke(call, oldContext);

        if (!result.ok) {
          throw new Error(result.error ?? '工具执行失败');
        }

        return result.output;
      },
    };

    unifiedToolRegistry.register(unifiedTool);
  }
}

/**
 * 桥接 NEW_TOOLS 到统一注册表。
 */
export function bridgeNewTools(): void {
  for (const entry of NEW_TOOLS) {
    // 跳过已注册的工具
    if (unifiedToolRegistry.get(entry.name)) continue;

    const unifiedTool: UnifiedToolDef = {
      name: entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
      riskLevel: entry.riskLevel,
      executionPolicy: entry.executionPolicy,
      source: { type: 'builtin' },
      execute: async (args, context) => {
        return entry.execute(args, { workspaceDir: context.workspaceDir });
      },
    };

    unifiedToolRegistry.register(unifiedTool);
  }
}

/**
 * 初始化工具桥接：桥接旧注册表和 NEW_TOOLS。
 */
export function initializeToolBridge(): void {
  bridgeOldRegistryTools();
  bridgeNewTools();
}
