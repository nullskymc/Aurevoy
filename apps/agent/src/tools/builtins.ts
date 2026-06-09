import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { MemoryCategory, MemoryEntry, TaskArtifact } from '@aurevoy/shared';
import { config } from '../config.js';
import { toolRegistry } from './registry.js';
import { memoryStore } from '../store/db.js';
import { commandExecutor } from '../sandbox/command-executor.js';

/**
 * 内置基础工具：文件读写、目录列举、HTTP 抓取。
 *
 * 安全约束：
 * - 文件类工具的路径一律被限制在 `config.workspaceDir` 内（防目录穿越）。
 * - 写文件标记为 dangerous、HTTP 抓取标记为 caution，执行前需用户审批（见 agent/loop.ts）。
 * - 跨平台：路径用 node:path 拼接，不硬编码分隔符。
 */

const MAX_READ_BYTES = 256 * 1024; // 单次读文件上限 256KB
const MAX_SEARCH_FILES = 5000;
const MAX_SEARCH_RESULTS = 50;
const MAX_SNIPPET_CHARS = 240;
const MAX_FETCH_BYTES = 1024 * 1024; // 单次抓取上限 1MB
const FETCH_TIMEOUT_MS = 20000;
const MAX_FETCH_REDIRECTS = 3;

/** 把用户给的相对/绝对路径解析为工作区内的绝对路径；越界则抛错。 */
export function resolveInWorkspace(input: unknown): string {
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

export async function ensureWorkspace(): Promise<void> {
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
export async function assertRealPathInside(target: string): Promise<void> {
  await ensureWorkspace();
  const workspaceRoot = workspaceRootPath();
  const realRoot = await fs.realpath(workspaceRoot);
  const real = await realpathOrNearest(target);
  const rel = relative(realRoot, real);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new Error(`路径越界（符号链接指向工作区外）：只允许访问 ${workspaceRoot} 内`);
  }
}

export function workspaceRootPath(): string {
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
    description: '读取工作区内一个文本文件的内容（最多 256KB）。大文件会返回截断预览和继续处理建议。',
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
    const handle = await fs.open(file, 'r');
    try {
      const bytesToRead = Math.min(stat.size, MAX_READ_BYTES);
      const buffer = Buffer.alloc(bytesToRead);
      await handle.read(buffer, 0, bytesToRead, 0);
      const hasReplacement = buffer.toString('utf8').includes('\uFFFD');
      const truncated = stat.size > MAX_READ_BYTES;
      if (hasReplacement) {
        return {
          path: relative(workspaceRootPath(), file),
          size: stat.size,
          encoding: 'utf8',
          ok: false,
          diagnostic: '文件无法可靠按 UTF-8 解码，内容可能是二进制或其他编码。',
          suggestion: '请转换为 UTF-8 文本，或后续增加二进制/编码指定读取能力。',
          truncated,
        };
      }
      return {
        path: relative(workspaceRootPath(), file),
        size: stat.size,
        encoding: 'utf8',
        truncated,
        content: buffer.toString('utf8'),
        suggestion: truncated ? `文件超过 ${MAX_READ_BYTES} 字节，本次只返回开头预览；请用 search_files 定位片段或拆分文件。` : undefined,
      };
    } finally {
      await handle.close();
    }
  },
});

