/**
 * Skill 注册表。
 *
 * 启动时从配置的目录加载所有 skill 文件，缓存在内存中。
 * 提供按名称查询、列表、工具白名单获取等能力。
 *
 * 工作区 skill 优先级高于全局 skill（同名时工作区覆盖）。
 */

import type { ParsedSkill, SkillDescriptor } from './types.js';
import { parseSkillDirectory } from './loader.js';
import { config } from '../config.js';
import { getLogger } from '../logging/logger.js';
import { resolve } from 'node:path';

class SkillRegistry {
  private skills = new Map<string, ParsedSkill>();

  /**
   * 从配置的目录加载所有 skill。
   * 加载顺序：预装 → 用户 → 工作区（后加载的覆盖同名）。
   */
  load(): void {
    const log = getLogger('skills/registry');
    this.skills.clear();

    const builtinDir = resolve(config.skills.builtinDir);
    const globalDir = resolve(config.skills.userDir);
    const workspaceDir = resolve(config.workspaceDir, config.skills.workspaceSubDir);

    log.info({ builtinDir, globalDir, workspaceDir }, '加载 skill 文件...');

    // 1) 预装 skill（最低优先级）
    const builtinSkills = parseSkillDirectory(builtinDir, 'builtin');
    for (const skill of builtinSkills) {
      this.skills.set(skill.frontmatter.name, skill);
    }

    // 2) 用户全局 skill（覆盖预装同名）
    const globalSkills = parseSkillDirectory(globalDir, 'user');
    for (const skill of globalSkills) {
      const existing = this.skills.get(skill.frontmatter.name);
      if (existing) {
        log.info(
          { name: skill.frontmatter.name, source: skill.sourcePath, overridden: existing.sourcePath },
          '用户 skill 覆盖预装 skill',
        );
      }
      this.skills.set(skill.frontmatter.name, skill);
    }

    // 3) 工作区 skill（最高优先级）
    const workspaceSkills = parseSkillDirectory(workspaceDir, 'workspace');
    for (const skill of workspaceSkills) {
      const existing = this.skills.get(skill.frontmatter.name);
      if (existing) {
        log.info(
          { name: skill.frontmatter.name, source: skill.sourcePath, overridden: existing.sourcePath },
          '工作区 skill 覆盖已有 skill',
        );
      }
      this.skills.set(skill.frontmatter.name, skill);
    }

    log.info({ count: this.skills.size }, 'skill 加载完成');
  }

  /** 重新加载所有 skill（开发期热更新）。 */
  reload(): void {
    this.load();
  }

  /** 获取单个 skill 的完整定义。 */
  get(name: string): ParsedSkill | undefined {
    return this.skills.get(name);
  }

  /** 列出所有已加载 skill 的名称。 */
  list(): string[] {
    return [...this.skills.keys()].sort();
  }

  /** 列出所有 skill 的摘要信息（供前端 API 使用）。 */
  listAll(): SkillDescriptor[] {
    return [...this.skills.values()]
      .map((s) => ({
        name: s.frontmatter.name,
        description: s.frontmatter.description,
        allowedTools: s.frontmatter['allowed-tools'],
        version: s.frontmatter.version,
        sourceDir: s.sourceDir,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 获取 skill 指定的工具白名单；未声明则返回 undefined（不限工具）。 */
  getAllowedTools(name: string): string[] | undefined {
    const skill = this.skills.get(name);
    return skill?.frontmatter['allowed-tools'];
  }
}

export const skillRegistry = new SkillRegistry();
