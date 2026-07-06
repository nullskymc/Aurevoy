#!/usr/bin/env node

/**
 * 为桌面安装包准备内置 Node.js runtime。
 *
 * Tauri 资源只会打包仓库中的 node-runtime 目录；本脚本优先复用已有
 * runtime，必要时复制当前 Node.js，若检测到不可移植的动态库依赖则下载
 * 官方发行包，避免安装版依赖用户机器上已安装 Node。
 */

import {
  chmodSync,
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'fs';
import { get } from 'https';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

const ROOT = resolve(import.meta.dirname, '..');
const RUNTIME_DIR = join(ROOT, 'apps', 'desktop', 'src-tauri', 'node-runtime');
const RUNTIME_BIN = join(RUNTIME_DIR, 'bin');
const NODE_NAME = process.platform === 'win32' ? 'node.exe' : 'node';
const DEST = join(RUNTIME_BIN, NODE_NAME);
const SRC = process.execPath;

let validation = validateRuntimeNode();

if (!validation.ok) {
  if (!existsSync(SRC)) {
    console.error(`[prepare-node-runtime] 未找到当前 Node.js 可执行文件: ${SRC}`);
    process.exit(1);
  }

  copyCurrentNode();
  validation = validateRuntimeNode();

  if (!validation.ok && process.platform !== 'win32') {
    console.warn(`[prepare-node-runtime] 当前 Node.js 不适合打包: ${validation.reason}`);
    await installOfficialNodeRuntime();
    validation = validateRuntimeNode();
  }
}

if (!validation.ok) {
  console.error(`[prepare-node-runtime] Node.js runtime 验证失败: ${validation.reason}`);
  process.exit(1);
}

const size = statSync(DEST).size;
console.log(
  `[prepare-node-runtime] Node.js runtime 已就绪: ${DEST} (${size} bytes, ${validation.version})`,
);

function copyCurrentNode() {
  resetRuntime();
  mkdirSync(RUNTIME_BIN, { recursive: true });
  copyFileSync(SRC, DEST);
  makeExecutable(DEST);
}

function resetRuntime() {
  // 只清理由脚本生成的目录，保留 node-runtime/.gitkeep。
  for (const name of ['bin', 'include', 'lib', 'share']) {
    rmSync(join(RUNTIME_DIR, name), { recursive: true, force: true });
  }
}

function makeExecutable(file) {
  if (process.platform !== 'win32') {
    chmodSync(file, 0o755);
  }
}

function validateRuntimeNode() {
  if (!existsSync(DEST)) {
    return { ok: false, reason: `${DEST} 不存在` };
  }

  const run = spawnSync(DEST, ['--version'], { encoding: 'utf8' });
  if (run.status !== 0) {
    return {
      ok: false,
      reason: (run.stderr || run.stdout || `退出码 ${run.status}`).trim(),
    };
  }

  if (process.platform === 'darwin') {
    const deps = spawnSync('otool', ['-L', DEST], { encoding: 'utf8' });
    if (deps.status === 0) {
      const nonPortableDeps = deps.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) =>
          line.startsWith('/opt/homebrew/')
          || line.startsWith('/usr/local/Cellar/')
          || line.startsWith('/usr/local/opt/'),
        );
      if (nonPortableDeps.length > 0) {
        return {
          ok: false,
          reason: `存在不可移植的 Homebrew 动态库依赖: ${nonPortableDeps[0]}`,
        };
      }
    }
  }

  return { ok: true, version: run.stdout.trim() };
}

async function installOfficialNodeRuntime() {
  const target = officialNodeTarget();
  const version = process.version;
  const archiveName = `node-${version}-${target}.tar.gz`;
  const url = `https://nodejs.org/dist/${version}/${archiveName}`;
  const temp = mkdtempSync(join(tmpdir(), 'aurevoy-node-runtime-'));
  const archive = join(temp, archiveName);

  console.log(`[prepare-node-runtime] 下载官方 Node.js runtime: ${url}`);
  await download(url, archive);

  const extracted = spawnSync('tar', ['-xzf', archive, '-C', temp], {
    encoding: 'utf8',
  });
  if (extracted.status !== 0) {
    throw new Error((extracted.stderr || extracted.stdout || 'tar 解压失败').trim());
  }

  resetRuntime();
  cpSync(join(temp, `node-${version}-${target}`), RUNTIME_DIR, {
    recursive: true,
    dereference: true,
  });
  makeExecutable(DEST);
}

function officialNodeTarget() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'darwin') return `darwin-${arch}`;
  if (process.platform === 'linux') return `linux-${arch}`;
  throw new Error(`当前平台 ${process.platform} 需要一个可直接复制的 Node.js runtime`);
}

function download(url, dest) {
  return new Promise((resolveDownload, rejectDownload) => {
    const request = get(url, (response) => {
      if (
        response.statusCode
        && response.statusCode >= 300
        && response.statusCode < 400
        && response.headers.location
      ) {
        response.resume();
        download(response.headers.location, dest)
          .then(resolveDownload)
          .catch(rejectDownload);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        rejectDownload(new Error(`下载失败: HTTP ${response.statusCode}`));
        return;
      }

      const file = createWriteStream(dest);
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolveDownload);
      });
      file.on('error', rejectDownload);
    });

    request.setTimeout(120000, () => {
      request.destroy(new Error('下载超时'));
    });
    request.on('error', rejectDownload);
  });
}
