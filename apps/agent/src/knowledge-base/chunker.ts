/**
 * 知识库文本分块器。
 *
 * 将文件内容分割为适合 embedding + 检索的语义块。
 * 策略：按段落分割，合并到目标字符数（默认 512），
 * 保留上下文边界（不截断句子/代码行）。
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

export interface ChunkResult {
  id: string;
  filePath: string;
  chunkIndex: number;
  content: string;
  charCount: number;
}

export interface ChunkerOptions {
  /** 目标块字符数（默认 512） */
  targetChars: number;
  /** 最大块字符数（默认 1024），超过则硬截断 */
  maxChars: number;
  /** 最大文件大小（字节，默认 1MB），超过则跳过 */
  maxFileBytes: number;
  /** 允许的文件扩展名列表（默认 .ts/.js/.md/.txt/.json/.yaml/.toml/.rs/.py） */
  allowedExtensions: string[];
  /** 忽略的目录/文件模式 */
  ignorePatterns: RegExp[];
}

const DEFAULT_OPTIONS: ChunkerOptions = {
  targetChars: 512,
  maxChars: 1024,
  maxFileBytes: 1 * 1024 * 1024,
  allowedExtensions: [
    '.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs',
    '.md', '.mdx',
    '.txt', '.json', '.yaml', '.yml', '.toml',
    '.rs', '.py', '.go', '.java', '.rb', '.php',
    '.css', '.scss', '.less', '.html', '.htm',
    '.sh', '.bash', '.zsh', '.fish',
    '.sql', '.graphql', '.proto',
    '.xml', '.svg', '.env', '.conf', '.ini',
  ],
  ignorePatterns: [
    /node_modules[/\\]/,
    /\.git[/\\]/,
    /\.aurevoy[/\\]/,
    /dist[/\\]/,
    /build[/\\]/,
    /\.next[/\\]/,
    /target[/\\]/,
    /\.venv[/\\]/,
    /__pycache__[/\\]/,
    /\.DS_Store/,
    /package-lock\.json$/,
    /yarn\.lock$/,
    /pnpm-lock\.yaml$/,
    /\.sqlite$/,
    /\.[oi]bj$/,
    /\.bin$/,
  ],
};

export function getChunkerOptions(overrides?: Partial<ChunkerOptions>): ChunkerOptions {
  return { ...DEFAULT_OPTIONS, ...overrides };
}

/** 计算文件内容的 SHA256 哈希，用于变更检测。 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/** 读取文件内容，返回 utf-8 字符串。超过 maxFileBytes 时返回 null。 */
export function readFileContent(filePath: string, maxBytes: number): string | null {
  try {
    const stat = readFileSync(filePath);
    if (stat.length > maxBytes) return null; // 超过大小限制
    return stat.toString('utf-8');
  } catch {
    return null;
  }
}

/** 判断文件是否应被索引（扩展名校验 + 忽略模式校验）。 */
export function shouldIndexFile(relativePath: string, options: ChunkerOptions): boolean {
  const ext = path.extname(relativePath).toLowerCase();
  if (!options.allowedExtensions.includes(ext)) return false;
  for (const pattern of options.ignorePatterns) {
    if (pattern.test(relativePath)) return false;
  }
  return true;
}

/**
 * 将文件内容分割为文本块。
 *
 * 分块策略：
 * 1. 按双换行（\n\n）或单换行（\n）分割为段落
 * 2. 合并短段落到目标字符数
 * 3. 超过 maxChars 的大段落硬截断
 */
export function chunkContent(
  content: string,
  filePath: string,
  options: ChunkerOptions,
): ChunkResult[] {
  const chunks: ChunkResult[] = [];

  // 第一阶段：初始段落分割
  let rawParagraphs: string[];

  // 先尝试双换行分割
  const doubleNewline = content.split(/\n\n+/);
  if (doubleNewline.length >= 2) {
    rawParagraphs = doubleNewline;
  } else {
    // 单换行分割
    rawParagraphs = content.split('\n');
  }

  // 第二階段：合并段落到目标大小
  const merged: string[] = [];
  let current = '';

  for (const para of rawParagraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (!current) {
      current = trimmed;
    } else if ((current.length + trimmed.length + 1) <= options.targetChars) {
      current += '\n' + trimmed;
    } else {
      merged.push(current);
      current = trimmed;
    }
  }
  if (current) merged.push(current);

  // 第三阶段：处理超大段落
  let chunkIndex = 0;
  for (const segment of merged) {
    if (segment.length <= options.maxChars) {
      chunks.push({
        id: `${filePath}::${chunkIndex}`,
        filePath,
        chunkIndex,
        content: segment,
        charCount: segment.length,
      });
      chunkIndex++;
    } else {
      // 硬截断
      let start = 0;
      while (start < segment.length) {
        const end = Math.min(start + options.maxChars, segment.length);
        // 尽量在换行/空格处断开
        let breakAt = end;
        if (end < segment.length) {
          const afterEnd = segment.slice(end, end + 100);
          const newlinePos = afterEnd.indexOf('\n');
          if (newlinePos >= 0 && newlinePos < 50) {
            breakAt = end + newlinePos;
          }
        }
        const part = segment.slice(start, breakAt).trim();
        if (part) {
          chunks.push({
            id: `${filePath}::${chunkIndex}`,
            filePath,
            chunkIndex,
            content: part,
            charCount: part.length,
          });
          chunkIndex++;
        }
        start = breakAt;
      }
    }
  }

  return chunks;
}
