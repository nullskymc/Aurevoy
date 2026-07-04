/**
 * 行级视口 + 新三件套写入原语。
 *
 * 设计思路：
 * 提供类似 IDE 编辑器的行级文件操作体验。
 * 模型通过 open_file 定位文件 → scroll 浏览 → edit_lines 精准修改，
 * 形成完整的"定位-浏览-编辑"闭环。
 *
 * 读取（Read）：
 * - open_file：打开文件并定位到指定行，返回一个行窗口（视口）
 * - scroll：在已打开的文件中上下滚动视口
 * - search_grep：全局只读文本搜索（类似 grep -rn）
 *
 * 写入（Write）三件套：
 * - write_file：原子全量写（≤500KB），新建或覆盖
 * - edit_lines：行级精确替换（≤2000行/128KB），局部编辑
 * - session_open / session_write / session_close：分批构建大文件
 *
 * 辅助：
 * - create_file：新建空文件
 * - append_file：尾部追加（≤2000行/128KB）
 *
 * 工程约束：
 * - 行号均采用 1-indexed（第 1 行 = 文件开头）
 * - 视口 = 目标行前后各 VIEWPORT_CONTEXT_LINES 行
 * - 路径校验复用 builtins.ts 的 resolveInWorkspace / assertRealPathInside
 * - 所有工具无服务端状态（session 状态驻留在内存 Map 中，进程级失效）
 * - 任何写入操作都通过 write(tmp) → rename 实现原子性
 */

import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';

import { toolRegistry } from './registry.js';
import {
  resolveInWorkspace,
  assertRealPathInside,
  ensureWorkspace,
  workspaceRootPath,
} from './builtins.js';

// ---- 常量 ----
/** 目标行两侧各显示多少行（视口半宽） */
const VIEWPORT_CONTEXT_LINES = 50;
/** 滚动默认行数 */
const SCROLL_DEFAULT_LINES = 50;
/** execFile 缓冲区上限 */
const MAX_READ_BYTES = 512 * 1024;
/** grep 最多返回结果数 */
const MAX_GREP_RESULTS = 100;

/**
 * 写入工具常量（新三件套契约）：
 * - write_file: 原子全量写，content 上限 500KB
 * - edit_lines: 行替换，content 上限 2000 行 / 128KB
 * - session_write: 单次追加上限 2000 行 / 128KB
 * - append_file: 单次追加上限 2000 行 / 128KB
 */
const MAX_WRITE_BYTES = 500 * 1024;        // 500KB — write_file 单次上限
const MAX_EDIT_LINES = 2000;               // edit_lines 单次行数上限
const MAX_EDIT_BYTES = 128 * 1024;         // 128KB — edit_lines content 上限
const MAX_APPEND_LINES = 2000;             // append_file 单次行数上限
const MAX_APPEND_BYTES = 128 * 1024;       // 128KB — append_file content 上限
const MAX_SESSION_WRITE_LINES = 2000;      // session_write 单次行数上限
const MAX_SESSION_WRITE_BYTES = 128 * 1024; // 128KB — session_write 单次上限
/** Session 空闲超时（10 分钟无操作自动清理） */
const SESSION_IDLE_MS = 10 * 60 * 1000;

// ---- session 状态（进程内） ----

interface SessionState {
  id: string;
  path: string;
  tmpPath: string;
  bytesWritten: number;
  linesWritten: number;
  startedAt: number;
  lastActivityAt: number;
}

const activeSessions = new Map<string, SessionState>();

// 每分钟扫描一次过期 session，自动清理
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _sessionCleanup = setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of activeSessions) {
    if (now - sess.lastActivityAt > SESSION_IDLE_MS) {
      activeSessions.delete(id);
      fs.unlink(sess.tmpPath).catch(() => { /* 忽略清理错误 */ });
    }
  }
}, 60_000);
_sessionCleanup.unref();

// ---- 工具函数 ----

