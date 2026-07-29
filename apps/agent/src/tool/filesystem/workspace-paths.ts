import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { config } from '../../config.js';

/** 将路径限制到工作区、用户明确授权的外部目录或内部可信目录。 */
export function resolveInWorkspace(input: unknown, workspaceRoot: string, externalPaths?: readonly string[]): string {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('path 必须是非空字符串');
  const target = isAbsolute(input) ? resolve(input) : resolve(workspaceRoot, input);
  if (isInsideExternalPath(target, externalPaths)) return target;
  const rel = relative(workspaceRoot, target);
  if (rel === '') return target;
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越界：只允许访问工作区目录内 (${workspaceRoot})`);
  }
  return target;
}

export function rootAndExternals(ctx?: { workspaceDir?: string; externalPaths?: readonly string[] }) {
  return { root: ctx?.workspaceDir ?? resolve(config.workspaceDir), externalPaths: ctx?.externalPaths };
}

export async function assertRealPathInside(target: string, workspaceRoot: string, externalPaths?: readonly string[]): Promise<void> {
  if (isInsideExternalPath(target, externalPaths) || isInsideTrustedDir(target)) return;
  await fs.mkdir(workspaceRoot, { recursive: true });
  const realRoot = await fs.realpath(workspaceRoot);
  const real = await realpathOrNearest(target);
  const rel = relative(realRoot, real);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new Error(`路径越界（符号链接指向工作区外）：只允许访问 ${workspaceRoot} 内`);
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try { await fs.stat(path); return true; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; throw err; }
}

function isInsideExternalPath(target: string, externalPaths?: readonly string[]): boolean {
  const resolved = resolve(target);
  return externalPaths?.some((externalPath) => {
    const external = resolve(externalPath);
    return resolved === external || resolved.startsWith(`${external}/`);
  }) ?? false;
}

function isInsideTrustedDir(target: string): boolean {
  const resolved = resolve(target);
  return getTrustedDirs().some((dir) => resolved === dir || resolved.startsWith(`${dir}/`));
}

function getTrustedDirs(): string[] {
  const home = homedir();
  const dirs = [resolve(home, '.aurevoy'), resolve(home, '.agents'), resolve(home, '.claude'), resolve(home, '.codex')];
  try { dirs.push(resolve(config.skills.builtinDir)); } catch { /* 配置尚未初始化时忽略。 */ }
  try {
    for (const sub of [config.skills.workspaceSubDir, config.skills.agentsWorkspaceSubDir, config.skills.claudeWorkspaceSubDir, config.skills.codexWorkspaceSubDir]) {
      dirs.push(resolve(config.workspaceDir, sub));
    }
  } catch { /* 配置尚未初始化时忽略。 */ }
  return dirs;
}

async function realpathOrNearest(path: string): Promise<string> {
  let probe = resolve(path);
  for (;;) {
    try { return await fs.realpath(probe); }
    catch (err) { if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err; }
    const parent = join(probe, '..');
    if (parent === probe) throw new Error(`无法解析路径: ${path}`);
    probe = parent;
  }
}
