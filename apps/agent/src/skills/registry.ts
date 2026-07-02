/**
 * Skill 注册表（Agent Skills 标准格式）。
 *
 * 启动时仅从配置目录发现 skill 并加载 frontmatter（Tier 1 catalog）。
 * 激活时懒加载 SKILL.md body + 附属资源（Tier 2）。
 *
 * 工作区 skill 优先级高于全局 skill（同名时工作区覆盖）。
 * 支持 .aurevoy/skills/（用户）、.agents/skills/、.claude/skills/ 和 .codex/skills/（系统）四个发现路径。
 */

import type { SkillCatalogEntry, SkillContent } from './types.js';
import type { SkillDescriptor } from '@aurevoy/shared';
import { discoverSkills, loadSkillContent } from './loader.js';
import { config } from '../config.js';
import { getLogger } from '../logging/logger.js';
import { resolve } from 'node:path';
import { skillSettingsStore } from '../store/db.js';

class SkillRegistry {
  private catalog = new Map<string, SkillCatalogEntry>();

  /**
   * 从配置的目录发现所有 skill（Tier 1：仅加载 name + description）。
   * 加载顺序：预装 → 用户(.aurevoy) → 系统(.agents + .claude + .codex) → 工作区(.aurevoy) → 工作区系统(.agents + .claude + .codex)（后加载的覆盖同名）。
   */
  load(): void {
    const log = getLogger('skills/registry');
    this.catalog.clear();

    const builtinDir = resolve(config.skills.builtinDir);

    // .aurevoy — 用户个人 skill
    const userDirs = [
      resolve(config.skills.userDir),
    ];

    // .agents / .claude / .codex — 来自其他客户端的系统级 skill
    const systemDirs = [
      resolve(config.skills.agentsUserDir),
      resolve(config.skills.claudeUserDir),
      resolve(config.skills.codexUserDir),
    ];

    // 工作区 .aurevoy — 项目级用户 skill
    const workspaceDirs = [
      resolve(config.workspaceDir, config.skills.workspaceSubDir),
    ];

    // 工作区 .agents / .claude / .codex — 项目级系统 skill
    const workspaceSystemDirs = [
      resolve(config.workspaceDir, config.skills.agentsWorkspaceSubDir),
      resolve(config.workspaceDir, config.skills.claudeWorkspaceSubDir),
      resolve(config.workspaceDir, config.skills.codexWorkspaceSubDir),
    ];

    log.info({ builtinDir, userDirs, systemDirs, workspaceDirs, workspaceSystemDirs }, '发现 skill 文件...');

    // 1) 预装 skill（最低优先级）
    const builtinSkills = discoverSkills(builtinDir, 'builtin');
    for (const skill of builtinSkills) {
      this.catalog.set(skill.frontmatter.name, skill);
    }

    // 2) 用户全局 skill（.aurevoy，覆盖预装同名）
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

    // 3) 系统级全局 skill（.agents / .claude / .codex，覆盖用户同名）
    for (const dir of systemDirs) {
      const skills = discoverSkills(dir, 'system');
      for (const skill of skills) {
        const existing = this.catalog.get(skill.frontmatter.name);
        if (existing) {
          log.info(
            { name: skill.frontmatter.name, source: skill.location, overridden: existing.location },
            '系统 skill 覆盖已有 skill',
          );
        }
        this.catalog.set(skill.frontmatter.name, skill);
      }
    }

    // 4) 工作区 skill（.aurevoy，覆盖系统全局同名）
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

    // 5) 工作区系统 skill（最高优先级）
    for (const dir of workspaceSystemDirs) {
      const skills = discoverSkills(dir, 'system');
      for (const skill of skills) {
        const existing = this.catalog.get(skill.frontmatter.name);
        if (existing) {
          log.info(
            { name: skill.frontmatter.name, source: skill.location, overridden: existing.location },
            '工作区系统 skill 覆盖已有 skill',
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
      .map((s) => {
        const stored = skillSettingsStore.isEnabled(s.frontmatter.name);
        const sourcePath = deriveSourcePath(s.location || s.skillDir);
        return {
          name: s.frontmatter.name,
          description: s.frontmatter.description,
          allowedTools: s.frontmatter['allowed-tools'],
          license: s.frontmatter.license,
          compatibility: s.frontmatter.compatibility,
          metadata: s.frontmatter.metadata,
          sourceDir: s.sourceDir,
          sourcePath,
          location: s.location,
          installUrl: s.installUrl,
          installedAt: s.installedAt,
          // 未显式设置的：builtin 预装 + .aurevoy + system 默认启用，其他默认禁用
          enabled: stored !== null ? stored : sourcePath === '.aurevoy' || s.sourceDir === 'builtin' || s.sourceDir === 'system',
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 判断 skill 是否启用。未设置的 skill 根据来源目录决定默认值。 */
  isEnabled(name: string): boolean {
    const stored = skillSettingsStore.isEnabled(name);
    if (stored !== null) return stored;
    const entry = this.catalog.get(name);
    if (!entry) return false;
    const sourcePath = deriveSourcePath(entry.location || entry.skillDir);
    return sourcePath === '.aurevoy' || entry.sourceDir === 'builtin' || entry.sourceDir === 'system';
  }

}

export const skillRegistry = new SkillRegistry();

/** 从 skill 的路径中提取来源目录名（.aurevoy / .claude / .agents / .codex / builtin）。 */
function deriveSourcePath(path: string): string {
  const known = ['.aurevoy', '.claude', '.agents', '.codex'];
  for (const dir of known) {
    if (path.includes(`/${dir}/`)) return dir;
  }
  if (path.includes('/builtin/')) return 'builtin';
  // 工作区 skill 可能通过 workspaceSubDir 发现，尝试匹配
  if (path.includes('/workspace/')) return 'workspace';
  return 'other';
}