// ---- search_files（safe）：文件名 glob + 文本内容搜索 ----
toolRegistry.register({
  descriptor: {
    name: 'search_files',
    description: '在工作区内搜索文件名 glob 和文本内容，返回路径、匹配片段、大小与 mtime。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的起始目录，缺省为根目录' },
        glob: { type: 'string', description: '文件名 glob，例如 **/*.md 或 *.ts' },
        query: { type: 'string', description: '要搜索的文本内容；省略时只按文件名匹配' },
        maxResults: { type: 'integer', description: '最多返回结果数，默认 50，上限 50' },
      },
      additionalProperties: false,
    },
    riskLevel: 'safe',
  },
  async execute(args) {
    await ensureWorkspace();
    const root = resolveInWorkspace(typeof args.path === 'string' ? args.path : '.');
    await assertRealPathInside(root);
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error('search_files 的 path 必须是目录');
    const glob = typeof args.glob === 'string' && args.glob.trim() ? args.glob.trim() : '**/*';
    const query = typeof args.query === 'string' && args.query.length > 0 ? args.query : undefined;
    const maxResults = clampInteger(args.maxResults, 1, MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
    const matcher = createGlobMatcher(glob);
    const results: Array<Record<string, unknown>> = [];
    let scannedFiles = 0;
    let skippedLargeFiles = 0;

    for await (const file of walkFiles(root)) {
      if (scannedFiles >= MAX_SEARCH_FILES || results.length >= maxResults) break;
      scannedFiles += 1;
      const relativePath = relative(workspaceRootPath(), file) || '.';
      if (!matcher(relativePath)) continue;
      const fileStat = await fs.stat(file);
      const base = {
        path: relativePath,
        size: fileStat.size,
        mtime: fileStat.mtime.toISOString(),
      };
      if (!query) {
        results.push(base);
        continue;
      }
      if (fileStat.size > MAX_READ_BYTES) {
        skippedLargeFiles += 1;
        continue;
      }
      const content = await readUtf8Preview(file);
      const index = content.indexOf(query);
      if (index < 0) continue;
      results.push({
        ...base,
        match: {
          query,
          snippet: makeSnippet(content, index, query.length),
        },
      });
    }

    return {
      root: relative(workspaceRootPath(), root) || '.',
      glob,
      query,
      scannedFiles,
      skippedLargeFiles,
      truncated: scannedFiles >= MAX_SEARCH_FILES || results.length >= maxResults,
      results,
    };
  },
});

// ---- copy_file（caution，需审批）----
toolRegistry.register({
  descriptor: {
    name: 'copy_file',
    description: '在工作区内复制文件。目标存在时默认拒绝覆盖，除非 overwrite=true。',
    inputSchema: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string', description: '相对工作区的源文件路径' },
        targetPath: { type: 'string', description: '相对工作区的目标文件路径' },
        overwrite: { type: 'boolean', description: '是否覆盖已有目标文件，默认 false' },
      },
      required: ['sourcePath', 'targetPath'],
      additionalProperties: false,
    },
    riskLevel: 'caution',
  },
  async execute(args) {
    const source = resolveInWorkspace(args.sourcePath);
    const target = resolveInWorkspace(args.targetPath);
    await assertRealPathInside(source);
    await fs.mkdir(join(target, '..'), { recursive: true });
    await assertRealPathInside(target);
    const sourceStat = await fs.stat(source);
    if (!sourceStat.isFile()) throw new Error('sourcePath 不是文件');
    if (args.overwrite !== true && await pathExists(target)) throw new Error('targetPath 已存在；如需覆盖请显式传 overwrite=true');
    await fs.copyFile(source, target);
    return { sourcePath: relative(workspaceRootPath(), source), targetPath: relative(workspaceRootPath(), target), bytesCopied: sourceStat.size };
  },
});

// ---- move_file / rename_file（caution，需审批）----
const moveFileTool = {
  descriptor: {
    name: 'move_file',
    description: '在工作区内移动或重命名文件。目标存在时默认拒绝覆盖，除非 overwrite=true。',
    inputSchema: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string', description: '相对工作区的源文件路径' },
        targetPath: { type: 'string', description: '相对工作区的目标文件路径' },
        overwrite: { type: 'boolean', description: '是否覆盖已有目标文件，默认 false' },
      },
      required: ['sourcePath', 'targetPath'],
      additionalProperties: false,
    },
    riskLevel: 'caution' as const,
  },
  async execute(args: Record<string, unknown>) {
    const source = resolveInWorkspace(args.sourcePath);
    const target = resolveInWorkspace(args.targetPath);
    await assertRealPathInside(source);
    await fs.mkdir(join(target, '..'), { recursive: true });
    await assertRealPathInside(target);
    const sourceStat = await fs.stat(source);
    if (!sourceStat.isFile()) throw new Error('sourcePath 不是文件');
    if (args.overwrite !== true && await pathExists(target)) throw new Error('targetPath 已存在；如需覆盖请显式传 overwrite=true');
    await fs.rename(source, target);
    return { sourcePath: relative(workspaceRootPath(), source), targetPath: relative(workspaceRootPath(), target), bytesMoved: sourceStat.size };
  },
};
toolRegistry.register(moveFileTool);
toolRegistry.register({
  ...moveFileTool,
  descriptor: { ...moveFileTool.descriptor, name: 'rename_file', description: 'move_file 的别名：在工作区内重命名文件。' },
});

