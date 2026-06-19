/**
 * Skill 注册表（Agent Skills 标准格式）。
 *
 * 启动时仅从配置目录发现 skill 并加载 frontmatter（Tier 1 catalog）。
 * 激活时懒加载 SKILL.md body + 附属资源（Tier 2）。
 *
 * 工作区 skill 优先级高于全局 skill（同名时工作区覆盖）。
 * 支持 .aurevoy/skills/ 和 .agents/skills/ 两个发现路径。
 */

import type { SkillCatalogEntry, SkillContent } from './types.js';
import type { SkillDescriptor } from '@aurevoy/shared';
import { discoverSkills, loadSkillContent } from './loader.js';
import { config } from '../config.js';
import { getLogger } from '../logging/logger.js';
import { resolve } from 'node:path';

class SkillRegistry {
  private catalog = new Map<string, SkillCatalogEntry>();

  /**
   * 从配置的目录发现所有 skill（Tier 1：仅加载 name + description）。
   * 加载顺序：预装 → 用户(.aurevoy + .agents) → 工作区(.aurevoy + .agents)（后加载的覆盖同名）。
   */
  load(): void {
    const log = getLogger('skills/registry');
    this.catalog.clear();

    const builtinDir = resolve(config.skills.builtinDir);

    const userDirs = [
      resolve(config.skills.userDir),
      resolve(config.skills.agentsUserDir),
    ];

    const workspaceDirs = [
      resolve(config.workspaceDir, config.skills.workspaceSubDir),
      resolve(config.workspaceDir, config.skills.agentsWorkspaceSubDir),
    ];

    log.info({ builtinDir, userDirs, workspaceDirs }, '发现 skill 文件...');

    // 1) 预装 skill（最低优先级）
    const builtinSkills = discoverSkills(builtinDir, 'builtin');
    for (const skill of builtinSkills) {
      this.catalog.set(skill.frontmatter.name, skill);
    }

    // 2) 用户全局 skill（覆盖预装同名）
    for (const dir of userDirs) {
      const skills = discoverSkills(dir, 'user');
      for (const skill of skills) {
        const existing = this.catalog.get(skill.frontmatter.name);
        if (existing) {
          log.info(
            { name: skill.frontmatter.name, source: skill.location, overridden: existing.location },
            '用户 skill 覆盖已有 skill',
          );
        }
        this.catalog.set(skill.frontmatter.name, skill);
      }
    }

    // 3) 工作区 skill（最高优先级）
    for (const dir of workspaceDirs) {
      const skills = discoverSkills(dir, 'workspace');
      for (const skill of skills) {
        const existing = this.catalog.get(skill.frontmatter.name);
        if (existing) {
          log.info(
            { name: skill.frontmatter.name, source: skill.location, overridden: existing.location },
            '工作区 skill 覆盖已有 skill',
          );
        }
        this.catalog.set(skill.frontmatter.name, skill);
      }
    }

    log.info({ count: this.catalog.size }, 'skill 发现完成');
  }

  /** 重新发现所有 skill（开发期热更新）。 */
  reload(): void {
    this.load();
  }

  /** 获取单个 skill 的 catalog 条目（Tier 1 元数据）。 */
  get(name: string): SkillCatalogEntry | undefined {
    return this.catalog.get(name);
  }

  /** 激活时加载 skill 的完整内容（Tier 2：body + resources）。 */
  getContent(name: string): SkillContent | null {
    const entry = this.catalog.get(name);
    if (!entry) return null;
    return loadSkillContent(entry);
  }

  /** 列出所有已发现 skill 的名称。 */
  list(): string[] {
    return [...this.catalog.keys()].sort();
  }

  /** 列出所有 skill 的摘要信息（供前端 API + 模型 catalog 使用）。 */
  listAll(): SkillDescriptor[] {
    return [...this.catalog.values()]
      .map((s) => ({
        name: s.frontmatter.name,
        description: s.frontmatter.description,
        allowedTools: s.frontmatter['allowed-tools'],
        license: s.frontmatter.license,
        compatibility: s.frontmatter.compatibility,
        metadata: s.frontmatter.metadata,
        sourceDir: s.sourceDir,
        location: s.location,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 获取 skill 指定的工具白名单；未声明则返回 undefined（不限工具）。 */
  getAllowedTools(name: string): string[] | undefined {
    const skill = this.catalog.get(name);
    return skill?.frontmatter['allowed-tools'];
  }
}

export const skillRegistry = new SkillRegistry();
