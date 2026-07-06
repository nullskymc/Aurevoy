#!/usr/bin/env node

/**
 * 开发态只需要让 apps/agent 通过根 workspace node_modules 解析依赖。
 *
 * 打包脚本会物化 apps/agent/node_modules；如果开发时继续使用这个副本，
 * tsx 会优先读到 stale 的 shared dist，并且 watch 大量复制依赖导致 EMFILE。
 * Tauri 的 resource 校验仍要求该路径存在，所以这里保留空目录占位。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const AGENT_NODE_MODULES = join(ROOT, 'apps', 'agent', 'node_modules');

function main() {
  if (existsSync(AGENT_NODE_MODULES)) {
    rmSync(AGENT_NODE_MODULES, { recursive: true, force: true });
    console.log('[prepare-agent-dev] removed generated apps/agent/node_modules');
  }
  mkdirSync(AGENT_NODE_MODULES, { recursive: true });
  writeFileSync(
    join(AGENT_NODE_MODULES, '.aurevoy-dev-placeholder'),
    'Development placeholder for Tauri resource validation.\n',
  );
  console.log('[prepare-agent-dev] prepared empty apps/agent/node_modules placeholder');
}

main();
