import { existsSync, mkdirSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { platform as osPlatform } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { config } from '../config.js';
import { getLogger } from '../logging/logger.js';

const log = getLogger('python-runtime');

function isWindows(): boolean {
  return osPlatform() === 'win32';
}

export function getPythonHome(): string {
  return config.python.venvDir;
}

export function getPythonBinDir(): string {
  return isWindows() ? join(getPythonHome(), 'Scripts') : join(getPythonHome(), 'bin');
}

export function getPythonPath(): string {
  if (isWindows()) return join(getPythonHome(), 'Scripts', 'python.exe');
  return join(getPythonHome(), 'bin', 'python3');
}

export function getPipPath(): string {
  if (isWindows()) return join(getPythonHome(), 'Scripts', 'pip.exe');
  return join(getPythonHome(), 'bin', 'pip3');
}

export function isPythonInstalled(): boolean {
  return existsSync(getPythonPath());
}

// ── 系统 Python 检测 ─────────────────────────────────────

let _sysPythonResult: { path: string; version: string | null } | { path: null; version: null } | undefined;

/** 检测系统 PATH 中已有的 python3/python，返回可执行文件完整路径。 */
export function findSystemPython(): string | null {
  if (_sysPythonResult !== undefined) return _sysPythonResult.path;
  const names = isWindows() ? ['python3.exe', 'python.exe'] : ['python3', 'python'];
  for (const name of names) {
    try {
      const raw = execSync(`"${name}" -c "import sys; sys.stdout.write(sys.executable)"`, {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (raw && existsSync(raw)) {
        _sysPythonResult = { path: raw, version: null };
        return raw;
      }
    } catch { /* not found */ }
  }
  _sysPythonResult = { path: null, version: null };
  return null;
}

/** 获取 Python 版本号（不含 "Python " 前缀）。 */
export function getPythonVersion(): string | null {
  const pyPath = getPythonPath();
  if (!existsSync(pyPath)) return null;
  try {
    const raw = execSync(`"${pyPath}" --version`, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return raw.replace(/^Python /, '');
  } catch {
    return null;
  }
}

/** 清除系统 Python 检测缓存，用于用户修改设置后重新判定。 */
export function resetPythonCache(): void {
  _sysPythonResult = undefined;
}

export function getPythonEnv(): Record<string, string> {
  if (!isPythonInstalled()) return {};
  return {
    AUREVOY_PYTHON: getPythonPath(),
    AUREVOY_PYTHON_HOME: getPythonHome(),
  };
}

export function getAugmentedPath(): string {
  if (!isPythonInstalled()) return process.env.PATH ?? '';
  return `${getPythonBinDir()}${delimiter}${process.env.PATH ?? ''}`;
}

// ── venv 创建 ────────────────────────────────────────────

/**
 * 使用指定的 Python 解释器在 ~/.aurevoy/venv 创建虚拟环境。
 * 返回 venv 中 python 的路径；失败返回 null。
 */
function createVenv(pythonExe: string): Promise<string | null> {
  const venvDir = getPythonHome();
  mkdirSync(resolve(venvDir, '..'), { recursive: true });

  if (existsSync(venvDir)) {
    // venv 已存在，校验 python 可执行
    const pyPath = getPythonPath();
    if (existsSync(pyPath)) {
      log.info({ venv: venvDir }, 'venv 已存在，跳过创建');
      return Promise.resolve(pyPath);
    }
    // 目录存在但 python 不完整，删除重建
  }

  log.info({ pythonExe, venvDir }, '创建 Python venv');
  const result = spawn(pythonExe, ['-m', 'venv', venvDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  return new Promise((resolveVenv) => {
    let stderr = '';
    result.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    result.on('close', (code) => {
      if (code !== 0) {
        log.warn({ code, stderr: stderr.trim() }, 'venv 创建失败');
        resolveVenv(null);
        return;
      }
      const pyPath = getPythonPath();
      if (existsSync(pyPath)) {
        log.info({ venvPython: pyPath }, 'venv 创建完成');
        resolveVenv(pyPath);
      } else {
        log.warn({ expectedPath: pyPath }, 'venv 创建后未找到 python 可执行文件');
        resolveVenv(null);
      }
    });
  });
}

/** 查找可用于创建 venv 的 Python 解释器（用户配置 > 系统检测）。 */
function resolvePythonInterpreter(): string | null {
  // 1. 用户在设置中指定的路径
  if (config.python.userPath) {
    const userPath = config.python.userPath.trim();
    if (existsSync(userPath)) {
      log.info({ python: userPath }, '使用用户指定的 Python 解释器');
      return userPath;
    }
    log.warn({ python: userPath }, '用户指定的 Python 路径不存在');
  }

  // 2. 系统 PATH 中的 Python
  const sysPy = findSystemPython();
  if (sysPy) {
    log.info({ python: sysPy }, '检测到系统 Python');
    return sysPy;
  }

  return null;
}

/**
 * 确保 Python 环境就绪：优先创建 venv。
 * 不执行任何网络下载，仅使用本地已有的 Python。
 * 返回 venv python 路径，失败返回 null。
 */
export async function ensurePythonReady(): Promise<string | null> {
  if (isPythonInstalled()) {
    return getPythonPath();
  }

  const interpreter = resolvePythonInterpreter();
  if (!interpreter) {
    log.warn('未找到可用的 Python 解释器，请在设置中配置 Python 路径');
    return null;
  }

  return createVenv(interpreter);
}