/** 安全取整到有效范围 */
function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 读取非空字符串 */
function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} 必须是有效的非空字符串`);
  }
  return value;
}

/** 统一获取工作区根目录与外部路径 */
function rootAndExternals(context?: { workspaceDir?: string; externalPaths?: string[] }) {
  return {
    root: context?.workspaceDir ?? workspaceRootPath(),
    externalPaths: context?.externalPaths,
  };
}

/** 检查路径是否存在 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 确保父目录存在 */
async function ensureParentDir(filePath: string): Promise<void> {
  await fs.mkdir(join(filePath, '..'), { recursive: true });
}

/**
 * 读取文件全部行，返回行数组（1-indexed）。
 * 正确处理末尾换行符：文件 "a\nb\n" → ['a', 'b']（末尾空行不计为一行）
 */
async function readAllLines(filePath: string): Promise<string[]> {
  const content = await fs.readFile(filePath, 'utf8');
  const lines = content.split('\n');
  // 去掉末尾换行符产生的空行
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    return lines.slice(0, -1);
  }
  return lines;
}

/**
 * 计算视口范围：以 targetLine 为中心，前后各 VIEWPORT_CONTEXT_LINES 行。
 * 返回值 { windowStart, windowEnd, centerLine }，均为 1-indexed。
 */
function calcViewport(totalLines: number, targetLine: number) {
  const centerLine = Math.max(1, Math.min(totalLines, targetLine));
  const windowStart = Math.max(1, centerLine - VIEWPORT_CONTEXT_LINES);
  const windowEnd = Math.min(totalLines, centerLine + VIEWPORT_CONTEXT_LINES);
  return { windowStart, windowEnd, centerLine };
}

/**
 * 从行数组中截取视口窗口，并格式化为带行号的文本。
 */
function formatViewport(
  lines: string[],
  windowStart: number,
  windowEnd: number,
): { lineData: Array<{ lineNumber: number; content: string }>; text: string } {
  const lineData: Array<{ lineNumber: number; content: string }> = [];
  const textLines: string[] = [];

  for (let i = windowStart - 1; i < windowEnd && i < lines.length; i++) {
    const lineNumber = i + 1;
    lineData.push({ lineNumber, content: lines[i] });
    textLines.push(`${String(lineNumber).padStart(5, ' ')} | ${lines[i]}`);
  }

  return { lineData, text: textLines.join('\n') };
}

/**
 * 生成编辑点附近的预览（前后各 5 行，标记 changed）。
 */
function buildPreview(
  resultLines: string[],
  startLine: number,
  newLinesCount: number,
  endLine: number,
): Array<{ lineNumber: number; content: string; changed: boolean }> {
  const previewStart = Math.max(0, startLine - 6);
  const previewEnd = Math.min(resultLines.length, endLine + 4);
  const preview: Array<{ lineNumber: number; content: string; changed: boolean }> = [];
  for (let i = previewStart; i < previewEnd; i++) {
    const lineNumber = i + 1;
    const changed = lineNumber >= startLine && lineNumber < startLine + newLinesCount;
    preview.push({ lineNumber, content: resultLines[i], changed });
  }
  return preview;
}

/**
 * 原子写入：先写临时文件再 rename，避免部分写入导致的损坏。
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmpPath = filePath + '.tmp.' + randomUUID();
  await fs.writeFile(tmpPath, content, 'utf8');
  await fs.rename(tmpPath, filePath);
}

/** 发布进度事件（sync 到工具执行上下文） */
function publishProgress(
  context: { publishEvent?: (event: Record<string, unknown>) => void; taskId?: string; callId?: string } | undefined,
  message: string,
  percent: number,
) {
  if (!context?.publishEvent) return;
  context.publishEvent({
    type: 'tool_progress',
    taskId: context.taskId ?? '',
    callId: context.callId ?? '',
    message,
    percent,
  });
}

// ============================================================
// 1. open_file（safe）：打开文件并定位
// ============================================================
toolRegistry.register({
  descriptor: {
    name: 'open_file',
    description:
      '打开工作区内的文本文件，定位到指定行，返回一个可读视口（约 100 行带行号文本）。' +
      '这是代码探索的入口操作——每次打开文件都应先用此工具定位。' +
      '返回当前视口范围（window_start ~ window_end）和中心行号（center_line），' +
      '后续可通过 scroll 工具浏览文件其他部分。' +
      'line_number 传入文件中间行号可获得最佳上下文（上方 ~50 行 + 下方 ~50 行）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        line_number: {
          type: 'integer',
          description:
            '要定位到的行号（1-indexed），缺省为第 1 行。' +
            '传入文件中间行号可同时看到上下方上下文。',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    riskLevel: 'safe',
    executionPolicy: { parallelizable: true },
  },

  async execute(args, context) {
    const { root, externalPaths } = rootAndExternals(context);
    const file = resolveInWorkspace(args.path, root, externalPaths);
    await assertRealPathInside(file, root, externalPaths);

    const stat = await fs.stat(file);
    if (!stat.isFile()) {
      throw new Error(`目标不是文件: ${file}`);
    }

    const lines = await readAllLines(file);
    const totalLines = lines.length;
    const targetLine = clampInteger(args.line_number, 1, totalLines, 1);
    const { windowStart, windowEnd, centerLine } = calcViewport(totalLines, targetLine);
    const { lineData, text } = formatViewport(lines, windowStart, windowEnd);

    return {
      path: relative(root, file),
      total_lines: totalLines,
      window_start: windowStart,
      window_end: windowEnd,
      center_line: centerLine,
      text,
      line_data: lineData,
      navigation_hint:
        `当前视口：第 ${windowStart}-${windowEnd} 行 / 共 ${totalLines} 行。` +
        `使用 scroll 工具浏览其他部分。例如：` +
        `scroll({ file: '${relative(root, file)}', direction: 'down', current_line: ${centerLine} })`,
    };
  },
});

// ============================================================
// 2. scroll（safe）：视口滚动
// ============================================================
toolRegistry.register({
  descriptor: {
    name: 'scroll',
    description:
      '在已通过 open_file 打开的文件中滚动视口。' +
      '需要传入 file（文件路径）和 current_line（当前中心行号，从 open_file 或上次 scroll 的 center_line 获取）。' +
      'direction 支持：up（上滚）、down（下滚）、top（跳到文件开头）、bottom（跳到文件末尾）。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '相对工作区的文件路径（与 open_file 的 path 一致）' },
        direction: {
          type: 'string',
          enum: ['up', 'down', 'top', 'bottom'],
          description: '滚动方向：up（向上）、down（向下）、top（跳到开头）、bottom（跳到末尾）',
        },
        current_line: {
          type: 'integer',
          description: '当前视口中心行号（从 open_file 或上次 scroll 的 center_line 获取）',
        },
        lines_count: {
          type: 'integer',
          description: '滚动行数，缺省为 50。direction 为 top/bottom 时忽略。',
        },
      },
      required: ['file', 'direction', 'current_line'],
      additionalProperties: false,
    },
    riskLevel: 'safe',
    executionPolicy: { parallelizable: true },
  },

  async execute(args, context) {
    const { root, externalPaths } = rootAndExternals(context);
    const file = resolveInWorkspace(args.file, root, externalPaths);
    await assertRealPathInside(file, root, externalPaths);

    const direction = readNonEmptyString(args.direction, 'direction');
    const currentLine = clampInteger(args.current_line, 1, Infinity, 1);
    const linesCount = clampInteger(args.lines_count, 1, 1000, SCROLL_DEFAULT_LINES);

    const lines = await readAllLines(file);
    const totalLines = lines.length;

    let newCenterLine: number;
    switch (direction) {
      case 'top':
        newCenterLine = 1;
        break;
      case 'bottom':
        newCenterLine = totalLines;
        break;
      case 'up':
        newCenterLine = Math.max(1, currentLine - linesCount);
        break;
      case 'down':
        newCenterLine = Math.min(totalLines, currentLine + linesCount);
        break;
      default:
        throw new Error(`无效的 direction: "${direction}"，可用值: up, down, top, bottom`);
    }

    const { windowStart, windowEnd, centerLine } = calcViewport(totalLines, newCenterLine);
    const { lineData, text } = formatViewport(lines, windowStart, windowEnd);

    return {
      path: relative(root, file),
      total_lines: totalLines,
      window_start: windowStart,
      window_end: windowEnd,
      center_line: centerLine,
      text,
      line_data: lineData,
      navigation_hint:
        `当前视口：第 ${windowStart}-${windowEnd} 行 / 共 ${totalLines} 行。` +
        `继续使用 scroll 浏览：` +
        `scroll({ file: '${relative(root, file)}', direction: 'down', current_line: ${centerLine} })`,
    };
  },
});

// ============================================================
// 3. search_grep（safe）：全局只读检索
// ============================================================
toolRegistry.register({
  descriptor: {
    name: 'search_grep',
    description:
      '在工作区内全局搜索文本内容（类似 grep -rn）。' +
      '返回所有匹配的文件路径、行号与内容片段。' +
      '不区分大小写，纯只读操作。' +
      '搜索范围大时建议配合 glob 参数（如 "*.ts"、"*.md"）缩小范围，' +
      '避免匹配节点模块或构建产物。',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要搜索的关键词或 grep 正则表达式' },
        path: { type: 'string', description: '搜索起始目录（相对工作区根），缺省为工作区根目录' },
        glob: { type: 'string', description: '文件名 glob 过滤，例如 "*.ts"、"./src/**/*.ts"、忽略 node_modules' },
        maxResults: { type: 'integer', description: '最多返回结果数，默认 50，上限 100' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    riskLevel: 'safe',
    executionPolicy: { parallelizable: true },
  },

  async execute(args, context) {
    const { root, externalPaths } = rootAndExternals(context);
    await ensureWorkspace(root);
    const searchRoot = resolveInWorkspace(
      typeof args.path === 'string' ? args.path : '.',
      root,
      externalPaths,
    );
    await assertRealPathInside(searchRoot, root, externalPaths);

    const pattern = readNonEmptyString(args.pattern, 'pattern');
    const glob = typeof args.glob === 'string' && args.glob.trim() ? args.glob.trim() : undefined;
    const maxResults = clampInteger(args.maxResults, 1, MAX_GREP_RESULTS, 50);

    const grepArgs: string[] = [
      '-rn',
      '--binary-files=without-match',
      '-m', String(Math.min(maxResults, MAX_GREP_RESULTS)),
    ];
    if (glob) {
      grepArgs.push('--include=' + glob);
    }
    grepArgs.push('-e', pattern, searchRoot);

    const grepResult = await new Promise<string>((resolvePromise, reject) => {
      execFile('grep', grepArgs, { maxBuffer: MAX_READ_BYTES, timeout: 15000 }, (err, stdout, stderr) => {
        if (err && (err as { code: unknown }).code !== 1) {
          reject(new Error(stderr || err.message));
        } else {
          resolvePromise(stdout);
        }
      });
    });

    const rawLines = grepResult.trim().split('\n').filter((l) => l.length > 0);
    const truncated = rawLines.length > maxResults;
    const displayLines = truncated ? rawLines.slice(0, maxResults) : rawLines;

    const matches = displayLines.map((l) => {
      const firstColon = l.indexOf(':');
      const secondColon = firstColon >= 0 ? l.indexOf(':', firstColon + 1) : -1;
      if (firstColon <= 0 || secondColon <= firstColon) {
        return { file: l, line: 0, content: '' };
      }
      return {
        file: relative(root, l.slice(0, firstColon)),
        line: Number(l.slice(firstColon + 1, secondColon)),
        content: l.slice(secondColon + 1),
      };
    });

    return {
      pattern,
      match_count: matches.length,
      truncated,
      matches,
      hint: truncated
        ? `匹配 ${rawLines.length} 处，仅显示前 ${maxResults} 个结果。使用更精确的关键词或 glob 参数缩小范围。`
        : matches.length === 0
          ? '未找到匹配行。'
          : undefined,
    };
  },
});

// ============================================================
// 4. create_file（dangerous）：新建空文件
// ============================================================
toolRegistry.register({
  descriptor: {
    name: 'create_file',
    description:
      '在工作区内创建一个新的空文件。' +
      '如果文件已存在则不覆盖，返回已存在状态。' +
      '如需写入内容到新文件，创建后用 write_file 批量写入或 session_open/session_write/session_close 分批写入。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    riskLevel: 'dangerous',
  },

  async execute(args, context) {
    const { root, externalPaths } = rootAndExternals(context);
    const file = resolveInWorkspace(args.path, root, externalPaths);

    await ensureParentDir(file);
    await assertRealPathInside(file, root, externalPaths);

    if (await pathExists(file)) {
      const st = await fs.stat(file);
      if (st.isFile()) {
        return {
          path: relative(root, file),
          created: false,
          note: '文件已存在，未做任何修改。如需修改内容，使用 edit_lines 或 write_file。',
        };
      }
      throw new Error(`路径已存在但不是文件: ${file}`);
    }

    await fs.writeFile(file, '', 'utf8');
    return {
      path: relative(root, file),
      created: true,
      note: `空文件 ${relative(root, file)} 已创建。`,
    };
  },
});

// ============================================================
// 5. write_file（dangerous）：原子全量写
// ============================================================
toolRegistry.register({
  descriptor: {
    name: 'write_file',
    description:
      '原子全量写入文件（≤500KB）。文件不存在则创建，存在则覆盖。' +
      '通过先写临时文件再 rename 实现原子写入，不会产生部分写入的文件。' +
      '是新建文件或完全重写已有文件的首选方式。' +
      '内容超过 500KB 时会返回错误——请改用 session_open/session_write/session_close 分批写入。' +
      '如需局部修改现有文件，使用 edit_lines。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        content: { type: 'string', description: '文件内容（≤500KB，UTF-8 文本）' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    riskLevel: 'dangerous',
  },

  async execute(args, context) {
    const { root, externalPaths } = rootAndExternals(context);
    const file = resolveInWorkspace(args.path, root, externalPaths);
    await ensureParentDir(file);
    await assertRealPathInside(file, root, externalPaths);

    const content = readNonEmptyString(args.content, 'content');

    // 检查大小上限
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_WRITE_BYTES) {
      throw new Error(
        `内容过大（${bytes} 字节，上限 ${MAX_WRITE_BYTES} 字节 ≈ ${Math.round(MAX_WRITE_BYTES / 40)} 行）。` +
        `请改用 session_open/session_write/session_close 分批构建此文件。`,
      );
    }

    // 原子写入
    await atomicWrite(file, content);

    const st = await fs.stat(file);
    const lineCount = content.split('\n').length;

    return {
      path: relative(root, file),
      bytes_written: bytes,
      total_size: st.size,
      lines_written: lineCount,
      note: `文件 ${relative(root, file)} 已原子写入（${bytes} 字节，${lineCount} 行）。`,
    };
  },
});

// ============================================================
// 6. edit_lines（dangerous）：行级精确替换
// ============================================================
toolRegistry.register({
  descriptor: {
    name: 'edit_lines',
    description:
      '精确替换文件中指定行范围（start_line 到 end_line，闭区间，1-indexed）的内容。' +
      'content 上限 2000 行 / 128KB——适合局部编辑代码、修改配置等精确修改场景。' +
      '使用前务必先用 search_grep 或 open_file 确认行号准确。' +
      '如需创建大文件（>2000 行），用 session_open/session_write/session_close 分批写入。' +
      '如需整体重写小文件（≤500KB），用 write_file 一步完成。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        start_line: { type: 'integer', description: '起始行号（1-indexed，包含）' },
        end_line: { type: 'integer', description: '结束行号（1-indexed，包含），必须 >= start_line' },
        content: { type: 'string', description: '替换后的新内容（≤2000 行 / 128KB，可包含多行文本）' },
      },
      required: ['path', 'start_line', 'end_line', 'content'],
      additionalProperties: false,
    },
    riskLevel: 'dangerous',
  },

  async execute(args, context) {
    const { root, externalPaths } = rootAndExternals(context);
    const file = resolveInWorkspace(args.path, root, externalPaths);
    await assertRealPathInside(file, root, externalPaths);

    const startLine = clampInteger(args.start_line, 1, Infinity, 0);
    const endLine = clampInteger(args.end_line, 1, Infinity, 0);
    const content = readNonEmptyString(args.content, 'content');

    if (startLine <= 0 || endLine <= 0 || startLine > endLine) {
      throw new Error(
        `无效的行号范围: start_line=${args.start_line}, end_line=${args.end_line}（须满足 1 <= start_line <= end_line）`,
      );
    }

    // 校验 content 上限：2000 行 / 128KB
    const allNewLines = content.split('\n');
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (allNewLines.length > MAX_EDIT_LINES) {
      throw new Error(
        `替换内容超出行数上限（${allNewLines.length} 行 > ${MAX_EDIT_LINES} 行）。` +
        `请缩小编辑范围（如只改关键函数）或用 session_open/session_write/session_close 重建整个文件。`,
      );
    }
    if (contentBytes > MAX_EDIT_BYTES) {
      throw new Error(
        `替换内容超出字符上限（${contentBytes} 字节 > ${MAX_EDIT_BYTES} 字节）。` +
        `请缩小编辑范围。`,
      );
    }

    // 读取原文件，校验范围
    const originalLines = await readAllLines(file);
    if (endLine > originalLines.length) {
      throw new Error(
        `结束行号 ${endLine} 超出文件总行数 ${originalLines.length}。` +
        `如需向文件追加内容，请使用 append_file 工具。`,
      );
    }

    const replacedCount = endLine - startLine + 1;
    const replacedContent = originalLines.slice(startLine - 1, endLine).join('\n');

    // 内存替换（小数据量，O(N) 安全）
    const resultLines = [
      ...originalLines.slice(0, startLine - 1),
      ...allNewLines,
      ...originalLines.slice(endLine),
    ];
    const resultContent = resultLines.join('\n');

    // 原子写入
    await atomicWrite(file, resultContent);

    const preview = buildPreview(resultLines, startLine, allNewLines.length, endLine);

    return {
      path: relative(root, file),
      start_line: startLine,
      end_line: endLine,
      replaced_lines: replacedCount,
      new_lines_count: allNewLines.length,
      bytes_written: Buffer.byteLength(resultContent, 'utf8'),
      replaced_content: replacedContent,
      preview,
    };
  },
});

// ============================================================
// 7. append_file（dangerous）：尾部追加
// ============================================================
toolRegistry.register({
  descriptor: {
    name: 'append_file',
    description:
      '在文件末尾追加内容（≤2000 行/128KB）。' +
      '如果文件不存在则创建新文件并写入。' +
      '如需追加多于 2000 行，连续多次调用 append_file。' +
      '如需替换文件中间某段内容，使用 edit_lines。' +
      '如需新建大文件，使用 session_open/session_write/session_close 分批写入。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        content: { type: 'string', description: '要追加的文本内容（≤2000 行/128KB）' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    riskLevel: 'dangerous',
  },

  async execute(args, context) {
    const { root, externalPaths } = rootAndExternals(context);
    const file = resolveInWorkspace(args.path, root, externalPaths);
    await ensureParentDir(file);
    await assertRealPathInside(file, root, externalPaths);

    const content = readNonEmptyString(args.content, 'content');

    // 校验上限
    const lines = content.split('\n');
    if (lines.length > MAX_APPEND_LINES) {
      throw new Error(
        `追加内容超出行数上限（${lines.length} 行 > ${MAX_APPEND_LINES} 行）。` +
        `请分批追加，每次不超过 ${MAX_APPEND_LINES} 行。`,
      );
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_APPEND_BYTES) {
      throw new Error(
        `追加内容超出字节上限（${bytes} > ${MAX_APPEND_BYTES} 字节）。请分批追加。`,
      );
    }

    // 单次追加
    await fs.appendFile(file, content, 'utf8');
    const st = await fs.stat(file);

    return {
      path: relative(root, file),
      bytes_written: bytes,
      total_size: st.size,
      note: `已向 ${relative(root, file)} 追加 ${bytes} 字节（${lines.length} 行）。`,
    };
  },
});

// ============================================================
// 8. session_open（dangerous）：打开分批写入会话
// ============================================================
toolRegistry.register({
  descriptor: {
    name: 'session_open',
    description:
      '打开一个分批写入会话，用于构建大文件（>2000 行 / >500KB）。' +
      '返回一个 session_id，后续通过 session_write 分多次追加内容，' +
      '最后用 session_close 完成写入。' +
      '适用于：新建大型源文件、生成长篇文档、导出数据.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的目标文件路径' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    riskLevel: 'dangerous',
  },

  async execute(args, context) {
    const { root, externalPaths } = rootAndExternals(context);
    const file = resolveInWorkspace(args.path, root, externalPaths);
    await ensureParentDir(file);
    await assertRealPathInside(file, root, externalPaths);

    // 创建临时文件
    const tmpPath = file + '.session.' + randomUUID();
    await fs.writeFile(tmpPath, '', 'utf8');

    const id = randomUUID();
    const state: SessionState = {
      id,
      path: relative(root, file),
      tmpPath,
      bytesWritten: 0,
      linesWritten: 0,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    activeSessions.set(id, state);

    return {
      session_id: id,
      path: state.path,
      tmp_file: tmpPath,
      note:
        `分批写入会话已开始：目标 ${state.path}。` +
        `使用 session_write("${id}", content) 分次写入内容，` +
        `最后用 session_close("${id}") 完成。` +
        `会话空闲 ${SESSION_IDLE_MS / 1000 / 60} 分钟未操作会自动清理。`,
    };
  },
});

// ============================================================
// 9. session_write（dangerous）：向写作会话追加一段内容
// ============================================================
toolRegistry.register({
  descriptor: {
    name: 'session_write',
    description:
      '向一个分批写入会话追加一段内容（≤2000 行/128KB 每次）。' +
      '可连续多次调用，每段内容依次追加到临时文件。' +
      '最后必须调用 session_close 完成写入。' +
      '返回当前已写入的字节数和行数，便于跟踪进度。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'session_open 返回的 session_id' },
        content: { type: 'string', description: '要追加的文本内容（≤2000 行/128KB）' },
      },
      required: ['session_id', 'content'],
      additionalProperties: false,
    },
    riskLevel: 'dangerous',
  },

  async execute(args, context) {
    const sessionId = readNonEmptyString(args.session_id, 'session_id');
    const content = readNonEmptyString(args.content, 'content');

    const session = activeSessions.get(sessionId);
    if (!session) {
      throw new Error(
        `会话 "${sessionId}" 不存在或已过期（${SESSION_IDLE_MS / 1000 / 60} 分钟无操作自动清理）。` +
        `请重新 session_open 开始新的写入会话。`,
      );
    }

    // 校验上限
    const lines = content.split('\n');
    if (lines.length > MAX_SESSION_WRITE_LINES) {
      throw new Error(
        `单次 session_write 超出行数上限（${lines.length} 行 > ${MAX_SESSION_WRITE_LINES} 行）。` +
        `请分多次写入，每次不超过 ${MAX_SESSION_WRITE_LINES} 行。`,
      );
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_SESSION_WRITE_BYTES) {
      throw new Error(
        `单次 session_write 超出字节上限（${bytes} > ${MAX_SESSION_WRITE_BYTES} 字节）。请分多次写入。`,
      );
    }

    // 追加到临时文件
    await fs.appendFile(session.tmpPath, content, 'utf8');

    session.bytesWritten += bytes;
    session.linesWritten += content.split('\n').length;
    session.lastActivityAt = Date.now();

    publishProgress(context, `已写入 ${session.linesWritten} 行 / ${session.bytesWritten} 字节`, 0);

    return {
      session_id: sessionId,
      path: session.path,
      bytes_written: session.bytesWritten,
      lines_written: session.linesWritten,
      note: `第 ${content.split('\n').length} 行已追加。累计：${session.linesWritten} 行 / ${session.bytesWritten} 字节。继续使用 session_write 追加，完成后调用 session_close。`,
    };
  },
});

// ============================================================
// 10. session_close（dangerous）：完成分批写入
// ============================================================
toolRegistry.register({
  descriptor: {
    name: 'session_close',
    description:
      '完成分批写入会话：将临时文件原子地 rename 到目标路径，清理 session 状态。' +
      '调用后 session_id 失效。文件写入完成，可正常读取。' +
      '如果目标路径已存在，会被覆盖。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'session_open 返回的 session_id' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    riskLevel: 'dangerous',
  },

  async execute(args, context) {
    const sessionId = readNonEmptyString(args.session_id, 'session_id');

    const session = activeSessions.get(sessionId);
    if (!session) {
      throw new Error(
        `会话 "${sessionId}" 不存在或已过期。` +
        `如果临时文件还在，可通过文件系统查找并恢复。`,
      );
    }

    // 从 session 清理
    activeSessions.delete(sessionId);

    const fullPath = resolveInWorkspace(
      session.path,
      rootAndExternals(context).root,
      rootAndExternals(context).externalPaths,
    );
    await ensureParentDir(fullPath);

    // 原子 rename 到目标路径
    await fs.rename(session.tmpPath, fullPath);

    const st = await fs.stat(fullPath);

    publishProgress(context, `文件写入完成：${session.path}（${st.size} 字节）`, 100);

    return {
      session_id: sessionId,
      path: session.path,
      total_bytes: st.size,
      total_lines: session.linesWritten,
      duration_ms: Date.now() - session.startedAt,
      note: `文件 ${session.path} 已成功写入（${st.size} 字节，${session.linesWritten} 行，耗时 ${Date.now() - session.startedAt}ms）。`,
    };
  },
});

// ============================================================
// 11. session_abort（safe）：放弃分批写入
// ============================================================
toolRegistry.register({
  descriptor: {
    name: 'session_abort',
    description:
      '放弃一个进行中的分批写入会话，清理临时文件。' +
      '目标路径不受影响（临时文件尚未 rename）。' +
      '如果 session_id 已过期或不存在，返回已清理状态。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'session_open 返回的 session_id' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    riskLevel: 'safe',
  },

  async execute(args) {
    const sessionId = readNonEmptyString(args.session_id, 'session_id');

    const session = activeSessions.get(sessionId);
    if (!session) {
      return {
        session_id: sessionId,
        cleaned: false,
        note: `会话 "${sessionId}" 不存在或已过期，无需清理。`,
      };
    }

    activeSessions.delete(sessionId);
    await fs.unlink(session.tmpPath).catch(() => { /* 忽略清理错误 */ });

    return {
      session_id: sessionId,
      cleaned: true,
      path: session.path,
      partial_bytes: session.bytesWritten,
      note: `会话已放弃，临时文件已清理。目标文件 ${session.path} 未受影响。`,
    };
  },
});
