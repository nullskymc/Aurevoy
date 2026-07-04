import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, rmSync, cpSync, mkdtempSync } from 'node:fs';
import { basename, join, relative, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { getLogger } from '../logging/logger.js';

export interface InstallResult {
  installedSkills: string[];
  alreadyExisted: string[];
  totalFound: number;
  inspectedSkillPaths: string[];
}

export interface InstallMetadata {
  repoUrl: string;
  installedAt: string;
  inspectedSource?: string;
  inspectionSummary?: string;
}

export interface InstallFromGitOptions {
  /** 调用方已经检查确认的 skill 目录路径或 SKILL.md 路径。传入后只安装这些路径。 */
  expectedSkillPaths?: string[];
  /** 实际检查过的网页/仓库/README 来源，写入安装元数据。 */
  inspectedSource?: string;
  /** 调用方检查依据摘要，写入安装元数据。 */
  inspectionSummary?: string;
  /** Agent 工具路径使用：要求必须提供 expectedSkillPaths，避免未检查直接安装。 */
  requireExpectedPaths?: boolean;
}

const INSTALL_META_FILE = '.install.json';

export function validateRepoUrl(url: string): { valid: boolean; error?: string } {
  const trimmed = url.trim();
  if (!trimmed) return { valid: false, error: '仓库地址不能为空' };

  if (trimmed.startsWith('git@')) return { valid: true };

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { valid: false, error: `不支持的协议: ${parsed.protocol}，仅支持 https/http/git@` };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: '无效的仓库地址' };
  }
}

