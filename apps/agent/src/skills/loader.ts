/**
 * Skill 文件加载器（Agent Skills 标准格式）。
 *
 * 支持两种发现格式：
 * 1. 标准格式：目录包含 SKILL.md（优先）
 * 2. 旧格式：flat .md 文件（向后兼容，已弃用）
 *
 * 启动时仅解析 frontmatter（Tier 1），body 在激活时懒加载（Tier 2）。
 * 解析失败的文件记录警告但不阻塞其他 skill 的加载。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { SkillCatalogEntry, SkillContent, SkillResource, SkillFrontmatter } from './types.js';
import { readInstallMetadata } from './installer.js';
import { getLogger } from '../logging/logger.js';

const BODY_CHAR_CAP = 8000;

/**
 * 扫描 skill 目录，发现所有 SKILL.md（标准格式）和 flat .md 文件（兼容旧格式）。
 * 标准格式优先：同名 skill 若同时存在目录和 flat 文件，优先取目录格式。
 */
export function discoverSkills(
  dir: string,
  sourceDir: 'builtin' | 'user' | 'workspace' | 'system',
): SkillCatalogEntry[] {
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

  const catalog: SkillCatalogEntry[] = [];
  const namesFromDirs = new Set<string>();

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      const skillMdPath = join(fullPath, 'SKILL.md');
      if (existsSync(skillMdPath)) {
        const fm = parseFrontmatterFromFile(skillMdPath);
        if (!fm) continue;

        const dirName = entry;
        if (fm.name !== dirName) {
          log.warn(
            { path: skillMdPath, frontmatterName: fm.name, dirName },
            'skill name 与目录名不一致（标准要求 name 匹配父目录名），仍加载但建议修正',
          );
        }

        if (namesFromDirs.has(fm.name)) {
          log.warn({ name: fm.name, dir }, '同名 skill 目录重复，取后发现的');
        }
        namesFromDirs.add(fm.name);

        const installMeta = readInstallMetadata(fullPath);
        catalog.push({
          frontmatter: fm,
          location: skillMdPath,
          skillDir: fullPath,
          sourceDir,
          installUrl: installMeta?.repoUrl,
          installedAt: installMeta?.installedAt,
        });
      }
    } else if (extname(entry).toLowerCase() === '.md' && entry !== 'SKILL.md') {
      const fm = parseFrontmatterFromFile(fullPath);
      if (!fm) continue;

      if (namesFromDirs.has(fm.name)) {
        log.debug(
          { name: fm.name, flatFile: fullPath },
          'flat .md 文件与标准目录格式同名，优先取目录格式，跳过 flat 文件',
        );
        continue;
      }

      const skillDir = dir;
      catalog.push({
        frontmatter: fm,
        location: fullPath,
        skillDir,
        sourceDir,
      });
    }
  }

  return catalog;
}

/**
 * 从 SKILL.md 文件中解析 frontmatter（Tier 1）。
 * 仅读取并解析 YAML frontmatter，不加载 body。
 */
function parseFrontmatterFromFile(filePath: string): SkillFrontmatter | null {
  const log = getLogger('skills/loader');

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    log.warn({ path: filePath, err }, '无法读取 skill 文件');
    return null;
  }

  const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!frontmatterMatch) {
    log.warn({ path: filePath }, 'skill 文件缺少 YAML frontmatter（--- 分隔符）');
    return null;
  }

  const yamlBlock = frontmatterMatch[1];
  const parsed = parseYamlFrontmatter(yamlBlock);
  if (!parsed) return null;

  const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
  if (!name) {
    log.warn({ path: filePath }, 'skill 文件缺少 name 字段');
    return null;
  }

  const description = typeof parsed.description === 'string' ? parsed.description.trim() : '';
  if (!description) {
    log.warn({ path: filePath }, 'skill 文件缺少 description 字段，跳过');
    return null;
  }

  if (name.length > 64) {
    log.warn({ path: filePath, name }, 'skill name 超过 64 字符限制，仍加载但建议缩短');
  }

  const allowedTools = parseAllowedTools(parsed['allowed-tools']);

  const metadata = typeof parsed.metadata === 'object' && parsed.metadata !== null
    ? parseMetadataRecord(parsed.metadata as Record<string, unknown>)
    : undefined;

  // 旧版 version 字段迁移到 metadata.version
  if (typeof parsed.version === 'string' && !metadata?.version) {
    (metadata ?? ({} as Record<string, string>)).version = parsed.version.trim();
  }

  return {
    name,
    description,
    'allowed-tools': allowedTools,
    license: typeof parsed.license === 'string' ? parsed.license.trim() : undefined,
    compatibility: typeof parsed.compatibility === 'string' ? parsed.compatibility.trim() : undefined,
    metadata: metadata && Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

/**
 * 激活时加载 skill 的完整内容（Tier 2）。
 * 读取 SKILL.md 的 body 并枚举附属资源目录。
 */
export function loadSkillContent(entry: SkillCatalogEntry): SkillContent | null {
  const log = getLogger('skills/loader');

  let raw: string;
  try {
    raw = readFileSync(entry.location, 'utf-8');
  } catch (err) {
    log.warn({ path: entry.location, err }, '无法读取 skill 文件内容');
    return null;
  }

  const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!frontmatterMatch) {
    log.warn({ path: entry.location }, '激活时解析 frontmatter 失败');
    return null;
  }

  let body = raw.slice(frontmatterMatch[0].length).trim();
  if (body.length > BODY_CHAR_CAP) {
    body = body.slice(0, BODY_CHAR_CAP) + `\n\n[技能内容已截断，原文 ${body.length} 字符]`;
  }

  const resources = enumerateResources(entry.skillDir);

  return { body, resources };
}

