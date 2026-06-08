import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MemoryCategory, MemoryEntry } from '@aurevoy/shared';
import { config } from '../config.js';
import { toolRegistry } from './registry.js';
import { memoryStore } from '../store/db.js';

/**
 * 内置基础工具：文件读写、目录列举、HTTP 抓取。
 *
 * 安全约束：
 * - 文件类工具的路径一律被限制在 `config.workspaceDir` 内（防目录穿越）。
 * - 写文件标记为 dangerous、HTTP 抓取标记为 caution，执行前需用户审批（见 agent/loop.ts）。
 * - 跨平台：路径用 node:path 拼接，不硬编码分隔符。
 */

const MAX_READ_BYTES = 256 * 1024; // 单次读文件上限 256KB
const MAX_FETCH_BYTES = 1024 * 1024; // 单次抓取上限 1MB
const FETCH_TIMEOUT_MS = 20000;

/** 把用户给的相对/绝对路径解析为工作区内的绝对路径；越界则抛错。 */
function resolveInWorkspace(input: unknown): string {
  const workspaceRoot = workspaceRootPath();
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('path 必须是非空字符串');
  }
  // 绝对路径按原样解析，相对路径相对工作区根
  const target = isAbsolute(input) ? resolve(input) : resolve(workspaceRoot, input);
  const rel = relative(workspaceRoot, target);
  if (rel === '' ) return target; // 工作区根本身
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越界：只允许访问工作区目录内 (${workspaceRoot})`);
  }
  return target;
}

async function ensureWorkspace(): Promise<void> {
  await fs.mkdir(workspaceRootPath(), { recursive: true });
}

/** 解析路径的真实位置（跟随 symlink）；不存在时回退到最近的已存在祖先。 */
async function realpathOrNearest(p: string): Promise<string> {
  let probe = resolve(p);
  for (;;) {
    try {
      return await fs.realpath(probe);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
      const parent = join(probe, '..');
      if (parent === probe) throw new Error(`无法解析路径: ${p}`);
      probe = parent;
    }
  }
}

/**
 * 二次校验：跟随符号链接后，目标的真实路径仍必须落在工作区真实根目录内。
 * 防止工作区内的 symlink 指向外部目录导致越界读写。
 */
async function assertRealPathInside(target: string): Promise<void> {
  await ensureWorkspace();
  const workspaceRoot = workspaceRootPath();
  const realRoot = await fs.realpath(workspaceRoot);
  const real = await realpathOrNearest(target);
  const rel = relative(realRoot, real);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new Error(`路径越界（符号链接指向工作区外）：只允许访问 ${workspaceRoot} 内`);
  }
}

function workspaceRootPath(): string {
  return resolve(config.workspaceDir);
}

// ---- list_directory（safe）----
toolRegistry.register({
  descriptor: {
    name: 'list_directory',
    description: '列出工作区内某个目录的条目（文件/子目录）。path 相对工作区根，缺省为根。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作区的目录路径，缺省为根目录' } },
      additionalProperties: false,
    },
    riskLevel: 'safe',
  },
  async execute(args) {
    await ensureWorkspace();
    const dir = resolveInWorkspace((args.path as string | undefined) ?? '.');
    await assertRealPathInside(dir);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return {
      dir: relative(workspaceRootPath(), dir) || '.',
      entries: entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
      })),
    };
  },
});

// ---- read_file（safe，限工作区内）----
toolRegistry.register({
  descriptor: {
    name: 'read_file',
    description: '读取工作区内一个文本文件的内容（最多 256KB）。path 相对工作区根。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作区的文件路径' } },
      required: ['path'],
      additionalProperties: false,
    },
    riskLevel: 'safe',
  },
  async execute(args) {
    const file = resolveInWorkspace(args.path);
    await assertRealPathInside(file);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('目标不是文件');
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(`文件过大（${stat.size} 字节），上限 ${MAX_READ_BYTES} 字节`);
    }
    const content = await fs.readFile(file, 'utf8');
    return { path: relative(workspaceRootPath(), file), size: stat.size, content };
  },
});

// ---- write_file（dangerous，需审批）----
toolRegistry.register({
  descriptor: {
    name: 'write_file',
    description: '在工作区内写入文本文件（覆盖式，自动创建父目录）。path 相对工作区根。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        content: { type: 'string', description: '要写入的文本内容' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    riskLevel: 'dangerous',
  },
  async execute(args) {
    const file = resolveInWorkspace(args.path);
    const content = typeof args.content === 'string' ? args.content : String(args.content ?? '');
    await fs.mkdir(join(file, '..'), { recursive: true });
    // 创建父目录后校验真实路径（含父目录中的 symlink）仍在工作区内
    await assertRealPathInside(file);
    await fs.writeFile(file, content, 'utf8');
    return { path: relative(workspaceRootPath(), file), bytesWritten: Buffer.byteLength(content) };
  },
});

// ---- http_fetch（caution，需审批）----
toolRegistry.register({
  descriptor: {
    name: 'http_fetch',
    description: '抓取一个 http(s) URL 的文本内容（GET，最多 1MB）。用于查资料/读网页。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: '要抓取的 http/https URL' } },
      required: ['url'],
      additionalProperties: false,
    },
    riskLevel: 'caution',
  },
  async execute(args) {
    const raw = args.url;
    if (typeof raw !== 'string' || raw.trim() === '') throw new Error('url 必须是非空字符串');
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`非法 URL: ${raw}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('只允许 http/https 协议');
    }
    const res = await fetch(parsed, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let body = '';
    let truncated = false;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_FETCH_BYTES) {
          body += decoder.decode(value.slice(0, MAX_FETCH_BYTES - (received - value.byteLength)));
          truncated = true;
          await reader.cancel().catch(() => {});
          break;
        }
        body += decoder.decode(value, { stream: true });
      }
    }
    return {
      url: parsed.toString(),
      status: res.status,
      contentType: res.headers.get('content-type') ?? null,
      truncated,
      body,
    };
  },
});

