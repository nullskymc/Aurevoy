/**
 * 基础文件读写工具（行级视口模式）。
 *
 * 设计思路：
 * 提供类似 IDE 编辑器的行级文件操作体验，替代原始的 byte-offset/dd 驱动方式。
 * 模型通过 open_file 定位文件 → scroll 浏览 → replace_lines 精准修改，
 * 形成完整的"定位-浏览-编辑"闭环。
 *
 * 定位（Read）：
 * - open_file：打开文件并定位到指定行，返回一个行窗口（视口）
 * - scroll：在已打开的文件中上下滚动视口
 * - search_grep：全局只读文本搜索（类似 grep -rn）
 *
 * 写入（Write）：
 * - create_file：新建空文件
 * - replace_lines：精确替换指定行范围（行号驱动）
 * - append_file：在文件末尾追加内容
 *
 * 工程约束：
 * - 行号均采用 1-indexed（第 1 行 = 文件开头）
 * - 视口 = 目标行前后各 VIEWPORT_CONTEXT_LINES 行
 * - 路径校验复用 builtins.ts 的 resolveInWorkspace / assertRealPathInside
 * - 所有工具无服务端状态：模型自行追踪当前文件与中心行号
 */

import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, relative } from 'node:path';

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
 * 返回结构化行数据 + 可直接展示的格式化文本。
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

    // 根据方向和步长计算新的中心行号
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

    // 构建 grep 参数：-rn = 递归 + 行号，--binary-files=without-match 跳过二进制
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
        // grep 退出码 1 = 无匹配，视为正常空结果
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

    // 解析 grep -rn 的 "file:line:content" 格式
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
      '如需写入内容到新文件，创建后调用 replace_lines 或 append_file。',
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

    // 确保父目录存在，再校验路径是否在沙箱内
    await fs.mkdir(join(file, '..'), { recursive: true });
    await assertRealPathInside(file, root, externalPaths);

    if (await pathExists(file)) {
      const st = await fs.stat(file);
      if (st.isFile()) {
        return {
          path: relative(root, file),
          created: false,
          note: '文件已存在，未做任何修改。如需修改内容，使用 replace_lines 或 append_file。',
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
// 5. replace_lines（dangerous）：精准行写入
// ============================================================
toolRegistry.register({
  descriptor: {
    name: 'replace_lines',
    description:
      '精确替换文件中指定行范围（start_line 到 end_line，闭区间，1-indexed）的内容。' +
      '用 content 参数替换掉目标范围的全部行。' +
      '使用前务必先用 search_grep 或 open_file 确认行号准确。' +
      '如需追加内容到文件末尾，使用 append_file。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        start_line: { type: 'integer', description: '起始行号（1-indexed，包含）' },
        end_line: { type: 'integer', description: '结束行号（1-indexed，包含），必须 >= start_line' },
        content: { type: 'string', description: '替换后的新内容（可包含多行文本）' },
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
      throw new Error(`无效的行号范围: start_line=${args.start_line}, end_line=${args.end_line}（须满足 1 <= start_line <= end_line）`);
    }

    // 读取原文件全部行，校验范围
    const lines = await readAllLines(file);
    if (endLine > lines.length) {
      throw new Error(
        `结束行号 ${endLine} 超出文件总行数 ${lines.length}。` +
        `如需向文件追加内容，请使用 append_file 工具。`,
      );
    }

    const newLines = content.split('\n');
    const replacedCount = endLine - startLine + 1;
    const replacedContent = lines.slice(startLine - 1, endLine).join('\n');

    // 构建新文件内容：保留首尾换行符行为
    const resultLines = [
      ...lines.slice(0, startLine - 1),
      ...newLines,
      ...lines.slice(endLine),
    ];
    const resultContent = resultLines.join('\n');

    await fs.writeFile(file, resultContent, 'utf8');

    // 生成修改点附近的预览（前后各 5 行，标记 changed）
    const previewStart = Math.max(0, startLine - 6);
    const previewEnd = Math.min(resultLines.length, endLine + 4);
    const preview: Array<{ lineNumber: number; content: string; changed: boolean }> = [];
    for (let i = previewStart; i < previewEnd; i++) {
      const lineNumber = i + 1;
      const changed = lineNumber >= startLine && lineNumber < startLine + newLines.length;
      preview.push({ lineNumber, content: resultLines[i], changed });
    }

    return {
      path: relative(root, file),
      start_line: startLine,
      end_line: endLine,
      replaced_lines: replacedCount,
      new_lines_count: newLines.length,
      bytes_written: Buffer.byteLength(resultContent, 'utf8'),
      replaced_content: replacedContent,
      preview,
    };
  },
});

// ============================================================
// 6. append_file（dangerous）：尾部追加
// ============================================================
toolRegistry.register({
  descriptor: {
    name: 'append_file',
    description:
      '在文件末尾追加内容。' +
      '如果文件不存在则创建新文件并写入。' +
      '如需替换文件中间某段内容，使用 replace_lines。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        content: { type: 'string', description: '要追加的文本内容' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    riskLevel: 'dangerous',
  },

  async execute(args, context) {
    const { root, externalPaths } = rootAndExternals(context);
    const file = resolveInWorkspace(args.path, root, externalPaths);
    await fs.mkdir(join(file, '..'), { recursive: true });
    await assertRealPathInside(file, root, externalPaths);

    const content = readNonEmptyString(args.content, 'content');

    await fs.appendFile(file, content, 'utf8');
    const st = await fs.stat(file);

    return {
      path: relative(root, file),
      bytes_written: Buffer.byteLength(content, 'utf8'),
      total_size: st.size,
      note: `已向 ${relative(root, file)} 追加 ${Buffer.byteLength(content, 'utf8')} 字节。`,
    };
  },
});
