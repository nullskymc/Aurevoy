import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync, renameSync, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { arch as osArch, platform as osPlatform, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { config } from '../config.js';
import { getLogger } from '../logging/logger.js';

const log = getLogger('python-runtime');

const PBS_TAG = '20260610';
const PYTHON_VERSION = '3.13.14';
const BASE_URL = `https://github.com/indygreg/python-build-standalone/releases/download/${PBS_TAG}`;

const PLATFORM_MAP: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc',
};

function platformKey(): string {
  return `${osPlatform()}-${osArch()}`;
}

function isWindows(): boolean {
  return osPlatform() === 'win32';
}

export function getPythonHome(): string {
  return config.python.home;
}

export function getPythonBinDir(): string {
  return isWindows() ? getPythonHome() : join(getPythonHome(), 'bin');
}

export function getPythonPath(): string {
  if (isWindows()) return join(getPythonHome(), 'python.exe');
  return join(getPythonHome(), 'bin', 'python3');
}

export function getPipPath(): string {
  if (isWindows()) return join(getPythonHome(), 'Scripts', 'pip.exe');
  return join(getPythonHome(), 'bin', 'pip3');
}

export function isPythonInstalled(): boolean {
  return existsSync(getPythonPath());
}

interface PythonMetadata {
  pbsTag: string;
  pythonVersion: string;
  platform: string;
  triple: string;
  installedAt: string;
}

export function getPythonVersion(): string | null {
  const metadataPath = join(getPythonHome(), '.metadata.json');
  if (existsSync(metadataPath)) {
    try {
      const meta: PythonMetadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
      return meta.pythonVersion;
    } catch { /* fall through */ }
  }
  return null;
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

async function downloadPython(triple: string, destPath: string): Promise<void> {
  const filename = `cpython-${PYTHON_VERSION}+${PBS_TAG}-${triple}-install_only_stripped.tar.gz`;
  const url = `${BASE_URL}/${filename}`;
  log.info({ url }, '下载 Python 运行时');

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载 Python 失败: ${res.status} ${res.statusText}`);

  const reader = res.body!.getReader();
  const writer = createWriteStream(destPath);
  let downloaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await new Promise<void>((resolveWrite, rejectWrite) => {
      writer.write(value, (err) => err ? rejectWrite(err) : resolveWrite());
    });
    downloaded += value.byteLength;
  }

  writer.end();
  await new Promise<void>((resolveEnd, rejectEnd) => {
    writer.on('finish', () => resolveEnd());
    writer.on('error', rejectEnd);
  });

  log.info({ bytes: downloaded }, 'Python 下载完成');
}

function extractPython(tarPath: string, destDir: string): Promise<void> {
  return new Promise((resolveExtract, reject) => {
    const tmpExtract = join(tmpdir(), `aurevoy-python-extract-${Date.now()}`);
    mkdirSync(tmpExtract, { recursive: true });

    const child = spawn('tar', ['xzf', tarPath, '-C', tmpExtract], { stdio: 'ignore' });

    child.on('error', (err) => reject(new Error(`解压失败: ${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`tar 退出码: ${code}`));
        return;
      }

      const extractedDir = join(tmpExtract, 'python');
      if (!existsSync(extractedDir)) {
        reject(new Error(`解压后未找到 python/ 目录`));
        return;
      }

      if (existsSync(destDir)) {
        rmSync(destDir, { recursive: true, force: true });
      }
      mkdirSync(resolve(destDir, '..'), { recursive: true });
      renameSync(extractedDir, destDir);
      rmSync(tmpExtract, { recursive: true, force: true });
      resolveExtract();
    });
  });
}

export async function ensurePythonReady(): Promise<void> {
  if (isPythonInstalled()) return;

  const key = platformKey();
  const triple = PLATFORM_MAP[key];
  if (!triple) {
    throw new Error(`当前平台不支持自动安装 Python: ${key}`);
  }

  const pythonHome = getPythonHome();
  const tarPath = join(tmpdir(), `aurevoy-python-${PBS_TAG}-${triple}.tar.gz`);

  try {
    log.info({ triple, version: PYTHON_VERSION }, '开始安装 Python 运行时');
    await downloadPython(triple, tarPath);
    await extractPython(tarPath, pythonHome);

    const metadata: PythonMetadata = {
      pbsTag: PBS_TAG,
      pythonVersion: PYTHON_VERSION,
      platform: key,
      triple,
      installedAt: new Date().toISOString(),
    };
    writeFileSync(join(pythonHome, '.metadata.json'), JSON.stringify(metadata, null, 2));

    if (!isPythonInstalled()) {
      throw new Error('Python 安装验证失败：可执行文件不存在');
    }

    log.info({ python: getPythonPath(), version: PYTHON_VERSION }, 'Python 运行时安装完成');
  } finally {
    if (existsSync(tarPath)) {
      rmSync(tarPath, { force: true });
    }
  }
}
