/**
 * Skill 模块类型定义。
 *
 * Skill 是 markdown 文件（YAML frontmatter + body），存放在用户或工作区
 * 的 .aurevoy/skills/ 目录下。激活后作为增强 system prompt 注入 Agent 上下文，
 * 并可选择性限制工具白名单。
 */

/** YAML frontmatter 中的元数据（从 markdown 文件解析出的原始结构）。 */
export interface SkillFrontmatter {
  name: string;
  description: string;
  'allowed-tools'?: string[];
  version?: string;
}

/** 从 markdown 文件解析出的完整 skill 定义。 */
export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  /** frontmatter 之后的 markdown body（即 skill 的实际指令内容）。 */
  body: string;
  /** 文件来源路径（用于诊断和 reload）。 */
  sourcePath: string;
  /** 来源目录类型（builtin 预装 / user 全局 / workspace 项目级）。 */
  sourceDir: 'builtin' | 'user' | 'workspace';
}

/** 暴露给前端的 skill 摘要（不包含 body，避免传输大量文本）。 */
export interface SkillDescriptor {
  name: string;
  description: string;
  allowedTools?: string[];
  version?: string;
  sourceDir: 'builtin' | 'user' | 'workspace';
}
