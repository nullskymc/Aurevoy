import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { MemoryCategory, MemoryEntry, TaskArtifact } from '@aurevoy/shared';
import { config } from '../config.js';
import { toolRegistry } from './registry.js';
import { memoryStore } from '../store/db.js';
import { commandExecutor } from '../sandbox/command-executor.js';
import { runSubTask } from '../agent/subagent.js';

/**
 * 内置基础工具：文件读写、目录列举、HTTP 抓取、搜索。
 *
 * 安全约束：
 * - 路径校验在 Node.js 层完成（resolveInWorkspace + assertRealPathInside）。
 * - 实际读写/搜索操作使用系统命令（dd / grep / find / sed），
 *   通过 execFile（非 shell）传参，避免 shell 注入。
 * - 跨平台：macOS 优先，BSD 系命令。
 */

const MAX_READ_BYTES = 256 * 1024;
const MAX_SEARCH_RESULTS = 50;
const MAX_SNIPPET_CHARS = 240;
const MAX_FETCH_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 20000;
const MAX_FETCH_REDIRECTS = 3;
const MAX_CONTEXT_LINES = 5;
const MAX_GREP_MATCHES = 200;
const DEFAULT_GREP_MATCHES = 50;

// ---- 路径安全校验（Node.js 层，命令执行前）----

/** 检查目标路径是否在受信任的外部路径范围内（用户拖拽/选择的文件/目录）。 */
export function isInsideExternalPath(target: string, externalPaths?: string[]): boolean {
  if (!externalPaths || externalPaths.length === 0) return false;
  const resolved = resolve(target);
  for (const ext of externalPaths) {
    const extResolved = resolve(ext);
    if (resolved === extResolved) return true;
    if (resolved.startsWith(`${extResolved}/`)) return true;
  }
  return false;
}

export function resolveInWorkspace(
  input: unknown,
  workspaceRoot: string,
  externalPaths?: string[],
): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('path 必须是非空字符串');
  }
  const target = isAbsolute(input) ? resolve(input) : resolve(workspaceRoot, input);

  // 受信任外部路径（用户拖拽文件/目录）放行
  if (isInsideExternalPath(target, externalPaths)) return target;

  const rel = relative(workspaceRoot, target);
  if (rel === '') return target;
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越界：只允许访问工作区目录内 (${workspaceRoot})`);
  }
  return target;
}

export async function ensureWorkspace(workspaceRoot: string): Promise<void> {
  await fs.mkdir(workspaceRoot, { recursive: true });
}

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

export async function assertRealPathInside(
  target: string,
  workspaceRoot: string,
  externalPaths?: string[],
): Promise<void> {
  // 受信任外部路径放行
  if (isInsideExternalPath(target, externalPaths)) return;

  await ensureWorkspace(workspaceRoot);
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

function rootAndExternals(context?: {
  workspaceDir?: string;
  externalPaths?: string[];
}): { root: string; externalPaths: string[] | undefined } {
  return {
    root: context?.workspaceDir ?? workspaceRootPath(),
    externalPaths: context?.externalPaths,
  };
}

// ---- 系统命令执行（execFile，非 shell）----

/**
 * 执行系统命令，返回 stdout。
 * grep 退出码 1（无匹配）视为正常空结果，不抛错。
 */
function execCmd(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: MAX_READ_BYTES * 4, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 1 && command === 'grep') { resolve(''); return; }
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

// ---- 工具函数 ----

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} 必须是非空字符串`);
  return value;
}

async function pathExists(path: string): Promise<boolean> {
  try { await fs.stat(path); return true; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; throw err; }
}

/** glob 最后一个路径片段转为 find -name 模式；'**​/*' 返回 null 表示不过滤 */
function globToFindName(glob: string): string | null {
  const last = glob.split('/').pop()!;
  if (last === '**' || last === '*') return null;
  return last;
}

/** 以匹配位置为中心截取片段 */
function makeSnippet(line: string, query: string): string {
  const idx = line.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, idx - Math.floor((MAX_SNIPPET_CHARS - query.length) / 2));
  const end = Math.min(line.length, start + MAX_SNIPPET_CHARS);
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
}