export async function installFromGit(
  repoUrl: string,
  targetDir: string,
  options: InstallFromGitOptions = {},
): Promise<InstallResult> {
  const log = getLogger('skills/installer');
  const validation = validateRepoUrl(repoUrl);
  if (!validation.valid) throw new Error(validation.error);
  const expectedSkillPaths = normalizeExpectedSkillPaths(options.expectedSkillPaths ?? []);
  if (options.requireExpectedPaths && expectedSkillPaths.size === 0) {
    throw new Error('安装前必须先检查仓库内容，并提供至少一个已确认的 skill 路径');
  }

  const tmpBase = join(tmpdir(), 'aurevoy-skill-');
  let cloneDir: string | null = null;

  try {
    log.info({ repoUrl }, '验证 Git 仓库可访问性');
    await verifyGitRemote(repoUrl);

    cloneDir = mkdtempSync(tmpBase);

    log.info({ repoUrl, cloneDir }, '开始克隆已验证的 skill 仓库');
    await execFileAsync('git', ['clone', '--depth', '1', repoUrl, cloneDir]);

    const discoveredSkillDirs = findSkillDirs(cloneDir);
    const skillDirs = expectedSkillPaths.size > 0
      ? discoveredSkillDirs.filter((skill) => expectedSkillPaths.has(skill.relativePath) || expectedSkillPaths.has(`${skill.relativePath}/SKILL.md`))
      : discoveredSkillDirs;
    if (skillDirs.length === 0) {
      const discovered = discoveredSkillDirs.map((skill) => `${skill.relativePath}/SKILL.md`).join(', ');
      throw new Error(
        expectedSkillPaths.size > 0
          ? `未找到调用前确认的 skill 路径；仓库中实际发现: ${discovered || '无'}`
          : '仓库中未发现任何包含有效 frontmatter 的 SKILL.md',
      );
    }

    mkdirSync(targetDir, { recursive: true });

    const installedSkills: string[] = [];
    const alreadyExisted: string[] = [];

    for (const { installName, fullPath, relativePath } of skillDirs) {
      const destDir = join(targetDir, installName);
      if (existsSync(destDir)) {
        alreadyExisted.push(installName);
      }

      if (existsSync(destDir)) {
        rmSync(destDir, { recursive: true, force: true });
      }
      cpSync(fullPath, destDir, {
        recursive: true,
        filter: (src) => basename(src) !== '.git',
      });

      const meta: InstallMetadata = {
        repoUrl,
        installedAt: new Date().toISOString(),
        inspectedSource: options.inspectedSource,
        inspectionSummary: options.inspectionSummary,
      };
      writeFileSync(join(destDir, INSTALL_META_FILE), JSON.stringify(meta, null, 2), 'utf-8');

      installedSkills.push(installName);
      log.info({ skill: installName, relativePath, dest: destDir }, 'skill 已安装');
    }

    return {
      installedSkills,
      alreadyExisted,
      totalFound: discoveredSkillDirs.length,
      inspectedSkillPaths: skillDirs.map((skill) => skill.relativePath),
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes('未发现')) throw err;
    if (err instanceof Error && err.message.includes('未找到调用前确认')) throw err;
    if (err instanceof Error && err.message.includes('安装前必须')) throw err;
    if (err instanceof Error && err.message.includes('不支持的协议')) throw err;
    if (err instanceof Error && err.message.includes('无效')) throw err;
    if (err instanceof Error && err.message.includes('不能为空')) throw err;
    if (err instanceof Error && err.message.includes('不是可访问的 Git 仓库')) throw err;

    const msg = err instanceof Error ? err.message : String(err);
    if (isMissingExecutableError(err)) {
      throw new Error('Git 未安装或不在 PATH 中，请先安装 Git');
    }
    throw new Error(`安装失败: ${msg}`);
  } finally {
    if (cloneDir && existsSync(cloneDir)) {
      try {
        rmSync(cloneDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        log.warn({ cloneDir, cleanupErr }, '清理临时目录失败');
      }
    }
  }
}

export async function uninstallSkill(name: string, userDir: string): Promise<{ deleted: boolean }> {
  const log = getLogger('skills/installer');
  const skillDir = join(resolvePath(userDir), name);

  if (!existsSync(skillDir)) {
    throw new Error(`skill "${name}" 不存在`);
  }

  const skillMd = join(skillDir, 'SKILL.md');
  if (!existsSync(skillMd)) {
    throw new Error(`"${name}" 不是有效的 skill 目录（缺少 SKILL.md）`);
  }

  rmSync(skillDir, { recursive: true, force: true });
  log.info({ name, skillDir }, 'skill 已卸载');

  return { deleted: true };
}

export function readInstallMetadata(skillDir: string): InstallMetadata | null {
  const metaPath = join(skillDir, INSTALL_META_FILE);
  if (!existsSync(metaPath)) return null;

  try {
    const raw = readFileSync(metaPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<InstallMetadata>;
    if (typeof parsed.repoUrl === 'string' && typeof parsed.installedAt === 'string') {
      return {
        repoUrl: parsed.repoUrl,
        installedAt: parsed.installedAt,
        inspectedSource: typeof parsed.inspectedSource === 'string' ? parsed.inspectedSource : undefined,
        inspectionSummary: typeof parsed.inspectionSummary === 'string' ? parsed.inspectionSummary : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

interface DiscoveredSkillDir {
  installName: string;
  fullPath: string;
  relativePath: string;
}

function findSkillDirs(rootDir: string): DiscoveredSkillDir[] {
  const results: DiscoveredSkillDir[] = [];
  const visited = new Set<string>();

  function walk(dir: string): void {
    if (visited.has(dir)) return;
    visited.add(dir);

    const skillMdPath = join(dir, 'SKILL.md');
    if (existsSync(skillMdPath)) {
      const frontmatter = readSkillFrontmatter(skillMdPath);
      if (frontmatter) {
        const relPath = normalizeRepoPath(relative(rootDir, dir) || '.');
        results.push({
          installName: frontmatter.name,
          fullPath: dir,
          relativePath: relPath,
        });
      }
      return;
    }

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (shouldSkipDir(entry)) continue;
      const fullPath = join(dir, entry);
      try {
        if (statSync(fullPath).isDirectory()) walk(fullPath);
      } catch {
        continue;
      }
    }
  }

  walk(rootDir);
  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function shouldSkipDir(name: string): boolean {
  return name.startsWith('.')
    || name === 'node_modules'
    || name === 'dist'
    || name === 'build'
    || name === 'target'
    || name === '__pycache__';
}

function readSkillFrontmatter(skillMdPath: string): { name: string; description: string } | null {
  let raw: string;
  try {
    raw = readFileSync(skillMdPath, 'utf-8');
  } catch {
    return null;
  }
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return null;
  const name = readYamlStringField(match[1], 'name');
  const description = readYamlStringField(match[1], 'description');
  if (!name || !description) return null;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error(`无效的 skill name "${name}"（${skillMdPath}）：仅允许小写字母、数字和连字符`);
  }
  return { name, description };
}

function readYamlStringField(yaml: string, field: string): string {
  const re = new RegExp(`^${field}:\\s*(.+?)\\s*$`, 'm');
  const match = yaml.match(re);
  if (!match) return '';
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

function normalizeExpectedSkillPaths(paths: string[]): Set<string> {
  const result = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeRepoPath(path);
    if (!normalized) continue;
    if (normalized === 'SKILL.md') {
      result.add('.');
      result.add('./SKILL.md');
      continue;
    }
    result.add(normalized);
    if (normalized.endsWith('/SKILL.md')) result.add(normalized.slice(0, -'/SKILL.md'.length) || '.');
    else result.add(`${normalized}/SKILL.md`);
  }
  return result;
}

function normalizeRepoPath(path: string): string {
  const normalized = path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/+$/, '');
  return normalized === '' ? '.' : normalized;
}

async function verifyGitRemote(repoUrl: string): Promise<void> {
  try {
    await execFileAsync('git', ['ls-remote', '--exit-code', repoUrl, 'HEAD']);
  } catch (err) {
    if (isMissingExecutableError(err)) {
      throw new Error('Git 未安装或不在 PATH 中，请先安装 Git');
    }
    throw new Error('不是可访问的 Git 仓库；如果用户给的是网页或文章，请先读取网页内容并找到真实仓库地址');
  }
}

function isMissingExecutableError(err: unknown): boolean {
  return typeof err === 'object'
    && err !== null
    && 'code' in err
    && (err as { code?: string }).code === 'ENOENT';
}

function execFileAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}
