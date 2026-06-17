/**
 * Skill 文件加载器。
 *
 * 负责扫描目录、解析 markdown 文件的 YAML frontmatter + body。
 * 解析失败的文件记录警告日志但不阻塞其他 skill 的加载。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { ParsedSkill } from './types.js';
import { getLogger } from '../logging/logger.js';

const BODY_CHAR_CAP = 4000;

/**
 * 解析单个 skill markdown 文件。
 * 格式：
 * ```
 * ---
 * name: my-skill
 * description: 简短描述
 * allowed-tools: [tool_a, tool_b]
 * ---
 *
 * # Skill 标题
 * 这里是 skill 的指令内容……
 * ```
 */
export function parseSkillFile(
  filePath: string,
  sourceDir: 'builtin' | 'user' | 'workspace',
): ParsedSkill | null {
  const log = getLogger('skills/loader');

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    log.warn({ path: filePath, err }, '无法读取 skill 文件');
    return null;
  }

  // 解析 YAML frontmatter（--- 分隔符）
  const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!frontmatterMatch) {
    log.warn({ path: filePath }, 'skill 文件缺少 YAML frontmatter（--- 分隔符）');
    return null;
  }

  const yamlBlock = frontmatterMatch[1];
  const body = raw.slice(frontmatterMatch[0].length).trim();

  const frontmatter = parseYamlFrontmatter(yamlBlock);
  if (!frontmatter) return null;

  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  if (!name) {
    log.warn({ path: filePath }, 'skill 文件缺少 name 字段');
    return null;
  }

  // 截断过长的 body
  let finalBody = body;
  if (finalBody.length > BODY_CHAR_CAP) {
    finalBody = finalBody.slice(0, BODY_CHAR_CAP) + `\n\n[技能内容已截断，原文 ${body.length} 字符]`;
  }

  return {
    frontmatter: {
      name,
      description: typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '',
      'allowed-tools': parseAllowedTools(frontmatter['allowed-tools']),
      version: typeof frontmatter.version === 'string' ? frontmatter.version.trim() : undefined,
    },
    body: finalBody,
    sourcePath: filePath,
    sourceDir,
  };
}

/**
 * 扫描目录中的所有 .md 文件并解析为 skill。
 */
export function parseSkillDirectory(
  dir: string,
  sourceDir: 'builtin' | 'user' | 'workspace',
): ParsedSkill[] {
  const log = getLogger('skills/loader');

  if (!existsSync(dir)) {
    log.debug({ dir }, 'skill 目录不存在，跳过');
    return [];
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    log.warn({ dir, err }, '无法读取 skill 目录');
    return [];
  }

  const skills: ParsedSkill[] = [];
  for (const entry of entries) {
    if (extname(entry).toLowerCase() !== '.md') continue;
    const fullPath = join(dir, entry);
    const skill = parseSkillFile(fullPath, sourceDir);
    if (skill) skills.push(skill);
  }

  return skills;
}

// ---- 内联 YAML 解析（不引入外部依赖） ----

function parseYamlFrontmatter(yaml: string): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};

  const lines = yaml.split('\n');
  let currentKey: string | null = null;
  let currentArray: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // 数组元素（缩进 + - value）
    const arrayMatch = line.match(/^\s*-\s+(.+)/);
    if (arrayMatch && currentKey) {
      currentArray.push(arrayMatch[1].trim());
      continue;
    }

    // 提交当前数组
    if (currentKey && currentArray.length > 0) {
      result[currentKey] = [...currentArray];
      currentArray = [];
      currentKey = null;
    }

    // key: value
    const kvMatch = line.match(/^([a-zA-Z_-][a-zA-Z0-9_-]*)\s*:\s*(.*)/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const value = kvMatch[2].trim();

      if (value === '') {
        // 可能是数组起始
        currentArray = [];
        continue;
      }

      // 去掉引号
      const unquoted = value.replace(/^['"](.*)['"]$/, '$1');
      result[currentKey] = unquoted;
      currentKey = null;
    }
  }

  // 提交最后的数组
  if (currentKey && currentArray.length > 0) {
    result[currentKey] = [...currentArray];
  }

  return result;
}

function parseAllowedTools(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const tools = value.map((v) => String(v).trim()).filter(Boolean);
    return tools.length > 0 ? tools : undefined;
  }
  if (typeof value === 'string') {
    const tools = value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return tools.length > 0 ? tools : undefined;
  }
  return undefined;
}