// ---- list_directory（safe）：ls -1p ----
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
  async execute(args, context) {
    const { root, externalPaths: extPaths } = rootAndExternals(context);
    await ensureWorkspace(root);
    const dir = resolveInWorkspace((args.path as string | undefined) ?? '.', root, extPaths);
    await assertRealPathInside(dir, root, extPaths);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return {
      dir: relative(root, dir) || '.',
      entries: entries
        .filter((e) => e.name !== '.aurevoy-trash')
        .map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })),
    };
  },
});

// ---- read_file（safe）----
// 三种模式：
// 1. 普通（offset/limit）→ dd if=file bs=1 skip=N count=M
// 2. grep → grep -n -C <n> <pattern> <file>
// 3. 兼容旧调用 → 默认 offset=0 limit=256KB
toolRegistry.register({
  descriptor: {
    name: 'read_file',
    description:
      '读取工作区内文本文件。dd 分片读取（offset/limit）或 grep 按行搜索（grep/contextLines）。' +
      '大文件用 offset 分片，或 grep 定位关键行。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        offset: { type: 'integer', description: '起始字节偏移（0-based），默认 0' },
        limit: { type: 'integer', description: '最大读取字节数，默认 262144，上限 262144' },
        grep: { type: 'string', description: '按行过滤：只返回包含此字符串的行' },
        caseSensitive: { type: 'boolean', description: 'grep 是否区分大小写，默认 false' },
        contextLines: { type: 'integer', description: 'grep 上下文行数，默认 0，上限 5' },
        maxMatches: { type: 'integer', description: 'grep 最多返回匹配数，默认 50，上限 200' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    riskLevel: 'safe',
  },
  async execute(args, context) {
    const { root, externalPaths: extPaths } = rootAndExternals(context);
    const file = resolveInWorkspace(args.path, root, extPaths);
    await assertRealPathInside(file, root, extPaths);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('目标不是文件');

    const grep = typeof args.grep === 'string' && args.grep.length > 0 ? args.grep : undefined;

    // ---- grep 模式 ----
    if (grep) {
      const caseSensitive = args.caseSensitive === true;
      const contextLines = clampInteger(args.contextLines, 0, MAX_CONTEXT_LINES, 0);
      const maxMatches = clampInteger(args.maxMatches, 1, MAX_GREP_MATCHES, DEFAULT_GREP_MATCHES);

      const grepArgs = ['-n'];
      if (!caseSensitive) grepArgs.push('-i');
      if (contextLines > 0) grepArgs.push(`-C${contextLines}`);
      grepArgs.push('-m', String(maxMatches + 1), '--', grep, file);

      const out = await execCmd('grep', grepArgs);
      const lines = out.trim().split('\n').filter(Boolean);
      const matchCount = lines.length;
      const truncated = matchCount > maxMatches;
      const displayLines = truncated ? lines.slice(0, maxMatches) : lines;

      // 解析 grep -n 输出：行号:内容
      const matches = displayLines.map((l) => {
        const colon = l.indexOf(':');
        const lineNum = Number(colon >= 0 ? l.slice(0, colon) : 0);
        const text = colon >= 0 ? l.slice(colon + 1) : l;
        return { line: lineNum, text };
      });

      return {
        path: relative(root, file),
        size: stat.size,
        grep,
        caseSensitive,
        contextLines,
        matchCount,
        matches,
        truncated,
        suggestion: truncated
          ? `匹配数 ${matchCount} 超过上限 ${maxMatches}，仅返回前 ${matches.length} 条。`
          : matchCount === 0
            ? '未找到匹配行。'
            : undefined,
      };
    }

    // ---- 普通模式：dd 分片读取 ----
    const offset = clampInteger(args.offset, 0, stat.size, 0);
    const limit = clampInteger(args.limit, 1, MAX_READ_BYTES, MAX_READ_BYTES);
    const bytesToRead = Math.min(stat.size - offset, limit);

    const out = await execCmd('dd', ['if=' + file, 'bs=1', `skip=${offset}`, `count=${bytesToRead}`, 'status=none']);
    const bytesRead = Buffer.byteLength(out);
    const hasReplacement = out.includes('�');
    const truncated = offset + bytesRead < stat.size;

    if (hasReplacement) {
      return {
        path: relative(root, file),
        size: stat.size,
        encoding: 'utf8',
        ok: false,
        diagnostic: '文件无法可靠按 UTF-8 解码，内容可能是二进制或其他编码。',
        suggestion: '请转换为 UTF-8 文本。',
        offset,
        bytesRead,
        truncated,
      };
    }

    return {
      path: relative(root, file),
      size: stat.size,
      encoding: 'utf8',
      offset,
      bytesRead,
      truncated,
      content: out,
      suggestion: truncated
        ? `已读取 ${offset}-${offset + bytesRead} / ${stat.size} 字节；用 offset=${offset + bytesRead} 继续。`
        : undefined,
    };
  },
});

// ---- search_files（safe）：find + grep ----
toolRegistry.register({
  descriptor: {
    name: 'search_files',
    description:
      '在工作区内搜索文件：find 按 glob 匹配文件名，grep 按行搜索内容。' +
      '返回路径、匹配行号、片段、大小与 mtime。默认不区分大小写。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的起始目录，缺省为根目录' },
        glob: { type: 'string', description: '文件名 glob，例如 *.ts 或 *.md' },
        query: { type: 'string', description: '要搜索的文本内容；省略时只按文件名匹配' },
        caseSensitive: { type: 'boolean', description: '是否区分大小写，默认 false（不区分）' },
        maxResults: { type: 'integer', description: '最多返回结果数，默认 50，上限 50' },
      },
      additionalProperties: false,
    },
    riskLevel: 'safe',
  },
  async execute(args, context) {
    const { root, externalPaths: extPaths } = rootAndExternals(context);
    await ensureWorkspace(root);
    const searchRoot = resolveInWorkspace(typeof args.path === 'string' ? args.path : '.', root, extPaths);
    await assertRealPathInside(searchRoot, root, extPaths);
    const stat = await fs.stat(searchRoot).catch(() => null);
    if (!stat?.isDirectory()) throw new Error('search_files 的 path 必须是目录');
    const glob = typeof args.glob === 'string' && args.glob.trim() ? args.glob.trim() : '**/*';
    const query = typeof args.query === 'string' && args.query.length > 0 ? args.query : undefined;
    const caseSensitive = args.caseSensitive === true;
    const maxResults = clampInteger(args.maxResults, 1, MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS);

    const namePattern = globToFindName(glob);

    if (!query) {
      // 仅按文件名匹配：find
      const findArgs = [searchRoot, '-type', 'f'];
      if (namePattern) findArgs.push('-name', namePattern);
      const out = await execCmd('find', findArgs);
      const files = out.trim().split('\n').filter(Boolean).slice(0, maxResults);

      const results: Array<Record<string, unknown>> = [];
      for (const file of files) {
        try {
          const s = await fs.stat(file);
          results.push({
            path: relative(root, file),
            size: s.size,
            mtime: s.mtime.toISOString(),
          });
        } catch { /* skip */ }
      }

      return {
        root: relative(root, searchRoot) || '.',
        glob,
        scannedFiles: files.length,
        truncated: files.length >= maxResults,
        results,
      };
    }

    // 按内容搜索：find + grep
    const findArgs = [searchRoot, '-type', 'f'];
    if (namePattern) findArgs.push('-name', namePattern);
    // -m 1 每个文件只取第一个匹配；-n 行号；-i 不区分大小写
    const grepArgs = ['-n', '-m', '1'];
    if (!caseSensitive) grepArgs.push('-i');
    grepArgs.push('--', query);
    findArgs.push('-exec', 'grep', ...grepArgs, '{}', '+');

    const out = await execCmd('find', findArgs);
    const lines = out.trim().split('\n').filter(Boolean).slice(0, maxResults);

    const results: Array<Record<string, unknown>> = [];
    for (const l of lines) {
      const colon = l.indexOf(':');
      const filePath = colon >= 0 ? l.slice(0, colon) : l;
      const rest = colon >= 0 ? l.slice(colon + 1) : '';
      const colon2 = rest.indexOf(':');
      const lineNum = Number(colon2 >= 0 ? rest.slice(0, colon2) : 0);
      const text = colon2 >= 0 ? rest.slice(colon2 + 1) : rest;

      try {
        const s = await fs.stat(filePath);
        results.push({
          path: relative(root, filePath),
          size: s.size,
          mtime: s.mtime.toISOString(),
          match: {
            query,
            caseSensitive,
            line: lineNum,
            snippet: makeSnippet(text, query),
          },
        });
      } catch { /* skip */ }
    }

    return {
      root: relative(root, searchRoot) || '.',
      glob,
      query,
      caseSensitive,
      scannedFiles: lines.length,
      truncated: lines.length >= maxResults,
      results,
    };
  },
});