// ---- remember（safe）：写入跨会话长期记忆 ----
// 设计：agent 可主动记住用户偏好/习惯/事实；每条记录来源任务与置信度，
// 完全可在记忆面板查看/编辑/删除/禁用（用户保有最终控制权，故无需逐次审批）。
const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  'preference',
  'directory',
  'model',
  'habit',
  'fact',
  'other',
];
const MAX_MEMORY_CONTENT = 2000;

toolRegistry.register({
  descriptor: {
    name: 'remember',
    description:
      '把一条关于用户的长期事实记下来，跨会话保留（如偏好、常用目录、工作习惯）。' +
      '仅在信息明确且对将来有用时使用；不要记录临时上下文或敏感隐私。' +
      '用户可随时在记忆面板查看、编辑、停用或删除你记下的内容。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要长期记住的内容（一句自然语言）' },
        category: {
          type: 'string',
          enum: [...MEMORY_CATEGORIES],
          description: '分类：preference/directory/model/habit/fact/other',
        },
        confidence: {
          type: 'number',
          description: '你对这条记忆的置信度 0~1（默认 0.7）',
        },
      },
      required: ['content'],
      additionalProperties: false,
    },
    riskLevel: 'safe',
  },
  async execute(args, context) {
    const content = typeof args.content === 'string' ? args.content.trim() : '';
    if (!content) throw new Error('content 必须是非空字符串');
    if (content.length > MAX_MEMORY_CONTENT) {
      throw new Error(`记忆内容过长（上限 ${MAX_MEMORY_CONTENT} 字符）`);
    }
    const category: MemoryCategory =
      typeof args.category === 'string' && MEMORY_CATEGORIES.includes(args.category as MemoryCategory)
        ? (args.category as MemoryCategory)
        : 'other';
    let confidence = typeof args.confidence === 'number' ? args.confidence : 0.7;
    if (!Number.isFinite(confidence)) confidence = 0.7;
    confidence = Math.min(1, Math.max(0, confidence));

    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: randomUUID(),
      category,
      content,
      confidence,
      enabled: true,
      source: {
        origin: 'agent',
        taskId: context?.taskId,
        taskGoal: context?.taskGoal,
        createdAt: now,
      },
      createdAt: now,
      updatedAt: now,
    };
    memoryStore.create(entry);
    return {
      stored: true,
      id: entry.id,
      category,
      confidence,
      note: '已记入长期记忆，用户可在记忆面板管理。',
    };
  },
});
