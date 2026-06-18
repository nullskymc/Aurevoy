#!/usr/bin/env node

/**
 * 为 Agent 准备 node_modules，供 Tauri 打包使用。
 *
 * 在 npm workspaces 下，所有依赖被 hoist 到根 node_modules/，
 * apps/agent/node_modules/ 默认不存在。但 Tauri 的 bundle.resources
 * 需要将 agent 的生产依赖打入 .app 包，所以必须物化这个目录。
 *
 * 策略：从根 node_modules 分析 agent 的生产依赖传递闭包，
 * 只拷贝需要的包（含 native .node 模块）。
 *
 * 用法:
 *   npm run prepare-agent-deps        # 从根 package.json
 *   node scripts/prepare-agent-deps.mjs
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '..');
const AGENT_DIR = join(ROOT, 'apps', 'agent');
const ROOT_NM = join(ROOT, 'node_modules');
const AGENT_NM = join(AGENT_DIR, 'node_modules');
const PACKAGES_DIR = join(ROOT, 'packages');

function main() {
  const agentPkg = JSON.parse(
    readFileSync(join(AGENT_DIR, 'package.json'), 'utf-8')
  );

  const prodDeps = Object.keys(agentPkg.dependencies || {});
  console.log(
    `[prepare-agent-deps] Agent 直接生产依赖: ${prodDeps.join(', ')}`
  );

  // 收集传递闭包
  const allDeps = new Set(prodDeps);
  for (const dep of prodDeps) {
    resolveTransitive(dep, allDeps);
  }

  console.log(`[prepare-agent-deps] 传递闭包共 ${allDeps.size} 个包`);

  // 确保目标目录存在
  mkdirSync(AGENT_NM, { recursive: true });

  let ok = 0;
  const missing = [];

  for (const name of allDeps) {
    const src = resolveSource(name);
    if (!src) {
      missing.push(name);
      continue;
    }

    const dest = join(AGENT_NM, name);
    // 确保父目录存在（scoped packages 需要 @scope 目录）
    mkdirSync(dirname(dest), { recursive: true });

    // -R: 递归  -L: 跟随符号链接（workspace 包是 symlink）
    execSync(`cp -RL "${src}" "${dest}"`, { stdio: 'pipe' });
    ok++;
  }

  console.log(`[prepare-agent-deps] 已拷贝 ${ok} 个包到 apps/agent/node_modules`);

  if (missing.length > 0) {
    console.error(
      `[prepare-agent-deps] ⚠️  缺失 ${missing.length} 个包: ${missing.join(', ')}`
    );
    process.exit(1);
  }
}

/**
 * 递归解析包的所有依赖（生产依赖的传递闭包）。
 */
function resolveTransitive(name, resolved) {
  const pkgPath = resolvePackageJson(name);
  if (!pkgPath) return;

  let depPkg;
  try {
    depPkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    return;
  }

  for (const dep of Object.keys(depPkg.dependencies || {})) {
    if (!resolved.has(dep)) {
      resolved.add(dep);
      resolveTransitive(dep, resolved);
    }
  }
}

/**
 * 查找包的 package.json 路径。
 * 优先级：共享 node_modules → packages/ 目录（workspace 包）
 */
function resolvePackageJson(name) {
  // 1. 标准 npm 路径
  const npmPath = join(ROOT_NM, name, 'package.json');
  if (existsSync(npmPath)) return npmPath;

  // 2. workspace 包（如 @aurevoy/shared → packages/shared）
  const parts = name.split('/');
  if (parts.length > 1) {
    const wsPath = join(PACKAGES_DIR, parts[1], 'package.json');
    if (existsSync(wsPath)) return wsPath;
  }

  return null;
}

/**
 * 解析包的源目录。
 * 优先级：共享 node_modules → packages/ 目录（workspace 包）
 */
function resolveSource(name) {
  // 1. 标准 npm 路径
  const npmPath = join(ROOT_NM, name);
  if (existsSync(npmPath)) return npmPath;

  // 2. workspace 包
  const parts = name.split('/');
  if (parts.length > 1) {
    const wsPath = join(PACKAGES_DIR, parts[1]);
    if (existsSync(wsPath)) return wsPath;
  }

  return null;
}

main();