// ---- copy_file（caution）----
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
  async execute(args, context) {
    const { root, externalPaths: extPaths } = rootAndExternals(context);
    const source = resolveInWorkspace(args.sourcePath, root, extPaths);
    const target = resolveInWorkspace(args.targetPath, root, extPaths);
    await assertRealPathInside(source, root, extPaths);
    await fs.mkdir(join(target, '..'), { recursive: true });
    await assertRealPathInside(target, root, extPaths);
    const sourceStat = await fs.stat(source);
    if (!sourceStat.isFile()) throw new Error('sourcePath 不是文件');
    if (args.overwrite !== true && await pathExists(target)) throw new Error('targetPath 已存在；如需覆盖请显式传 overwrite=true');
    await fs.copyFile(source, target);
    return { sourcePath: relative(root, source), targetPath: relative(root, target), bytesCopied: sourceStat.size };
  },
});

// ---- move_file / rename_file（caution）----
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
  async execute(args: Record<string, unknown>, context?: { workspaceDir?: string }) {
    const { root, externalPaths: extPaths } = rootAndExternals(context);
    const source = resolveInWorkspace(args.sourcePath, root, extPaths);
    const target = resolveInWorkspace(args.targetPath, root, extPaths);
    await assertRealPathInside(source, root, extPaths);
    await fs.mkdir(join(target, '..'), { recursive: true });
    await assertRealPathInside(target, root, extPaths);
    const sourceStat = await fs.stat(source);
    if (!sourceStat.isFile()) throw new Error('sourcePath 不是文件');
    if (args.overwrite !== true && await pathExists(target)) throw new Error('targetPath 已存在；如需覆盖请显式传 overwrite=true');
    await fs.rename(source, target);
    return { sourcePath: relative(root, source), targetPath: relative(root, target), bytesMoved: sourceStat.size };
  },
};
toolRegistry.register(moveFileTool);
toolRegistry.register({
  ...moveFileTool,
  descriptor: { ...moveFileTool.descriptor, name: 'rename_file', description: 'move_file 的别名：在工作区内重命名文件。' },
});

