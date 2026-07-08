import { existsSync, watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';
import type { SkillDescriptor } from '@aurevoy/shared';
import { skillRegistry } from './registry.js';
import { unifiedToolRegistry } from '../tool/unified-registry.js';
import { registerLoadSkillTool } from '../tool/skill-integration.js';
import { registerInstallSkillTool } from '../tool/install-skill.js';
import { config } from '../config.js';
import { getLogger } from '../logging/logger.js';

/**
 * 重新加载 skill 目录并刷新 load_skill / install_skill 工具注册。
 * 安装或卸载 skill 后调用，确保工具枚举和 skill catalog 同步。
 * 返回重载后的完整 skill 列表。
 */
export function reloadSkillsAndTools(): SkillDescriptor[] {
  skillRegistry.reload();
  unifiedToolRegistry.unregister('load_skill');
  registerLoadSkillTool();
  unifiedToolRegistry.unregister('install_skill');
  registerInstallSkillTool();
  return skillRegistry.listAll();
}

// ---- 文件变更热监听 ----

const WATCH_DIRS: string[] = [];

function collectSkillDirs(): string[] {
  if (WATCH_DIRS.length > 0) return WATCH_DIRS;

  const dirs: string[] = [];

  // 热监听只覆盖 Aurevoy 原生与通用 .agents 路径。
  // Codex/Claude 用户目录可能包含插件缓存或大规模依赖树，递归 watch 会触发 EMFILE；
  // 它们仍会被 skillRegistry.load() 读取，安装/设置页操作也会显式 reload。
  const userPaths = [
    config.skills.userDir,
    config.skills.agentsUserDir,
  ];

  // 工作区级路径同样只监听 Aurevoy/.agents；其它外部客户端目录通过手动 reload 同步。
  const workspacePaths = [
    resolve(config.workspaceDir, config.skills.workspaceSubDir),
    resolve(config.workspaceDir, config.skills.agentsWorkspaceSubDir),
  ];

  for (const p of [...userPaths, ...workspacePaths]) {
    if (existsSync(p)) dirs.push(p);
  }

  WATCH_DIRS.push(...dirs);
  return dirs;
}

/**
 * 启动 skill 文件变更自动监听。
 * 监听所有已发现的 skill 目录（用户级 + 工作区级），在文件增删改时自动触发热重载。
 * 返回停止监听的函数。
 */
export function startSkillWatcher(): () => void {
  const log = getLogger('skills/reload');
  const watchers: FSWatcher[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const dirs = collectSkillDirs();
  if (dirs.length === 0) {
    log.debug('没有存在的 skill 目录可监听');
    return () => {};
  }

  const debouncedReload = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const skills = reloadSkillsAndTools();
      log.info({ count: skills.length }, 'skill 热重载完成（文件变更自动触发）');
      debounceTimer = null;
    }, 500);
  };

  for (const dir of dirs) {
    try {
      const w = watch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const name = String(filename);
        if (!name.endsWith('.md') && !name.endsWith('.json')) return;
        // 过滤 .install.json 以外的 JSON（避免 node_modules 等误触）
        if (name.endsWith('.json') && name !== '.install.json') return;

        log.debug({ eventType, file: name }, 'skill 文件变更，触发热重载');
        debouncedReload();
      });
      w.on('error', (err) => {
        log.warn({ dir, err }, 'skill 目录监听失败，已降级为手动重载');
        try { w.close(); } catch { /* 忽略关闭错误 */ }
      });
      watchers.push(w);
      log.debug({ dir }, 'skill 目录监听已启动');
    } catch (err) {
      log.warn({ dir, err }, '无法监听 skill 目录（可能已被删除或无权限）');
    }
  }

  log.info({ dirCount: dirs.length, watcherCount: watchers.length }, 'skill 热监听已启动');

  return () => {
    for (const w of watchers) {
      try { w.close(); } catch { /* 忽略关闭错误 */ }
    }
    watchers.length = 0;
    if (debounceTimer) clearTimeout(debounceTimer);
    log.info('skill 监听已停止');
  };
}
