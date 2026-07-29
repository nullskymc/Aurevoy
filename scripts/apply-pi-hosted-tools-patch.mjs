#!/usr/bin/env node

/**
 * 将 hosted tool 事件补入当前 Pi Provider 适配层。
 *
 * 补丁只修改已安装依赖的 dist 文件；若依赖已应用则保持幂等，
 * 若 Pi 版本漂移导致上下文不匹配则明确失败，避免静默丢失搜索轨迹。
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const PATCH = resolve(ROOT, 'patches', 'pi-hosted-tools.patch');

function gitApply(args) {
  return spawnSync('git', ['apply', ...args, PATCH], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function main() {
  if (!existsSync(PATCH)) {
    throw new Error(`缺少 Pi hosted tool 补丁：${PATCH}`);
  }

  const check = gitApply(['--check']);
  if (check.status === 0) {
    const applied = gitApply([]);
    if (applied.status !== 0) {
      throw new Error(applied.stderr || '应用 Pi hosted tool 补丁失败');
    }
    console.log('[pi-hosted-tools] patch applied');
    return;
  }

  const reversed = gitApply(['--reverse', '--check']);
  if (reversed.status === 0) {
    console.log('[pi-hosted-tools] patch already applied');
    return;
  }

  throw new Error(
    [
      'Pi hosted tool 补丁与当前依赖不兼容。',
      check.stderr.trim(),
      reversed.stderr.trim(),
    ].filter(Boolean).join('\n'),
  );
}

main();
