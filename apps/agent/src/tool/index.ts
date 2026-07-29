/**
 * 统一工具框架入口。
 *
 * 本文件负责：
 * 1. 初始化统一工具注册表（Effect-TS 工具 + Skill 工具）
 * 2. 为 Pi Runtime 提供工具获取接口
 */

import { unifiedToolRegistry, type UnifiedToolContext } from './unified-registry.js';
import { initializeSkillIntegration, filterToolsByOwningSkill } from './skill-integration.js';
import { registerEffectTools } from './effect-bridge.js';
import { registerInstallSkillTool } from './install-skill.js';
import { allTools } from './builtins.js';
import { getLogger } from '../logging/logger.js';

export { unifiedToolRegistry, type UnifiedToolDef, type UnifiedToolContext } from './unified-registry.js';
export {
  initializeSkillIntegration,
  filterToolsByOwningSkill,
  SKILL_OWNED_TOOLS,
} from './skill-integration.js';

let initialized = false;

export function initializeUnifiedToolFramework(): void {
  if (initialized) return;
  initialized = true;
  const log = getLogger('tool/index');

  registerEffectTools(allTools);
  log.info({ count: allTools.length }, 'Effect-TS 工具已注册');

  initializeSkillIntegration();
  registerInstallSkillTool();
  log.info('Skill 工具已集成');

  log.info({ tools: unifiedToolRegistry.listNames() }, '统一工具框架初始化完成');
}

/**
 * 主 Agent 可见的工具面。
 *
 * 唯一的收窄规则是 SKILL_OWNED_TOOLS——归属 skill 被禁用时一并收起。
 * 这里不做 allowed-tools 沙箱降权：本项目的 skill 是上下文注入，
 * 且工具集在 AgentHarness 构造时一次性冻结，无法随 load_skill 中途变更。
 */
export function getAgentToolsForPi() {
  const filteredToolNames = filterToolsByOwningSkill(unifiedToolRegistry.listNames());
  return unifiedToolRegistry.toAgentTools(filteredToolNames);
}

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
