/**
 * Skill 工具集成：将 Skill 系统集成到统一工具框架。
 *
 * 本文件负责：
 * 1. 注册 load_skill 工具到统一注册表
 * 2. 管理 Skill 的 allowed-tools 白名单
 * 3. 提供基于 Skill 上下文的工具过滤
 */

import { skillRegistry } from '../skills/registry.js';
import { unifiedToolRegistry, type UnifiedToolDef } from './unified-registry.js';
import { getLogger } from '../logging/logger.js';

/**
 * 注册 load_skill 工具到统一注册表。
 *
 * 该工具允许 LLM 在对话中加载 Skill 的完整指令。
 */
export function registerLoadSkillTool(): void {
  const allDescriptors = skillRegistry.listAll();
  const enabledDescriptors = allDescriptors.filter((s) => s.enabled);

  if (enabledDescriptors.length === 0) {
    return;
  }

  const catalogLines = enabledDescriptors.map((s) =>
    `- ${s.name}: ${s.description}`,
  ).join('\n');

  const enabledNames = enabledDescriptors.map((s) => s.name);

  const loadSkillTool: UnifiedToolDef = {
    name: 'load_skill',
    description:
      '将技能（skill）的完整指令一次性加载到当前对话上下文中。\n' +
      '传入 name 参数加载指定技能，返回完整操作指南和附属资源列表。\n' +
      `可用技能：\n${catalogLines}`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '要加载的技能名称。',
          enum: enabledNames,
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    riskLevel: 'safe',
    executionPolicy: { parallelizable: false },
    source: { type: 'builtin' },
    execute: async (args, context) => {
      const log = getLogger('tool/skill-integration');
      const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : null;

      if (!name) {
        return {
          action: 'noop',
          message: '技能名称不能为空。可用 skill 列表：' + skillRegistry.list().join(', '),
          availableSkills: skillRegistry.list(),
        };
      }

      const content = skillRegistry.getContent(name);
      const entry = skillRegistry.get(name);
      if (!content || !entry) {
        const available = skillRegistry.list().join(', ') || '(无)';
        return {
          error: `未知技能 "${name}"。可用技能：${available}`,
          availableSkills: skillRegistry.list(),
        };
      }

      if (!skillRegistry.isEnabled(name)) {
        return {
          error: `技能 "${name}" 已被禁用，无法加载。请先在设置中启用。`,
        };
      }

      log.info({ taskId: context.taskId, skill: name }, 'skill 已加载');

      const resourceLines = content.resources.length > 0
        ? '\n<skill_resources>\n' +
          content.resources.map((r) => `  <file>${r.relativePath}</file>`).join('\n') +
          '\n</skill_resources>'
        : '';

      const skillDir = entry.skillDir;

      const wrappedContent =
        `<skill_content name="${name}">\n` +
        `${content.body}\n\n` +
        `Skill directory: ${skillDir}\n` +
        `Relative paths in this skill are relative to the skill directory.` +
        `${resourceLines}\n` +
        `</skill_content>`;

      return {
        action: 'loaded',
        skill: name,
        description: entry.frontmatter.description,
        compatibility: entry.frontmatter.compatibility ?? null,
        content: wrappedContent,
        message: `已加载技能 "${name}"。指令已注入当前上下文。`,
      };
    },
  };

  unifiedToolRegistry.register(loadSkillTool);
}

/**
 * 获取 Skill 的 allowed-tools 白名单。
 *
 * @param skillName Skill 名称
 * @returns 工具名称数组，如果 Skill 不存在或没有白名单则返回 undefined
 */
export function getSkillAllowedTools(skillName: string): string[] | undefined {
  const entry = skillRegistry.get(skillName);
  if (!entry) return undefined;
  return entry.frontmatter['allowed-tools'];
}

/**
 * 获取所有已启用 Skill 的合并白名单。
 *
 * @returns 工具名称数组（去重），如果没有 Skill 有白名单则返回 undefined
 */
export function getAllSkillAllowedTools(): string[] | undefined {
  const allDescriptors = skillRegistry.listAll();
  const enabledDescriptors = allDescriptors.filter((s) => s.enabled);

  const allowedTools = new Set<string>();
  let hasAnyAllowedTools = false;

  for (const descriptor of enabledDescriptors) {
    const tools = descriptor.allowedTools;
    if (tools && tools.length > 0) {
      hasAnyAllowedTools = true;
      for (const tool of tools) {
        allowedTools.add(tool);
      }
    }
  }

  return hasAnyAllowedTools ? [...allowedTools] : undefined;
}

/**
 * 根据当前激活的 Skill 过滤工具列表。
 *
 * @param allToolNames 所有可用工具名称
 * @param activeSkill 当前激活的 Skill 名称（可选）
 * @returns 过滤后的工具名称数组
 */
export function filterToolsBySkill(allToolNames: string[], activeSkill?: string): string[] {
  if (!activeSkill) {
    // 没有激活的 Skill，返回所有工具
    return allToolNames;
  }

  const allowedTools = getSkillAllowedTools(activeSkill);
  if (!allowedTools || allowedTools.length === 0) {
    // Skill 没有白名单限制，返回所有工具
    return allToolNames;
  }

  // 过滤出白名单中的工具
  return allToolNames.filter(name => allowedTools.includes(name));
}

/**
 * 初始化 Skill 工具集成。
 */
export function initializeSkillIntegration(): void {
  registerLoadSkillTool();
}
