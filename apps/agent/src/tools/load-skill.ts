/**
 * load_skill 工具（Agent Skills 标准）。
 *
 * 允许 LLM 在对话中一次性加载 skill 到上下文。调用后返回 skill 的完整
 * 操作指南和附属资源列表，内容通过工具结果进入对话历史。
 *
 * 该工具始终可用（不受 skill 白名单限制）。
 * 只有当可用 skill 数 > 0 时才注册此工具。
 *
 * 注册必须在 skillRegistry.load() 之后调用。
 */

import { toolRegistry } from './registry.js';
import { skillRegistry } from '../skills/registry.js';
import { getLogger } from '../logging/logger.js';

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

  toolRegistry.register({
    descriptor: {
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
    },

    async execute(args, context) {
      const log = getLogger('tools/load-skill');
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

      log.info({ taskId: context?.taskId, skill: name }, 'skill 已加载');

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
  });
}