// ---- edit_file（dangerous）：P6 Diff 编辑 ----
toolRegistry.register({
  descriptor: {
    name: 'edit_file',
    description:
      '在工作区内精确替换文件中的一段文本。匹配必须唯一，否则报错。' +
      '这是推荐的编辑方式——比 write_file 更精确，且不丢失文件其他部分。' +
      '要替换的文本必须与文件内容完全匹配（含缩进）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        oldString: { type: 'string', description: '要替换的文本（在文件中必须唯一匹配）' },
        newString: { type: 'string', description: '替换后的文本' },
        replaceAll: { type: 'boolean', description: '是否替换所有匹配（默认 false）' },
      },
      required: ['path', 'oldString', 'newString'],
      additionalProperties: false,
    },
    riskLevel: 'dangerous',
    fallback: {
      tools: ['write_file'],
      message: 'edit_file 匹配失败。改用 write_file 全量写入，或调整 oldString 使其唯一。',
    },
  },
  async execute(args, context) {
    const { root, externalPaths: extPaths } = rootAndExternals(context);
    const file = resolveInWorkspace(args.path, root, extPaths);
    await assertRealPathInside(file, root, extPaths);
    const oldStr = readNonEmptyString(args.oldString, 'oldString');
    const newStr = String(args.newString ?? '');
    if (oldStr === newStr) throw new Error('oldString 和 newString 相同，无需替换');

    const content = await fs.readFile(file, 'utf8');
    const occurrences = content.split(oldStr).length - 1;

    if (occurrences === 0) {
      throw new Error(
        `未在文件中找到 oldString。请确保 oldString 与文件内容完全匹配（含缩进和空格）。` +
        `可以先 read_file 确认当前内容。`,
      );
    }

    if (occurrences > 1 && args.replaceAll !== true) {
      throw new Error(
        `oldString 在文件中出现了 ${occurrences} 次，但 replaceAll 未设为 true。` +
        `请扩展 oldString 使其唯一（含更多上下文），或设置 replaceAll=true 替换全部。`,
      );
    }

    const newContent = args.replaceAll === true
      ? content.replaceAll(oldStr, newStr)
      : content.replace(oldStr, newStr);

    await fs.writeFile(file, newContent, 'utf8');

    return {
      path: relative(root, file),
      replaced: args.replaceAll === true ? occurrences : 1,
      bytesBefore: Buffer.byteLength(content),
      bytesAfter: Buffer.byteLength(newContent),
    };
  },
});

