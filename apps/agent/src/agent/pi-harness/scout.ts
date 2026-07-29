import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ScoutReport } from '@aurevoy/shared';

interface ScoutWorkspaceInspection {
  keyFiles: Array<{ path: string; reason: string }>;
  techStack: string[];
}

const SCOUT_CACHE_TTL_MS = 30_000;
const scoutWorkspaceCache = new Map<string, {
  expiresAt: number;
  value: Promise<ScoutWorkspaceInspection>;
}>();

/** 构建一次非阻塞、通用的工作区侦查报告。 */
export async function buildScoutReport(workspaceDir: string): Promise<ScoutReport> {
  const startedAt = Date.now();
  const { keyFiles, techStack } = await inspectScoutWorkspace(workspaceDir);
  return {
    keyFiles,
    techStack,
    // 保持为通用产品约束，禁止把 Aurevoy 仓库的专用执行配方注入其他项目。
    constraints: [
      'Prefer verified tool results; do not invent success when external capabilities fail.',
      'Stay within the task workspace unless the user granted broader access.',
    ],
    summary: keyFiles.length > 0
      ? `已识别 ${keyFiles.length} 个工作区关键文件，Agent 将优先结合这些上下文执行。`
      : '未识别到常见项目入口文件，Agent 将通过工具按需侦查工作区。',
    durationMs: Date.now() - startedAt,
    rounds: 1,
  };
}

/** 同工作区短时间内复用侦查结果；并发任务共享同一个读取 Promise。 */
async function inspectScoutWorkspace(workspaceDir: string): Promise<ScoutWorkspaceInspection> {
  const now = Date.now();
  const cached = scoutWorkspaceCache.get(workspaceDir);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = Promise.all([
    findScoutKeyFiles(workspaceDir),
    inferScoutTechStack(workspaceDir),
  ]).then(([keyFiles, techStack]) => ({ keyFiles, techStack }));
  scoutWorkspaceCache.set(workspaceDir, { expiresAt: now + SCOUT_CACHE_TTL_MS, value });

  try {
    return await value;
  } catch (error) {
    if (scoutWorkspaceCache.get(workspaceDir)?.value === value) {
      scoutWorkspaceCache.delete(workspaceDir);
    }
    throw error;
  }
}

async function findScoutKeyFiles(workspaceDir: string): Promise<Array<{ path: string; reason: string }>> {
  const candidates = [
    ['AGENTS.md', 'Agent / project collaboration instructions'],
    ['CLAUDE.md', 'Project agent instructions'],
    ['README.md', 'Project overview and local setup'],
    ['package.json', 'Node package scripts and dependencies'],
    ['pyproject.toml', 'Python project metadata'],
    ['Cargo.toml', 'Rust project metadata'],
    ['go.mod', 'Go module definition'],
    ['docs/ARCHITECTURE.md', 'Architecture documentation'],
    ['docs/API.md', 'API documentation'],
  ] as const;

  const discovered: Array<{ path: string; reason: string } | null> = await Promise.all(
    candidates.map(async ([relativePath, reason]) => {
    try {
      await fs.access(join(workspaceDir, relativePath));
      return { path: relativePath, reason };
    } catch {
      return null;
    }
    }),
  );
  return discovered.filter((item): item is { path: string; reason: string } => item !== null);
}

async function inferScoutTechStack(workspaceDir: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(join(workspaceDir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencies = new Set([
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
    ]);
    return [
      dependencies.has('react') ? 'React' : null,
      dependencies.has('typescript') ? 'TypeScript' : null,
      dependencies.has('vite') ? 'Vite' : null,
      dependencies.has('@tauri-apps/api') || dependencies.has('@tauri-apps/cli') ? 'Tauri' : null,
      dependencies.has('fastify') ? 'Fastify' : null,
    ].filter((item): item is string => item !== null);
  } catch {
    return [];
  }
}