// ---- delete_file（dangerous，默认禁用）：移动到回收区，不永久删除 ----
toolRegistry.register({
  descriptor: {
    name: 'delete_file',
    description: '把工作区内文件移入工作区 .aurevoy-trash 回收区，不做永久删除。默认禁用，启用后仍需审批。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作区的待删除文件路径' } },
      required: ['path'],
      additionalProperties: false,
    },
    riskLevel: 'dangerous',
  },
  async execute(args) {
    const file = resolveInWorkspace(args.path);
    await assertRealPathInside(file);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('path 不是文件');
    const trashDir = resolveInWorkspace('.aurevoy-trash');
    await fs.mkdir(trashDir, { recursive: true });
    await assertRealPathInside(trashDir);
    const trashName = `${Date.now()}-${relative(workspaceRootPath(), file).replace(/[/\\:]/g, '_')}`;
    const trashPath = join(trashDir, trashName);
    await fs.rename(file, trashPath);
    return {
      path: relative(workspaceRootPath(), file),
      trashedPath: relative(workspaceRootPath(), trashPath),
      bytesMoved: stat.size,
    };
  },
});
toolRegistry.setEnabled('delete_file', false);

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
    description: '安全抓取一个 http(s) URL。最多 3 次重定向，拒绝本机/内网地址，HTML 会清洗后返回正文与链接。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: '要抓取的 http/https URL' } },
      required: ['url'],
      additionalProperties: false,
    },
    riskLevel: 'caution',
  },
  async execute(args) {
    const raw = readNonEmptyString(args.url, 'url');
    const fetched = await fetchWithPolicy(raw);
    const contentType = fetched.res.headers.get('content-type') ?? '';
    const metadata = {
      url: fetched.url.toString(),
      fetchedAt: new Date().toISOString(),
      status: fetched.res.status,
      contentType: contentType || null,
      redirects: fetched.redirects,
    };
    if (!isTextContentType(contentType)) {
      return {
        ...metadata,
        binary: true,
        body: null,
        contentLength: fetched.res.headers.get('content-length'),
        note: 'Content-Type 不是文本，未把二进制内容注入模型上下文。',
      };
    }
    const { body, truncated } = await readResponseText(fetched.res);
    if (isHtmlContentType(contentType) || /<html[\s>]/i.test(body)) {
      const cleaned = cleanHtml(body, fetched.url);
      return { ...metadata, truncated, cleanedText: cleaned.text, links: cleaned.links };
    }
    return { ...metadata, truncated, cleanedText: body };
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

// ---- create_artifact（safe）：只创建任务草稿产物，不写真实用户文件 ----
toolRegistry.register({
  descriptor: {
    name: 'create_artifact',
    description: '创建一个可预览、可确认的任务产物草稿。不会写入真实文件；需要用户确认后再 apply_artifact。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '产物名称，例如 SUMMARY.md 或 调研报告' },
        content: { type: 'string', description: '产物正文内容' },
        type: { type: 'string', enum: ['text', 'file', 'diff', 'url'], description: '产物类型，默认 text' },
        mimeType: { type: 'string', description: 'MIME 类型，例如 text/markdown' },
      },
      required: ['name', 'content'],
      additionalProperties: false,
    },
    riskLevel: 'safe',
  },
  async execute(args) {
    const name = readNonEmptyString(args.name, 'name');
    const content = readNonEmptyString(args.content, 'content');
    const type = readArtifactType(args.type);
    return {
      artifactDraft: {
        name,
        content,
        type,
        mimeType: typeof args.mimeType === 'string' ? args.mimeType : guessMimeType(name),
      },
    };
  },
});

