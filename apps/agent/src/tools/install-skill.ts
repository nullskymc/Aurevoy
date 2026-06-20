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
        '从 Git 仓库 URL 安装技能（skill）。仓库中应包含 skill 子目录（每个子目录含 SKILL.md 文件）。\n' +
        '安装后 skill 立即生效，可通过 activate_skill 工具或直接 /skillname 斜杠命令激活。\n' +
        '示例：install_skill({ repoUrl: "https://github.com/user/skill-collection" })',
      inputSchema: {
        type: 'object',
        properties: {
          repoUrl: {
            type: 'string',
            description: 'Git 仓库地址（https/http/git@），仓库中需包含 skill 子目录。',
          },
        },
        required: ['repoUrl'],
        additionalProperties: false,
      },
      riskLevel: 'caution',
      executionPolicy: { parallelizable: false },
    },

    async execute(args) {
      const log = getLogger('tools/install-skill');
      const repoUrl = typeof args.repoUrl === 'string' ? args.repoUrl.trim() : '';

      if (!repoUrl) {
        return { error: 'repoUrl 不能为空' };
      }

      log.info({ repoUrl }, '通过工具安装 skill');

      const targetDir = resolve(config.skills.userDir);
      const result = await installFromGit(repoUrl, targetDir);

      reloadSkillsAndTools();

      const action = result.alreadyExisted.length > 0
        ? `已安装 ${result.installedSkills.length} 个技能（其中 ${result.alreadyExisted.length} 个为覆盖更新）`
        : `已安装 ${result.installedSkills.length} 个技能`;

      return {
        action: 'installed',
        installedSkills: result.installedSkills,
        alreadyExisted: result.alreadyExisted,
        totalFound: result.totalFound,
        repoUrl,
        message: `${action}：${result.installedSkills.join(', ')}。可通过 /${result.installedSkills[0]} 激活。`,
      };
    },
  });
}
