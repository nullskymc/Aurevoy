import { accessSync, constants as fsConstants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CommandIsolationMode } from '../config.js';
import {
  detectWindowsJobObject,
  prepareWindowsJobObjectSpawn,
} from './windows-job-object.js';

export type EffectiveCommandIsolation =
  | 'macos-sandbox-exec'
  | 'linux-bubblewrap'
  | 'windows-job-object'
  | 'process';

export interface OsIsolationStatus {
  mode: EffectiveCommandIsolation;
  available: boolean;
  reason: string;
}

export interface IsolatedSpawnRequest {
  program: string;
  args: string[];
  cwd: string;
  workspaceRoot: string;
  externalPaths: readonly string[];
  env: NodeJS.ProcessEnv;
  requested: CommandIsolationMode;
}

export interface IsolatedSpawnPlan {
  program: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  mode: EffectiveCommandIsolation;
  cleanup: () => Promise<void>;
}

let cachedMacOsStatus: OsIsolationStatus | undefined;
let cachedLinuxStatus: OsIsolationStatus | undefined;
let cachedWindowsStatus: OsIsolationStatus | undefined;

/** 只探测本机能力，不执行用户命令；回归和设置诊断可复用此结果。 */
export function detectOsIsolation(): OsIsolationStatus {
  if (process.platform === 'darwin') {
    if (cachedMacOsStatus) return cachedMacOsStatus;
    const path = '/usr/bin/sandbox-exec';
    cachedMacOsStatus = executableAvailable(path) && probeMacOsSandboxExec(path)
      ? { mode: 'macos-sandbox-exec', available: true, reason: path }
      : { mode: 'process', available: false, reason: 'macOS sandbox-exec 不可用或当前进程无权启用 seatbelt' };
    return cachedMacOsStatus;
  }
  if (process.platform === 'linux') {
    if (cachedLinuxStatus) return cachedLinuxStatus;
    const path = findExecutable('bwrap');
    cachedLinuxStatus = path && probeLinuxBubblewrap(path)
      ? { mode: 'linux-bubblewrap', available: true, reason: path }
      : { mode: 'process', available: false, reason: 'Linux bubblewrap 不可用或当前用户 namespace 不可用' };
    return cachedLinuxStatus;
  }
  if (process.platform === 'win32') {
    if (cachedWindowsStatus) return cachedWindowsStatus;
    const status = detectWindowsJobObject();
    cachedWindowsStatus = status.available
      ? { mode: 'windows-job-object', available: true, reason: status.reason }
      : { mode: 'process', available: false, reason: status.reason };
    return cachedWindowsStatus;
  }
  return {
    mode: 'process',
    available: false,
    reason: `平台 ${process.platform} 没有已接入的 OS sandbox`,
  };
}

/**
 * 为 shell runner 构造平台隔离命令。
 *
 * `process` 是显式兼容回退，不伪装成安全 sandbox；`required` 在没有 OS 能力时直接失败。
 */
export async function prepareIsolatedSpawn(request: IsolatedSpawnRequest): Promise<IsolatedSpawnPlan> {
  const status = detectOsIsolation();
  if (request.requested === 'process') return processPlan(request);
  if (!status.available) {
    if (request.requested === 'required') {
      throw new Error(`当前平台没有可用的 OS 级命令隔离：${status.reason}`);
    }
    return processPlan(request);
  }

  if (status.mode === 'macos-sandbox-exec') return prepareMacOsPlan(request);
  if (status.mode === 'linux-bubblewrap') return prepareLinuxBubblewrapPlan(request, status.reason);
  if (status.mode === 'windows-job-object') {
    const plan = prepareWindowsJobObjectSpawn(request);
    return {
      ...plan,
      mode: 'windows-job-object',
    };
  }
  return processPlan(request);
}

function processPlan(request: IsolatedSpawnRequest): IsolatedSpawnPlan {
  return {
    program: request.program,
    args: request.args,
    env: request.env,
    mode: 'process',
    cleanup: async () => {},
  };
}