// ---- ask_user（safe）：由 loop 接管暂停/等待，不在工具体内阻塞 ----
toolRegistry.register({
  descriptor: {
    name: 'ask_user',
    description:
      '当目标信息不足、路径不存在、格式或选择不明确时，向用户提出一个结构化追问并等待回复。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问用户的具体问题' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '可选答案列表；没有明确选项时可省略',
        },
        context: { type: 'string', description: '为什么需要追问的简短上下文' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    riskLevel: 'safe',
  },
  async execute() {
    throw new Error('ask_user 由 Agent 循环接管，不能直接执行');
  },
});

// ---- apply_artifact（dangerous）：审批后把已确认或草稿产物写入工作区文件 ----
toolRegistry.register({
  descriptor: {
    name: 'apply_artifact',
    description:
      '将已有 artifact 写入工作区内的目标文件。该工具会覆盖目标文件，必须先获得用户审批。',
    inputSchema: {
      type: 'object',
      properties: {
        artifactId: { type: 'string', description: '要应用的 artifact id' },
        path: { type: 'string', description: '相对工作区的写入路径' },
      },
      required: ['artifactId', 'path'],
      additionalProperties: false,
    },
    riskLevel: 'dangerous',
  },
  async execute(args, context) {
    const artifactId = readNonEmptyString(args.artifactId, 'artifactId');
    const path = readNonEmptyString(args.path, 'path');
    const task = context?.task;
    const artifact = task?.artifacts?.find((item) => item.id === artifactId);
    if (!artifact) throw new Error(`artifact 不存在: ${artifactId}`);
    if (artifact.status === 'rejected') throw new Error('artifact 已被拒绝，不能写入文件');
    const file = resolveInWorkspace(path);
    await fs.mkdir(join(file, '..'), { recursive: true });
    await assertRealPathInside(file);
    await fs.writeFile(file, artifact.content, 'utf8');
    return {
      artifactId,
      path: relative(workspaceRootPath(), file),
      bytesWritten: Buffer.byteLength(artifact.content),
    };
  },
});

// ---- execute_command（dangerous，默认禁用）：基础进程命令执行 ----
toolRegistry.register({
  descriptor: {
    name: 'execute_command',
    description:
      '在工作区内执行一个基础命令。使用 shell=false，不支持管道/重定向；默认禁用，需设置页显式开启。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '可执行文件名或绝对路径，例如 node' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '命令参数数组，不经过 shell 解析',
        },
        cwd: { type: 'string', description: '相对工作区的执行目录，缺省为工作区根' },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: '额外环境变量，只允许 envAllowlist 中的键',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    riskLevel: 'dangerous',
  },
  async execute(args, context) {
    const command = readNonEmptyString(args.command, 'command');
    const rawArgs = Array.isArray(args.args) ? args.args : [];
    if (rawArgs.some((item) => typeof item !== 'string')) throw new Error('args 必须是字符串数组');
    const env =
      args.env && typeof args.env === 'object' && !Array.isArray(args.env)
        ? Object.fromEntries(
            Object.entries(args.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
          )
        : undefined;
    return commandExecutor.execute(
      {
        command,
        args: rawArgs,
        cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
        env,
      },
      context?.abortSignal,
    );
  },
});

// execute_command 只有设置显式开启时才提供给模型，避免“可见但默认失败”的危险工具噪音。
toolRegistry.setEnabled('execute_command', config.sandbox.commandExecutionEnabled);

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} 必须是非空字符串`);
  return value;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function* walkFiles(root: string): AsyncGenerator<string> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.aurevoy-trash') continue;
    const path = join(root, entry.name);
    await assertRealPathInside(path);
    if (entry.isDirectory()) {
      yield* walkFiles(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

function createGlobMatcher(pattern: string): (path: string) => boolean {
  const normalized = pattern.replace(/\\/g, '/');
  const regex = new RegExp(`^${globToRegex(normalized)}$`);
  return (path: string) => regex.test(path.replace(/\\/g, '/'));
}

function globToRegex(pattern: string): string {
  let output = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === '*' && next === '*') {
      output += '.*';
      index += 1;
    } else if (char === '*') {
      output += '[^/]*';
    } else if (char === '?') {
      output += '[^/]';
    } else {
      output += escapeRegex(char);
    }
  }
  return output;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

async function readUtf8Preview(path: string): Promise<string> {
  const buffer = await fs.readFile(path);
  return buffer.toString('utf8');
}

function makeSnippet(content: string, index: number, length: number): string {
  const start = Math.max(0, index - Math.floor((MAX_SNIPPET_CHARS - length) / 2));
  const end = Math.min(content.length, start + MAX_SNIPPET_CHARS);
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`;
}

