#!/usr/bin/env node

/**
 * 下载并安装 python-build-standalone 到 ~/.aurevoy/python/
 * 用法: node scripts/setup-python.mjs [--force]
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { arch as osArch, homedir, platform as osPlatform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const PBS_TAG = '20260610';
const PYTHON_VERSION = '3.13.14';
const BASE_URL = `https://github.com/indygreg/python-build-standalone/releases/download/${PBS_TAG}`;

const PLATFORM_MAP = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc',
};

const force = process.argv.includes('--force');
const pythonDir = resolve(homedir(), '.aurevoy', 'python');
const metadataPath = join(pythonDir, '.metadata.json');

function getPlatformTriple() {
  const key = `${osPlatform()}-${osArch()}`;
  const triple = PLATFORM_MAP[key];
  if (!triple) {
    throw new Error(`不支持的平台: ${osPlatform()}-${osArch()}。支持: ${Object.keys(PLATFORM_MAP).join(', ')}`);
  }
  return triple;
}

function getDownloadFilename(triple) {
  return `cpython-${PYTHON_VERSION}+${PBS_TAG}-${triple}-install_only_stripped.tar.gz`;
}

async function downloadFile(url, destPath) {
  console.log(`  URL: ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败: ${res.status} ${res.statusText}`);

  const total = Number(res.headers.get('content-length') ?? 0);
  let downloaded = 0;
  let lastPct = -1;

  const reader = res.body.getReader();
  const writer = createWriteStream(destPath);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await new Promise((resolve, reject) => {
      writer.write(value, (err) => err ? reject(err) : resolve());
    });
    downloaded += value.byteLength;
    if (total > 0) {
      const pct = Math.round((downloaded / total) * 100);
      if (pct !== lastPct && pct % 10 === 0) {
        process.stdout.write(`\r  进度: ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)}MB)`);
        lastPct = pct;
      }
    }
  }

  writer.end();
  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
  if (lastPct >= 0) process.stdout.write('\n');
}

function extractTarball(tarPath, destDir) {
  return new Promise((resolvePromise, reject) => {
    const tmpExtract = join(tmpdir(), `aurevoy-python-extract-${Date.now()}`);
    mkdirSync(tmpExtract, { recursive: true });

    console.log(`  解压到: ${tmpExtract}`);
    const child = spawn('tar', ['xzf', tarPath, '-C', tmpExtract], { stdio: 'inherit' });

    child.on('error', (err) => {
      reject(new Error(`解压失败: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`tar 退出码: ${code}`));
        return;
      }

      const extractedPythonDir = join(tmpExtract, 'python');
      if (!existsSync(extractedPythonDir)) {
        reject(new Error(`解压后未找到 python/ 目录: ${tmpExtract}`));
        return;
      }

      if (existsSync(destDir)) {
        rmSync(destDir, { recursive: true, force: true });
      }
      mkdirSync(resolve(destDir, '..'), { recursive: true });
      renameSync(extractedPythonDir, destDir);
      rmSync(tmpExtract, { recursive: true, force: true });
      resolvePromise();
    });
  });
}

function writeMetadata(triple) {
  const metadata = {
    pbsTag: PBS_TAG,
    pythonVersion: PYTHON_VERSION,
    platform: `${osPlatform()}-${osArch()}`,
    triple,
    installedAt: new Date().toISOString(),
  };
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  return metadata;
}

function verifyInstall() {
  const isWindows = osPlatform() === 'win32';
  const binName = isWindows ? 'python.exe' : 'bin/python3';
  const binPath = join(pythonDir, binName);
  if (!existsSync(binPath)) {
    throw new Error(`安装验证失败: ${binPath} 不存在`);
  }
  return binPath;
}

async function main() {
  console.log('Aurevoy Python 运行时安装器');
  console.log(`  Python: ${PYTHON_VERSION} (PBS ${PBS_TAG})`);
  console.log(`  目标: ${pythonDir}`);

  if (!force && existsSync(metadataPath)) {
    try {
      const meta = JSON.parse(readFileSync(metadataPath, 'utf8'));
      if (meta.pythonVersion === PYTHON_VERSION && meta.pbsTag === PBS_TAG) {
        console.log(`\n已安装 Python ${meta.pythonVersion}（${meta.installedAt}）。使用 --force 重新安装。`);
        return;
      }
    } catch { /* corrupted metadata, reinstall */ }
  }

  const triple = getPlatformTriple();
  const filename = getDownloadFilename(triple);
  const url = `${BASE_URL}/${filename}`;
  const tarPath = join(tmpdir(), filename);

  try {
    console.log('\n[1/4] 下载...');
    await downloadFile(url, tarPath);

    console.log('[2/4] 解压...');
    await extractTarball(tarPath, pythonDir);

    console.log('[3/4] 写入元数据...');
    const meta = writeMetadata(triple);

    console.log('[4/4] 验证...');
    const binPath = verifyInstall();

    console.log(`\n安装完成！`);
    console.log(`  Python: ${binPath}`);
    console.log(`  版本: ${meta.pythonVersion}`);
    console.log(`  平台: ${meta.triple}`);
  } finally {
    if (existsSync(tarPath)) {
      rmSync(tarPath, { force: true });
    }
  }
}

main().catch((err) => {
  console.error(`\n安装失败: ${err.message}`);
  process.exit(1);
});