/**
 * 枚举 skill 目录中的 scripts/、references/、assets/ 子目录资源。
 * 不深度遍历，只列出一层文件。
 */
function enumerateResources(skillDir: string): SkillResource[] {
  const resources: SkillResource[] = [];
  const subdirs: { name: string; type: SkillResource['type'] }[] = [
    { name: 'scripts', type: 'script' },
    { name: 'references', type: 'reference' },
    { name: 'assets', type: 'asset' },
  ];

  for (const { name, type } of subdirs) {
    const subdirPath = join(skillDir, name);
    if (!existsSync(subdirPath)) continue;
    try {
      const files = readdirSync(subdirPath);
      for (const file of files) {
        const filePath = join(subdirPath, file);
        try {
          if (!statSync(filePath).isFile()) continue;
        } catch {
          continue;
        }
        resources.push({
          type,
          relativePath: `${name}/${file}`,
          absolutePath: filePath,
        });
      }
    } catch {
      continue;
    }
  }

  return resources;
}

// ---- 内联 YAML 解析（不引入外部依赖） ----

function parseYamlFrontmatter(yaml: string): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};

  const lines = yaml.split('\n');
  let currentKey: string | null = null;
  let currentArray: string[] = [];
  let inMap = false;
  let mapKey: string | null = null;
  let mapEntries: Record<string, string> = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // 嵌套 map 值（metadata: 下属的 key: value 行）
    if (inMap) {
      if (line.startsWith('- ') || !line.includes(':')) {
        inMap = false;
        if (mapKey && Object.keys(mapEntries).length > 0) {
          result[mapKey] = { ...mapEntries };
        }
        mapKey = null;
        mapEntries = {};
      } else {
        const kvMatch = line.match(/^([a-zA-Z_-][a-zA-Z0-9_-]*)\s*:\s*(.*)/);
        if (kvMatch) {
          const value = kvMatch[2].trim();
          const unquoted = value.replace(/^['"](.*)['"]$/, '$1');
          mapEntries[kvMatch[1]] = unquoted;
        }
        continue;
      }
    }

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
        // 可能是数组起始或嵌套 map
        const nextLines = lines.slice(lines.indexOf(rawLine) + 1);
        const firstNonEmpty = nextLines.find((l) => l.trim() && !l.trim().startsWith('#'));
        if (firstNonEmpty && !firstNonEmpty.trim().startsWith('- ') && firstNonEmpty.trim().includes(':')) {
          // 嵌套 map
          inMap = true;
          mapKey = currentKey;
          mapEntries = {};
          currentKey = null;
        } else {
          // 数组起始
          currentArray = [];
        }
        continue;
      }

      const unquoted = value.replace(/^['"](.*)['"]$/, '$1');
      result[currentKey] = unquoted;
      currentKey = null;
    }
  }

  // 提交最后的数组
  if (currentKey && currentArray.length > 0) {
    result[currentKey] = [...currentArray];
  }

  // 提交最后的 map
  if (inMap && mapKey && Object.keys(mapEntries).length > 0) {
    result[mapKey] = { ...mapEntries };
  }

  return result;
}

/**
 * 解析 allowed-tools 字段。
 * 支持两种格式：
 * - 标准（空格分隔字符串）："Bash(git:*) Bash(jq:*) Read" → ["Bash(git:*)", "Bash(jq:*)", "Read"]
 * - 旧版（YAML 数组）：[web_search, web_fetch] → ["web_search", "web_fetch"]
 * - 旧版（逗号分隔字符串）："web_search, web_fetch" → ["web_search", "web_fetch"]
 */
function parseAllowedTools(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const tools = value.map((v) => String(v).trim()).filter(Boolean);
    return tools.length > 0 ? tools : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    // 空格分隔（标准格式）：不含逗号且含空格时按空格拆分
    if (!trimmed.includes(',') && trimmed.includes(' ')) {
      const tools = trimmed.split(/\s+/).filter(Boolean);
      return tools.length > 0 ? tools : undefined;
    }
    // 逗号分隔（兼容旧版）
    const tools = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
    return tools.length > 0 ? tools : undefined;
  }
  return undefined;
}

function parseMetadataRecord(value: Record<string, unknown>): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') {
      result[k] = v;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