interface FetchPolicyResult {
  url: URL;
  res: Response;
  redirects: string[];
}

async function fetchWithPolicy(rawUrl: string): Promise<FetchPolicyResult> {
  let url = parseHttpUrl(rawUrl);
  const redirects: string[] = [];

  for (let redirectCount = 0; redirectCount <= MAX_FETCH_REDIRECTS; redirectCount += 1) {
    await assertPublicHttpTarget(url);
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!isRedirectStatus(res.status)) return { url, res, redirects };
    const location = res.headers.get('location');
    if (!location) return { url, res, redirects };
    if (redirectCount === MAX_FETCH_REDIRECTS) {
      throw new Error(`重定向次数超过上限 ${MAX_FETCH_REDIRECTS}`);
    }
    url = parseHttpUrl(new URL(location, url).toString());
    redirects.push(url.toString());
  }

  throw new Error(`重定向次数超过上限 ${MAX_FETCH_REDIRECTS}`);
}

function parseHttpUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`非法 URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只允许 http/https 协议');
  }
  return parsed;
}

async function assertPublicHttpTarget(url: URL): Promise<void> {
  if (isHttpFetchPrivateHostAllowed(url.hostname)) return;
  if (isPrivateHostname(url.hostname)) throw new Error(`拒绝访问本机或私有地址: ${url.hostname}`);
  const records = await lookup(url.hostname, { all: true, verbatim: true });
  if (records.length === 0) throw new Error(`无法解析主机: ${url.hostname}`);
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw new Error(`拒绝访问本机或私有地址: ${record.address}`);
    }
  }
}

function isHttpFetchPrivateHostAllowed(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return config.network.httpFetchPrivateHostAllowlist.includes(normalized);
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized.endsWith('.localhost') || isPrivateAddress(normalized);
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.replace(/^::ffff:/i, '');
  if (isPrivateIpv4(normalized)) return true;
  return isPrivateIpv6(address);
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('ff')
  );
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isTextContentType(contentType: string): boolean {
  const value = contentType.toLowerCase();
  return (
    value.startsWith('text/') ||
    value.includes('application/json') ||
    value.includes('application/xml') ||
    value.includes('application/xhtml+xml') ||
    value.includes('application/javascript')
  );
}

function isHtmlContentType(contentType: string): boolean {
  const value = contentType.toLowerCase();
  return value.includes('text/html') || value.includes('application/xhtml+xml');
}

async function readResponseText(res: Response): Promise<{ body: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let body = '';
  let truncated = false;
  if (!reader) return { body, truncated };
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
  return { body, truncated };
}

function cleanHtml(html: string, baseUrl: URL): { text: string; links: Array<{ text: string; url: string }> } {
  const withoutDangerousBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<object[\s\S]*?<\/object>/gi, ' ')
    .replace(/<embed[\s\S]*?>/gi, ' ');
  const links = extractLinks(withoutDangerousBlocks, baseUrl);
  const text = decodeHtmlEntities(
    withoutDangerousBlocks
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
  return { text, links };
}

function extractLinks(html: string, baseUrl: URL): Array<{ text: string; url: string }> {
  const links: Array<{ text: string; url: string }> = [];
  const pattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (;;) {
    const match = pattern.exec(html);
    if (!match || links.length >= 30) break;
    try {
      const url = new URL(decodeHtmlEntities(match[1]), baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      const text = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      links.push({ text: text.slice(0, 120), url: url.toString() });
    } catch {
      // 忽略无法解析的 href，避免单个坏链接导致抓取失败。
    }
  }
  return links;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

function readArtifactType(value: unknown): TaskArtifact['type'] {
  return value === 'file' || value === 'diff' || value === 'url' || value === 'text' ? value : 'text';
}

function guessMimeType(name: string): string {
  if (/\.md$/i.test(name)) return 'text/markdown';
  if (/\.json$/i.test(name)) return 'application/json';
  if (/\.html?$/i.test(name)) return 'text/html';
  return 'text/plain';
}
