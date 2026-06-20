import { skillRegistry } from './registry.js';
import { toolRegistry } from '../tools/registry.js';
import { registerActivateSkillTool } from '../tools/activate-skill.js';
import { registerInstallSkillTool } from '../tools/install-skill.js';

/**
 * 重新加载 skill 目录并刷新 activate_skill / install_skill 工具注册。
 * 安装或卸载 skill 后调用，确保工具枚举和 skill catalog 同步。
 */
export function reloadSkillsAndTools(): void {
  skillRegistry.reload();
  toolRegistry.unregister('activate_skill');
  registerActivateSkillTool();
  toolRegistry.unregister('install_skill');
  registerInstallSkillTool();
}
