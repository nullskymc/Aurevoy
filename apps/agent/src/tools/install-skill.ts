import { toolRegistry } from './registry.js';
import { installFromGit } from '../skills/installer.js';
import { reloadSkillsAndTools } from '../skills/reload.js';
import { config } from '../config.js';
import { resolve } from 'node:path';
import { getLogger } from '../logging/logger.js';

export function registerInstallSkillTool(): void {
  toolRegistry.register({
    descriptor: {
      name: 'install_skill',
      description:
        '安装已经人工/工具检查确认过的 Agent Skill。这是最终安装动作，不是搜索或探测工具。\n' +
        '调用前必须先读取用户给出的网页、GitHub 页面或仓库内容，确认其中确实存在 SKILL.md，并记录准确的 skill 目录路径。\n' +
        '不要把普通网页、README、文章页、搜索结果页或未检查的仓库 URL 直接传给本工具；不确定时应先用 web_search/web_fetch 或询问用户。\n' +
        '安装后 skill 立即生效，可通过 load_skill 工具加载。\n' +
        '示例：install_skill({ repoUrl: "https://github.com/user/skill-collection", skillPaths: ["skills/report-design"], inspectionSummary: "已检查仓库树，skills/report-design/SKILL.md 存在且 frontmatter 含 name/description。" })',
      inputSchema: {
        type: 'object',
        properties: {
          repoUrl: {
            type: 'string',
            description: '已确认的 Git 仓库地址（https/http/git@）。必须是仓库 URL，不是普通网页 URL。',
          },
          skillPaths: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: '调用前已经检查到的 skill 目录相对路径；可传 "path/to/skill" 或 "path/to/skill/SKILL.md"。根目录 skill 用 "."。',
          },
          inspectedSource: {
            type: 'string',
            description: '实际检查过的网页、仓库页面、README 或文件树 URL/路径。',
          },
          inspectionSummary: {
            type: 'string',
            description: '简要说明检查依据，例如检查到哪些 SKILL.md、frontmatter 是否包含 name/description、来源是否可信。',
          },
        },
        required: ['repoUrl', 'skillPaths', 'inspectionSummary'],
        additionalProperties: false,
      },
      riskLevel: 'caution',
      executionPolicy: { parallelizable: false },
    },

    async execute(args) {
      const log = getLogger('tools/install-skill');
      const repoUrl = typeof args.repoUrl === 'string' ? args.repoUrl.trim() : '';
      const skillPaths = Array.isArray(args.skillPaths)
        ? args.skillPaths.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
        : [];
      const inspectedSource = typeof args.inspectedSource === 'string' ? args.inspectedSource.trim() : undefined;
      const inspectionSummary = typeof args.inspectionSummary === 'string' ? args.inspectionSummary.trim() : '';

      if (!repoUrl) {
        return { error: 'repoUrl 不能为空' };
      }
      if (skillPaths.length === 0) {
        return { error: 'install_skill 需要先检查仓库内容，并提供至少一个已确认包含 SKILL.md 的 skillPaths' };
      }
      if (inspectionSummary.length < 20) {
        return { error: 'inspectionSummary 过短；请先读取网页/仓库内容并说明确认依据' };
      }

      log.info({ repoUrl, skillPaths, inspectedSource }, '通过工具安装已检查的 skill');

      const targetDir = resolve(config.skills.userDir);
      const result = await installFromGit(repoUrl, targetDir, {
        expectedSkillPaths: skillPaths,
        inspectedSource,
        inspectionSummary,
        requireExpectedPaths: true,
      });

      reloadSkillsAndTools();

      const action = result.alreadyExisted.length > 0
        ? `已安装 ${result.installedSkills.length} 个技能（其中 ${result.alreadyExisted.length} 个为覆盖更新）`
        : `已安装 ${result.installedSkills.length} 个技能`;

      return {
        action: 'installed',
        installedSkills: result.installedSkills,
        alreadyExisted: result.alreadyExisted,
        totalFound: result.totalFound,
        inspectedSkillPaths: result.inspectedSkillPaths,
        repoUrl,
        inspectedSource,
        inspectionSummary,
        message: `${action}：${result.installedSkills.join(', ')}。可通过 /${result.installedSkills[0]} 激活。`,
      };
    },
  });
}