// ---- delete_file（dangerous，默认禁用）----
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
  async execute(args, context) {
    const { root, externalPaths: extPaths } = rootAndExternals(context);
    const file = resolveInWorkspace(args.path, root, extPaths);
    await assertRealPathInside(file, root, extPaths);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('path 不是文件');
    const trashDir = resolveInWorkspace('.aurevoy-trash', root, extPaths);
    await fs.mkdir(trashDir, { recursive: true });
    await assertRealPathInside(trashDir, root, extPaths);
    const trashName = `${Date.now()}-${relative(root, file).replace(/[/\\:]/g, '_')}`;
    const trashPath = join(trashDir, trashName);
    await fs.rename(file, trashPath);
    return { path: relative(root, file), trashedPath: relative(root, trashPath), bytesMoved: stat.size };
  },
});
toolRegistry.setEnabled('delete_file', false);

// ---- write_file（dangerous）----
toolRegistry.register({
  descriptor: {
    name: 'write_file',
    description:
      '在工作区内写入文本文件。默认覆盖；传 mode=append 则在文件末尾追加。自动创建父目录。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        content: { type: 'string', description: '要写入的文本内容' },
        mode: { type: 'string', enum: ['overwrite', 'append'], description: '写入模式：overwrite（默认）或 append' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    riskLevel: 'dangerous',
  },
  async execute(args, context) {
    const { root, externalPaths: extPaths } = rootAndExternals(context);
    const file = resolveInWorkspace(args.path, root, extPaths);
    const content = typeof args.content === 'string' ? args.content : String(args.content ?? '');
    await fs.mkdir(join(file, '..'), { recursive: true });
    await assertRealPathInside(file, root, extPaths);
    if (args.mode === 'append') {
      await fs.appendFile(file, content, 'utf8');
    } else {
      await fs.writeFile(file, content, 'utf8');
    }
    return { path: relative(root, file), bytesWritten: Buffer.byteLength(content), mode: args.mode === 'append' ? 'append' : 'overwrite' };
  },
});

// ---- http_fetch（caution）----
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

// ---- remember（safe）----
const MEMORY_CATEGORIES: readonly MemoryCategory[] = ['preference', 'directory', 'model', 'habit', 'fact', 'other'];
const MAX_MEMORY_CONTENT = 2000;

/** P5: Jaccard 相似度（基于关键词集合）。 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

/** P5: 在已有记忆中查找相似内容（去重）。相似度 > 0.7 视为重复。 */
function findDuplicateMemory(
  newContent: string,
  existingMemories: MemoryEntry[],
): MemoryEntry | null {
  const newKeywords = new Set(
    newContent.toLowerCase().split(/[^a-z0-9一-鿿]+/i).filter((t) => t.length >= 2),
  );
  if (newKeywords.size === 0) return null;

  for (const existing of existingMemories) {
    const existingKeywords = new Set(
      existing.content.toLowerCase().split(/[^a-z0-9一-鿿]+/i).filter((t) => t.length >= 2),
    );
    const similarity = jaccardSimilarity(newKeywords, existingKeywords);
    if (similarity > 0.7) return existing;
  }
  return null;
}

toolRegistry.register({
  descriptor: {
    name: 'remember',
    description:
      '把一条关于用户的长期事实记下来，跨会话保留（如偏好、常用目录、工作习惯）。' +
      '使用 [[name-slug]] 语法引用其他记忆。' +
      '仅在信息明确且对将来有用时使用；不要记录临时上下文或敏感隐私。' +
      '用户可随时在记忆面板查看、编辑、停用或删除你记下的内容。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要长期记住的内容（一句自然语言）。可使用 [[name-slug]] 引用其他记忆。' },
        category: { type: 'string', enum: [...MEMORY_CATEGORIES], description: '分类：preference/directory/model/habit/fact/other' },
        confidence: { type: 'number', description: '你对这条记忆的置信度 0~1（默认 0.7）' },
        nameSlug: { type: 'string', description: 'URL slug，用于被其他记忆通过 [[slug]] 引用' },
        why: { type: 'string', description: '为什么记录这条记忆' },
        howToApply: { type: 'string', description: '什么情况下应该使用这条记忆' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    riskLevel: 'safe',
  },
  async execute(args, context) {
    const content = typeof args.content === 'string' ? args.content.trim() : '';
    if (!content) throw new Error('content 必须是非空字符串');
    if (content.length > MAX_MEMORY_CONTENT) throw new Error(`记忆内容过长（上限 ${MAX_MEMORY_CONTENT} 字符）`);
    const category: MemoryCategory =
      typeof args.category === 'string' && MEMORY_CATEGORIES.includes(args.category as MemoryCategory)
        ? (args.category as MemoryCategory) : 'other';
    let confidence = typeof args.confidence === 'number' ? args.confidence : 0.7;
    if (!Number.isFinite(confidence)) confidence = 0.7;
    confidence = Math.min(1, Math.max(0, confidence));
    const nameSlug = typeof args.nameSlug === 'string' && args.nameSlug.trim()
      ? args.nameSlug.trim().toLowerCase().replace(/\s+/g, '-')
      : undefined;
    const why = typeof args.why === 'string' ? args.why.trim() : undefined;
    const howToApply = typeof args.howToApply === 'string' ? args.howToApply.trim() : undefined;
    const now = new Date().toISOString();

    // P5: 去重检查
    const duplicate = findDuplicateMemory(content, memoryStore.list());
    if (duplicate) {
      const updated = memoryStore.update(duplicate.id, {
        content,
        confidence: Math.max(duplicate.confidence, confidence),
        nameSlug: nameSlug ?? duplicate.nameSlug,
        why: why ?? duplicate.why,
        howToApply: howToApply ?? duplicate.howToApply,
      });
      return {
        stored: true,
        id: duplicate.id,
        updated: true,
        category: updated?.category ?? duplicate.category,
        confidence: updated?.confidence ?? duplicate.confidence,
        note: '已更新已有记忆（内容相似度 > 70%）',
      };
    }

    const entry: MemoryEntry = {
      id: randomUUID(),
      category,
      content,
      confidence,
      enabled: true,
      source: { origin: 'agent', taskId: context?.taskId, taskGoal: context?.taskGoal, createdAt: now },
      nameSlug,
      why,
      howToApply,
      createdAt: now,
      updatedAt: now,
    };
    memoryStore.create(entry);
    return { stored: true, id: entry.id, category, confidence, note: '已记入长期记忆，用户可在记忆面板管理。' };
  },
});

// ---- create_artifact（safe）----
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
    return { artifactDraft: { name, content, type, mimeType: typeof args.mimeType === 'string' ? args.mimeType : guessMimeType(name) } };
  },
});

