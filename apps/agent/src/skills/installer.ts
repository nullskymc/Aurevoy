import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, rmSync, cpSync, mkdtempSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { getLogger } from '../logging/logger.js';

export interface InstallResult {
  installedSkills: string[];
  alreadyExisted: string[];
  totalFound: number;
}

export interface InstallMetadata {
  repoUrl: string;
  installedAt: string;
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

export async function installFromGit(repoUrl: string, targetDir: string): Promise<InstallResult> {
  const log = getLogger('skills/installer');
  const validation = validateRepoUrl(repoUrl);
  if (!validation.valid) throw new Error(validation.error);

  const tmpBase = join(tmpdir(), 'aurevoy-skill-');
  let cloneDir: string | null = null;

  try {
    cloneDir = mkdtempSync(tmpBase);

    log.info({ repoUrl, cloneDir }, '开始克隆 skill 仓库');
    await execFileAsync('git', ['clone', '--depth', '1', repoUrl, cloneDir]);

    const skillDirs = findSkillDirs(cloneDir);
    if (skillDirs.length === 0) {
      throw new Error('仓库中未发现任何包含 SKILL.md 的 skill 目录');
    }

    mkdirSync(targetDir, { recursive: true });

    const installedSkills: string[] = [];
    const alreadyExisted: string[] = [];

    for (const { dirName, fullPath } of skillDirs) {
      const destDir = join(targetDir, dirName);
      if (existsSync(destDir)) {
        alreadyExisted.push(dirName);
      }

      if (existsSync(destDir)) {
        rmSync(destDir, { recursive: true, force: true });
      }
      cpSync(fullPath, destDir, { recursive: true });

      const meta: InstallMetadata = {
        repoUrl,
        installedAt: new Date().toISOString(),
      };
      writeFileSync(join(destDir, INSTALL_META_FILE), JSON.stringify(meta, null, 2), 'utf-8');

      installedSkills.push(dirName);
      log.info({ skill: dirName, dest: destDir }, 'skill 已安装');
    }

    return {
      installedSkills,
      alreadyExisted,
      totalFound: skillDirs.length,
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes('未发现')) throw err;
    if (err instanceof Error && err.message.includes('不支持的协议')) throw err;
    if (err instanceof Error && err.message.includes('无效')) throw err;
    if (err instanceof Error && err.message.includes('不能为空')) throw err;

    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT') || msg.includes('not found')) {
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
      return { repoUrl: parsed.repoUrl, installedAt: parsed.installedAt };
    }
    return null;
  } catch {
    return null;
  }
}

function findSkillDirs(rootDir: string): { dirName: string; fullPath: string }[] {
  const results: { dirName: string; fullPath: string }[] = [];

  let entries: string[];
  try {
    entries = readdirSync(rootDir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const fullPath = join(rootDir, entry);
    try {
      if (!statSync(fullPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const skillMdPath = join(fullPath, 'SKILL.md');
    if (existsSync(skillMdPath)) {
      results.push({ dirName: entry, fullPath });
    }
  }

  return results;
}

function execFileAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}