async function prepareMacOsPlan(request: IsolatedSpawnRequest): Promise<IsolatedSpawnPlan> {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'aurevoy-command-'));
  try {
    const profilePath = join(runtimeDir, 'profile.sb');
    // macOS seatbelt 按真实路径匹配；/tmp、/var 等系统别名若不展开，会把合法工作区误判为越界。
    const writableRoots = await uniqueRealRoots([request.workspaceRoot, ...request.externalPaths, runtimeDir]);
    const profile = [
      '(version 1)',
      '(deny default)',
      '(allow process-exec)',
      '(allow process-fork)',
      '(allow signal)',
      '(allow file-read*)',
      '(allow sysctl-read)',
      '(allow network-outbound)',
      ...writableRoots.map((root) => `(allow file-write* (subpath "${escapeProfilePath(root)}"))`),
      '',
    ].join('\n');
    await writeFile(profilePath, profile, 'utf8');

    return {
      program: '/usr/bin/sandbox-exec',
      args: ['-f', profilePath, request.program, ...request.args],
      env: { ...request.env, TMPDIR: runtimeDir },
      mode: 'macos-sandbox-exec',
      cleanup: async () => {
        await rm(runtimeDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(runtimeDir, { recursive: true, force: true });
    throw error;
  }
}

async function prepareLinuxBubblewrapPlan(
  request: IsolatedSpawnRequest,
  bubblewrapPath: string,
): Promise<IsolatedSpawnPlan> {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'aurevoy-command-'));
  const workspaceRoot = resolve(request.workspaceRoot);
  const externalRoots = uniqueRoots(request.externalPaths)
    .filter((root) => root !== workspaceRoot && !root.startsWith(`${workspaceRoot}/`));
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--bind', workspaceRoot, workspaceRoot,
    '--bind', runtimeDir, runtimeDir,
    ...externalRoots.flatMap((root) => ['--bind', root, root]),
    '--chdir', request.cwd,
    '--', request.program, ...request.args,
  ];

  return {
    program: bubblewrapPath,
    args,
    env: { ...request.env, TMPDIR: runtimeDir },
    mode: 'linux-bubblewrap',
    cleanup: async () => {
      await rm(runtimeDir, { recursive: true, force: true });
    },
  };
}

function executableAvailable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 可执行文件存在不代表当前桌面进程可以启用 OS sandbox；启动固定的 true 做一次能力探测。
 * 探测不接收用户输入，避免把“路径上有命令”误报成已隔离。
 */
function probeMacOsSandboxExec(path: string): boolean {
  const result = spawnSync(path, ['-p', '(version 1) (allow default)', '/usr/bin/true'], {
    stdio: 'ignore',
    timeout: 1000,
  });
  return result.status === 0 && !result.error;
}

/** 既检查 bwrap 本身，也检查 Linux 当前运行环境是否允许 user namespace。 */
function probeLinuxBubblewrap(path: string): boolean {
  const result = spawnSync(path, [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--', '/usr/bin/true',
  ], {
    stdio: 'ignore',
    timeout: 1000,
  });
  return result.status === 0 && !result.error;
}

function findExecutable(name: string): string | undefined {
  const candidates = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, name));
  return candidates.find(executableAvailable);
}

function uniqueRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.map((root) => resolve(root)))];
}

async function uniqueRealRoots(roots: readonly string[]): Promise<string[]> {
  const resolvedRoots = uniqueRoots(roots);
  const realRoots: string[] = [];
  for (const root of resolvedRoots) {
    try {
      realRoots.push(await realpath(root));
    } catch {
      // 外部目录可能尚未创建；保留词法路径，让后续 spawn 以明确错误结束。
    }
  }
  return [...new Set([...resolvedRoots, ...realRoots])];
}

function escapeProfilePath(path: string): string {
  return path.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