// ---- ask_user（safe）：由 loop 接管 ----
toolRegistry.register({
  descriptor: {
    name: 'ask_user',
    description: '当目标信息不足、路径不存在、格式或选择不明确时，向用户提出一个结构化追问并等待回复。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问用户的具体问题' },
        options: { type: 'array', items: { type: 'string' }, description: '可选答案列表；没有明确选项时可省略' },
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

// ---- apply_artifact（dangerous）----
toolRegistry.register({
  descriptor: {
    name: 'apply_artifact',
    description: '将已有 artifact 写入工作区内的目标文件。该工具会覆盖目标文件，必须先获得用户审批。',
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
    const { root, externalPaths: extPaths } = rootAndExternals(context);
    const artifactId = readNonEmptyString(args.artifactId, 'artifactId');
    const path = readNonEmptyString(args.path, 'path');
    const task = context?.task;
    const artifact = task?.artifacts?.find((item) => item.id === artifactId);
    if (!artifact) throw new Error(`artifact 不存在: ${artifactId}`);
    if (artifact.status === 'rejected') throw new Error('artifact 已被拒绝，不能写入文件');
    const file = resolveInWorkspace(path, root, extPaths);
    await fs.mkdir(join(file, '..'), { recursive: true });
    await assertRealPathInside(file, root, extPaths);
    await fs.writeFile(file, artifact.content, 'utf8');
    return { artifactId, path: relative(root, file), bytesWritten: Buffer.byteLength(artifact.content) };
  },
});

// ---- execute_command（dangerous，默认禁用）----
toolRegistry.register({
  descriptor: {
    name: 'execute_command',
    description: '在工作区内执行一个基础命令。使用 shell=false，不支持管道/重定向；默认禁用，需设置页显式开启。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '可执行文件名或绝对路径，例如 node' },
        args: { type: 'array', items: { type: 'string' }, description: '命令参数数组，不经过 shell 解析' },
        cwd: { type: 'string', description: '相对工作区的执行目录，缺省为工作区根' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: '额外环境变量，只允许 envAllowlist 中的键' },
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
        ? Object.fromEntries(Object.entries(args.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : undefined;
    return commandExecutor.execute(
      { command, args: rawArgs, cwd: typeof args.cwd === 'string' ? args.cwd : undefined, env },
      context?.abortSignal,
      context?.workspaceDir,
    );
  },
});
toolRegistry.setEnabled('execute_command', config.sandbox.commandExecutionEnabled);

// ---- HTTP 抓取工具函数 ----

async function fetchWithPolicy(rawUrl: string): Promise<{ url: URL; res: Response; redirects: string[] }> {
  let url = parseHttpUrl(rawUrl);
  const redirects: string[] = [];
  for (let i = 0; i <= MAX_FETCH_REDIRECTS; i++) {
    await assertPublicHttpTarget(url);
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!isRedirectStatus(res.status)) return { url, res, redirects };
    const location = res.headers.get('location');
    if (!location) return { url, res, redirects };
    if (i === MAX_FETCH_REDIRECTS) throw new Error(`重定向次数超过上限 ${MAX_FETCH_REDIRECTS}`);
    url = parseHttpUrl(new URL(location, url).toString());
    redirects.push(url.toString());
  }
  throw new Error(`重定向次数超过上限 ${MAX_FETCH_REDIRECTS}`);
}

function parseHttpUrl(raw: string): URL {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error(`非法 URL: ${raw}`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('只允许 http/https 协议');
  return parsed;
}

async function assertPublicHttpTarget(url: URL): Promise<void> {
  if (isHttpFetchPrivateHostAllowed(url.hostname)) return;
  if (isPrivateHostname(url.hostname)) throw new Error(`拒绝访问本机或私有地址: ${url.hostname}`);
  const records = await lookup(url.hostname, { all: true, verbatim: true });
  if (records.length === 0) throw new Error(`无法解析主机: ${url.hostname}`);
  for (const r of records) { if (isPrivateAddress(r.address)) throw new Error(`拒绝访问本机或私有地址: ${r.address}`); }
}

function isHttpFetchPrivateHostAllowed(hostname: string): boolean {
  return config.network.httpFetchPrivateHostAllowlist.includes(hostname.replace(/^\[|\]$/g, '').toLowerCase());
}

function isPrivateHostname(hostname: string): boolean {
  const n = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return n === 'localhost' || n.endsWith('.localhost') || isPrivateAddress(n);
}

function isPrivateAddress(address: string): boolean {
  const n = address.replace(/^::ffff:/i, '');
  return isPrivateIpv4(n) || isPrivateIpv6(address);
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function isPrivateIpv6(address: string): boolean {
  const n = address.toLowerCase();
  return n === '::1' || n === '::' || n.startsWith('fc') || n.startsWith('fd') || n.startsWith('fe80:') || n.startsWith('ff');
}

function isRedirectStatus(s: number): boolean { return s === 301 || s === 302 || s === 303 || s === 307 || s === 308; }

function isTextContentType(ct: string): boolean {
  const v = ct.toLowerCase();
  return v.startsWith('text/') || v.includes('application/json') || v.includes('application/xml') ||
    v.includes('application/xhtml+xml') || v.includes('application/javascript');
}

function isHtmlContentType(ct: string): boolean {
  const v = ct.toLowerCase();
  return v.includes('text/html') || v.includes('application/xhtml+xml');
}

async function readResponseText(res: Response): Promise<{ body: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let received = 0, body = '', truncated = false;
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
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ').replace(/<object[\s\S]*?<\/object>/gi, ' ')
    .replace(/<embed[\s\S]*?>/gi, ' ');
  const links = extractLinks(withoutDangerousBlocks, baseUrl);
  const text = decodeHtmlEntities(
    withoutDangerousBlocks
      .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|section|article|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
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
    } catch { /* skip bad href */ }
  }
  return links;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number.parseInt(d, 10)));
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

// ---- delegate_task（safe）：P7 子代理委托 ----
const DEFAULT_SUBAGENT_TOOLS = ['list_directory', 'read_file', 'search_files', 'get_current_time'];

toolRegistry.register({
  descriptor: {
    name: 'delegate_task',
    description:
      '将独立子任务委托给另一个 Agent 执行。适用于：' +
      '同时搜索多个目录、并发读取多个文件、独立子分析。' +
      '子代理默认只有只读权限，无权写入文件。' +
      '可同时发起多个 delegate_task 调用实现并行子代理。',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '子任务的简要目标（一句话）' },
        prompt: { type: 'string', description: '给子代理的详细指令' },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: `允许子代理使用的工具（默认只有只读工具：${DEFAULT_SUBAGENT_TOOLS.join(', ')}）`,
        },
      },
      required: ['goal', 'prompt'],
      additionalProperties: false,
    },
    riskLevel: 'safe',
    executionPolicy: { parallelizable: true },
  },
  async execute(args, context) {
    const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!goal || !prompt) throw new Error('goal 和 prompt 必须是非空字符串');

    const tools = Array.isArray(args.tools)
      ? (args.tools as unknown[]).filter((t): t is string => typeof t === 'string')
      : undefined;

    const result = await runSubTask({
      goal,
      prompt,
      allowedTools: tools,
      workspaceDir: context?.workspaceDir ?? process.cwd(),
    });

    return {
      ok: result.ok,
      subTaskGoal: goal,
      content: result.content,
      toolCallCount: result.toolCallCount,
      iterations: result.iterations,
      error: result.error,
      note: result.ok
        ? `子代理完成，${result.iterations} 轮，${result.toolCallCount} 次工具调用。`
        : `子代理失败：${result.error ?? '未知错误'}`,
    };
  },
});