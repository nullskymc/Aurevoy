/**
 * 统一工具框架入口。
 *
 * 本文件负责：
 * 1. 初始化统一工具注册表
 * 2. 桥接旧框架工具
 * 3. 集成 Skill 工具
 * 4. 为 Pi Runtime 提供工具获取接口
 */

import { unifiedToolRegistry, type UnifiedToolContext } from './unified-registry.js';
import { initializeToolBridge } from './bridge.js';
import { initializeSkillIntegration, filterToolsBySkill } from './skill-integration.js';

// 副作用导入：确保所有内置工具在统一注册表中可用
import '../tools/builtins.js';
import '../tools/file-basics.js';
import '../tools/new-tools.js';
import { getLogger } from '../logging/logger.js';

export { unifiedToolRegistry, type UnifiedToolDef, type UnifiedToolContext } from './unified-registry.js';
export { initializeToolBridge } from './bridge.js';
export { initializeSkillIntegration, filterToolsBySkill } from './skill-integration.js';

/**
 * 初始化统一工具框架。
 *
 * 调用顺序：
 * 1. 桥接旧注册表工具
 * 2. 集成 Skill 工具
 */
export function initializeUnifiedToolFramework(): void {
  const log = getLogger('tool/index');

  // 1. 桥接旧注册表工具
  initializeToolBridge();
  log.info({ count: unifiedToolRegistry.listNames().length }, '旧框架工具已桥接');

  // 2. 集成 Skill 工具
  initializeSkillIntegration();
  log.info({ count: unifiedToolRegistry.listNames().length }, 'Skill 工具已集成');

  log.info({ tools: unifiedToolRegistry.listNames() }, '统一工具框架初始化完成');
}

/**
 * 获取 Pi Agent 可用的工具列表。
 *
 * @param activeSkill 当前激活的 Skill 名称（可选）
 * @returns Pi Agent 工具数组
 */
export function getAgentToolsForPi(activeSkill?: string) {
  const allToolNames = unifiedToolRegistry.listNames();
  const filteredToolNames = filterToolsBySkill(allToolNames, activeSkill);

  return unifiedToolRegistry.toAgentTools(filteredToolNames);
}

/**
 * 获取工具执行上下文工厂函数。
 *
 * 用于为每个工具调用创建上下文。
 */
export function createToolContext(
  taskId: string,
  workspaceDir: string,
  options?: {
    taskGoal?: string;
    externalPaths?: string[];
    abortSignal?: AbortSignal;
    callId?: string;
    publishEvent?: (event: Record<string, unknown>) => void;
    task?: import('@aurevoy/shared').Task;
  }
): UnifiedToolContext {
  return {
    taskId,
    taskGoal: options?.taskGoal,
    workspaceDir,
    externalPaths: options?.externalPaths,
    abortSignal: options?.abortSignal,
    callId: options?.callId ?? '',
    publishEvent: options?.publishEvent,
    task: options?.task,
  };
}
