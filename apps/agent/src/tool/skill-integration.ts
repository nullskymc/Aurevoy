/**
 * Skill 工具集成：将 Skill 系统集成到统一工具框架。
 *
 * 本文件负责：
 * 1. 注册 load_skill 工具到统一注册表
 * 2. 按 skill 启用状态门控归属工具（SKILL_OWNED_TOOLS）
 *
 * 不负责 allowed-tools 沙箱降权——见 skills/types.ts 中该字段的说明。
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
 * 归属某个 skill 的工具：只有该 skill 处于启用状态时才暴露给模型。
 *
 * 这类工具的调用规则完全写在 SKILL.md 里（沙箱约束、验收清单等），
 * 工具 description 只能承载浓缩版。若 skill 被用户在设置里关掉，
 * 说明书就不再进入上下文，此时继续暴露工具会让模型盲调并被校验拒绝——
 * 因此按 skill 启用状态一并收起，保证「关掉 skill = 关掉这项能力」。
 *
 * 注意这是「skill 启用与否」的静态门控，与标准里的 allowed-tools 沙箱降权无关：
 * 本项目的 skill 是上下文注入，不是受限执行环境，详见 SkillFrontmatter 的字段说明。
 */
export const SKILL_OWNED_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  present_ui: 'visualize',
});

/**
 * 过滤掉所属 skill 已被禁用的工具。
 *
 * 只对 SKILL_OWNED_TOOLS 中登记的工具生效；其余工具原样保留。
 * skill 不存在（例如打包遗漏 builtin 目录）时同样收起对应工具，
 * 避免暴露一个没有任何使用说明的工具。
 */
export function filterToolsByOwningSkill(toolNames: string[]): string[] {
  return toolNames.filter((name) => {
    const owningSkill = SKILL_OWNED_TOOLS[name];
    if (!owningSkill) return true;
    return skillRegistry.get(owningSkill) !== undefined && skillRegistry.isEnabled(owningSkill);
  });
}

/**
 * 初始化 Skill 工具集成。
 */
export function initializeSkillIntegration(): void {
  registerLoadSkillTool();
}
