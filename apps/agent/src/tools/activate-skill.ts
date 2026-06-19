/**
 * activate_skill 工具（Agent Skills 标准）。
 *
 * 允许 LLM 在对话中激活或停用 skill。激活后：
 * - skill 的 body 通过 <skill_content> 结构化标签注入后续 LLM 调用
 * - 可选限制工具白名单（allowed-tools）
 * - 附属资源列表（scripts/、references/、assets/）一并返回
 *
 * 该工具始终可用（不受 skill 白名单限制），确保 LLM 总能退出当前 skill。
 * 当无可用 skill 时，不注册此工具（标准要求）。
 *
 * 注册必须在 skillRegistry.load() 之后调用。
 */

import { toolRegistry } from './registry.js';
import { skillRegistry } from '../skills/registry.js';
import { getLogger } from '../logging/logger.js';

export function registerActivateSkillTool(): void {
  const availableNames = skillRegistry.list();

  if (availableNames.length === 0) {
    return;
  }

  const catalogLines = skillRegistry.listAll().map((s) =>
    `- ${s.name}: ${s.description}`,
  ).join('\n');

  toolRegistry.register({
    descriptor: {
      name: 'activate_skill',
      description:
        '激活或停用技能（skill）。技能会通过 <skill_content> 标签注入专业指令并可选限制可用工具。\n' +
        '传入 name 参数激活指定技能，返回完整指令和附属资源列表；传入空字符串或不传 name 则停用当前技能。\n' +
        `可用技能：\n${catalogLines}`,
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '要激活的技能名称；留空或传 null 表示停用当前技能。',
            enum: [...availableNames, ''],
          },
        },
        required: [],
        additionalProperties: false,
      },
      riskLevel: 'safe',
      executionPolicy: { parallelizable: false },
    },

    async execute(args, context) {
      const log = getLogger('tools/activate-skill');
      const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : null;

      if (!name) {
        const previous = context?.task?.activeSkills?.[0];
        if (context?.task) {
          context.task.activeSkills = [];
        }
        log.info({ taskId: context?.taskId, previous }, 'skill 已停用');
        return {
          action: 'deactivated',
          previousSkill: previous ?? null,
          message: previous ? `已停用技能 "${previous}"，恢复全部工具。` : '当前没有激活的技能。',
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

      if (context?.task) {
        context.task.activeSkills = [name];
      }

      const allowedTools = entry.frontmatter['allowed-tools'];
      log.info({ taskId: context?.taskId, skill: name, allowedTools }, 'skill 已激活');

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
        action: 'activated',
        skill: name,
        description: entry.frontmatter.description,
        compatibility: entry.frontmatter.compatibility ?? null,
        allowedTools: allowedTools ?? null,
        content: wrappedContent,
        message: allowedTools
          ? `已激活技能 "${name}"。可用工具限制为：${allowedTools.join(', ')}。`
          : `已激活技能 "${name}"。所有工具仍可用。`,
      };
    },
  });
}
