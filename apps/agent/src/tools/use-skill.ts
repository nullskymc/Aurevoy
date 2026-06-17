/**
 * use_skill 工具。
 *
 * 允许 LLM 在对话中激活或停用 skill。激活后：
 * - skill 的 body 作为 system message 注入后续 LLM 调用
 * - 可选限制工具白名单（allowed-tools）
 *
 * 该工具始终可用（不受 skill 白名单限制），确保 LLM 总能退出当前 skill。
 */

import { toolRegistry } from './registry.js';
import { skillRegistry } from '../skills/registry.js';
import { getLogger } from '../logging/logger.js';

toolRegistry.register({
  descriptor: {
    name: 'use_skill',
    description:
      '激活或停用技能（skill）。技能会改变 Agent 的行为模式、注入专业指令并可选限制可用工具。' +
      '传入 name 参数激活指定技能；传入空字符串或不传 name 则停用当前技能。' +
      `可用技能列表：${skillRegistry.list().join(', ') || '(无)'}`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '要激活的技能名称；留空或传 null 表示停用当前技能。',
        },
      },
      required: [],
      additionalProperties: false,
    },
    riskLevel: 'safe',
    executionPolicy: { parallelizable: false },
  },

  async execute(args, context) {
    const log = getLogger('tools/use-skill');
    const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : null;

    // 停用 skill
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

    // 激活 skill
    const skill = skillRegistry.get(name);
    if (!skill) {
      const available = skillRegistry.list().join(', ') || '(无)';
      return {
        error: `未知技能 "${name}"。可用技能：${available}`,
        availableSkills: skillRegistry.list(),
      };
    }

    if (context?.task) {
      context.task.activeSkills = [name];
    }

    const allowedTools = skill.frontmatter['allowed-tools'];
    log.info({ taskId: context?.taskId, skill: name, allowedTools }, 'skill 已激活');

    return {
      action: 'activated',
      skill: name,
      description: skill.frontmatter.description,
      allowedTools: allowedTools ?? null,
      message: allowedTools
        ? `已激活技能 "${name}"。可用工具限制为：${allowedTools.join(', ')}。`
        : `已激活技能 "${name}"。所有工具仍可用。`,
    };
  },
});
