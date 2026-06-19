/**
 * Skill 模块类型定义（Agent Skills 标准格式）。
 *
 * Skill 是一个目录，包含 SKILL.md 文件（YAML frontmatter + markdown body），
 * 可选附带 scripts/、references/、assets/ 子目录。
 *
 * 激活后通过 <skill_content> 结构化标签注入 Agent 上下文，
 * 并可选限制工具白名单（allowed-tools）。
 *
 * 三级渐进披露（progressive disclosure）：
 * - Tier 1 (catalog): name + description（启动时加载）
 * - Tier 2 (instructions): SKILL.md body（激活时加载）
 * - Tier 3 (resources): scripts/references/assets（按需加载）
 */

/** YAML frontmatter 中的元数据（Agent Skills 标准）。 */
export interface SkillFrontmatter {
  /** 必需。1-64 字符，小写字母/数字/连字符，须匹配父目录名。 */
  name: string;
  /** 必需。1-1024 字符，描述 skill 功能及何时使用。 */
  description: string;
  /** 可选。工具白名单，空格分隔字符串（标准格式）或数组（兼容旧格式）。 */
  'allowed-tools'?: string[];
  /** 可选。许可证名称或引用。 */
  license?: string;
  /** 可选。1-500 字符，环境需求描述。 */
  compatibility?: string;
  /** 可选。任意键值映射，存放非标准字段（如 version、author 等）。 */
  metadata?: Record<string, string>;
}

/** 目录扫描阶段产出的 catalog 条目（不含 body，启动时仅加载元数据）。 */
export interface SkillCatalogEntry {
  frontmatter: SkillFrontmatter;
  /** SKILL.md 文件的绝对路径。 */
  location: string;
  /** skill 目录根的绝对路径（用于解析 scripts/references/assets 的相对路径）。 */
  skillDir: string;
  /** 来源目录类型（builtin 预装 / user 全局 / workspace 项目级）。 */
  sourceDir: 'builtin' | 'user' | 'workspace';
}

/** 激活时加载的 skill 内容（Tier 2）。 */
export interface SkillContent {
  /** SKILL.md frontmatter 之后的 markdown body。 */
  body: string;
  /** skill 目录中发现的附属资源列表（scripts/、references/、assets/）。 */
  resources: SkillResource[];
}

/** skill 目录中的附属资源条目。 */
export interface SkillResource {
  type: 'script' | 'reference' | 'asset' | 'other';
  relativePath: string;
  absolutePath: string;
}

/** 兼容旧版 flat .md 文件的完整解析结果（向后兼容）。 */
export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
  sourcePath: string;
  sourceDir: 'builtin' | 'user' | 'workspace';
}
