/**
 * 知识库模块入口。
 *
 * 导出 indexKB / recallKB 供工具注册表使用，
 * 以及 KB CRUD 供 HTTP API 使用。
 */

import { readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { Citation } from '@aurevoy/shared';
import { randomUUID } from 'node:crypto';
import { getEmbeddingProvider } from '../embedding/provider.js';
import {
  db,
  upsertKbChunkVec,
  deleteKbChunkVec,
  searchKbChunkVec,
} from '../store/db.js';
import {
  chunkContent,
  hashContent,
  readFileContent,
  shouldIndexFile,
  getChunkerOptions,
} from './chunker.js';

// ============================================================
// KB 目录 CRUD（供 HTTP API 使用）
// ============================================================

export interface KbDir {
  id: string;
  dirPath: string;
  recursive: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export function listKbDirs(): KbDir[] {
  const rows = db.prepare('SELECT * FROM kb_dirs ORDER BY created_at DESC').all() as Array<{
    id: string; dir_path: string; recursive: number; enabled: number;
    created_at: string; updated_at: string;
  }>;
  return rows.map(r => ({
    id: r.id,
    dirPath: r.dir_path,
    recursive: r.recursive === 1,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function addKbDir(dirPath: string, recursive = true): KbDir {
  const resolved = path.resolve(dirPath);
  const now = new Date().toISOString();
  const dir: KbDir = {
    id: randomUUID(),
    dirPath: resolved,
    recursive,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO kb_dirs (id, dir_path, recursive, enabled, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
  ).run(dir.id, dir.dirPath, dir.recursive ? 1 : 0, dir.createdAt, dir.updatedAt);
  return dir;
}

export function deleteKbDir(id: string): boolean {
  // 先获取关联的 files
  const files = db.prepare('SELECT id FROM kb_files WHERE dir_id = ?').all(id) as Array<{ id: string }>;
  for (const file of files) {
    const chunkIds = db.prepare('SELECT id FROM kb_chunks WHERE file_id = ?').all(file.id) as Array<{ id: string }>;
    deleteKbChunkVec(chunkIds.map(c => c.id));
    db.prepare('DELETE FROM kb_chunks WHERE file_id = ?').run(file.id);
  }
  db.prepare('DELETE FROM kb_files WHERE dir_id = ?').run(id);
  const info = db.prepare('DELETE FROM kb_dirs WHERE id = ?').run(id);
  return info.changes > 0;
}

export interface KbIndexStatus {
  totalFiles: number;
  totalChunks: number;
  lastIndexed: string | null;
}

export function getKbIndexStatus(): KbIndexStatus {
  const fileCount = db.prepare('SELECT COUNT(*) AS c FROM kb_files').get() as { c: number };
  const chunkCount = db.prepare('SELECT COUNT(*) AS c FROM kb_chunks').get() as { c: number };
  const lastRow = db.prepare('SELECT MAX(indexed_at) AS last FROM kb_files').get() as { last: string | null };
  return {
    totalFiles: fileCount.c,
    totalChunks: chunkCount.c,
    lastIndexed: lastRow.last,
  };
}

// ============================================================
// 索引工具
// ============================================================

export interface IndexFileResult {
  dirPath: string;
  indexed: number;
  skipped: number;
  removed: number;
  totalChunks: number;
}

/**
 * 索引目录中的文件。
 * - 计算文件 hash → 跳过未变更的
 * - 对新增/变更文件：分块 → embedding → 写入 kb_chunks + kb_chunk_vec
 * - 对已删除文件：清理对应 chunk 和向量
 */
export async function indexKbDirs(dirPaths?: string[], force = false): Promise<IndexFileResult[]> {
  const embedder = getEmbeddingProvider();
  const results: IndexFileResult[] = [];

  // 列出要索引的目录
  let dirsToIndex: KbDir[];
  if (dirPaths && dirPaths.length > 0) {
    dirsToIndex = dirPaths.map(p => ({ id: '', dirPath: path.resolve(p), recursive: true, enabled: true, createdAt: '', updatedAt: '' }));
  } else {
    dirsToIndex = listKbDirs().filter(d => d.enabled);
  }

  for (const dir of dirsToIndex) {
    const result: IndexFileResult = {
      dirPath: dir.dirPath,
      indexed: 0,
      skipped: 0,
      removed: 0,
      totalChunks: 0,
    };

    try {
      // 收集当前文件
      const currentFiles = collectFiles(dir.dirPath, dir.recursive);

      // 从 DB 获取已索引的文件（按路径）
      const indexedRows = db.prepare(
        'SELECT id, file_path, file_hash FROM kb_files WHERE dir_id = ?',
      ).all(dir.id) as Array<{ id: string; file_path: string; file_hash: string }>;
      const indexedMap = new Map(indexedRows.map(r => [r.file_path, r]));

      // 检测删除：在 DB 中但不在磁盘上的文件
      for (const [filePath, row] of indexedMap) {
        if (!currentFiles.has(filePath)) {
          removeFileIndex(row.id);
          result.removed++;
        }
      }

      // 处理新增/变更文件
      for (const filePath of currentFiles.values()) {
        const indexed = indexedMap.get(filePath);
        const content = readFileContent(filePath, getChunkerOptions().maxFileBytes);
        if (!content) continue;

        const fileHash = hashContent(content);
        if (!force && indexed && indexed.file_hash === fileHash) {
          result.skipped++;
          continue;
        }

        // 分块 + embedding
        const options = getChunkerOptions();
        const chunks = chunkContent(content, filePath, options);
        const chunkCount = chunks.length;

        // 如果已有索引记录，先清理旧数据
        if (indexed) {
          removeFileIndex(indexed.id);
        }

        const fileId = indexed?.id ?? randomUUID();
        const now = new Date().toISOString();

        // 写入 kb_files
        if (!indexed) {
          db.prepare(
            `INSERT INTO kb_files (id, dir_id, file_path, file_hash, mtime, chunk_count, indexed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(fileId, dir.id, filePath, fileHash, statSync(filePath).mtime.toISOString(), chunkCount, now);
        } else {
          db.prepare(
            `UPDATE kb_files SET file_hash=?, mtime=?, chunk_count=?, indexed_at=? WHERE id=?`,
          ).run(fileHash, statSync(filePath).mtime.toISOString(), chunkCount, now, fileId);
        }

        // 写入 chunks
        for (const chunk of chunks) {
          db.prepare(
            `INSERT INTO kb_chunks (id, file_id, chunk_index, content, char_count, embedding_updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(chunk.id, fileId, chunk.chunkIndex, chunk.content, chunk.charCount, now);

          // 异步生成 embedding（不阻塞）
          if (embedder) {
            try {
              const vec = await embedder.embed(chunk.content.slice(0, 2000));
              upsertKbChunkVec(chunk.id, vec);
            } catch {
              // 单个 chunk embedding 失败不影响其余
            }
          }
        }

        result.indexed++;
        result.totalChunks += chunkCount;
      }
    } catch (err) {
      console.warn(`[kb] 索引目录失败 ${dir.dirPath}:`, err instanceof Error ? err.message : String(err));
    }

    results.push(result);
  }

  return results;
}

function collectFiles(dirPath: string, recursive: boolean): Map<string, string> {
  const files = new Map<string, string>();
  const options = getChunkerOptions();

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const relativePath = path.relative(dirPath, fullPath);

      if (entry.isDirectory()) {
        if (recursive && !options.ignorePatterns.some(p => p.test(relativePath + '/'))) {
          const subFiles = collectFiles(fullPath, recursive);
          for (const [k, v] of subFiles) files.set(k, v);
        }
      } else if (entry.isFile() && shouldIndexFile(relativePath, options)) {
        files.set(fullPath, fullPath);
      }
    }
  } catch {
    // 目录不存在/无权限，忽略
  }

  return files;
}

function removeFileIndex(fileId: string): void {
  const chunkIds = db.prepare('SELECT id FROM kb_chunks WHERE file_id = ?').all(fileId) as Array<{ id: string }>;
  deleteKbChunkVec(chunkIds.map(c => c.id));
  db.prepare('DELETE FROM kb_chunks WHERE file_id = ?').run(fileId);
  db.prepare('DELETE FROM kb_files WHERE id = ?').run(fileId);
}

// ============================================================
// 召回工具
// ============================================================

export interface RecallResult {
  chunkId: string;
  filePath: string;
  content: string;
  score: number;
  chunkIndex: number;
}

/** M8: 含引用的召回结果。 */
export interface RecallKbResponse {
  results: RecallResult[];
  citations: Citation[];
}

/**
 * 语义搜索知识库，返回 top-K 匹配块及结构化引用。
 * 先尝试向量搜索，无 embedding 时返回空（提示用户先 index_files）。
 */
export async function recallKb(query: string, topK = 5): Promise<RecallKbResponse> {
  if (!query.trim()) return { results: [], citations: [] };

  const embedder = getEmbeddingProvider();
  if (!embedder) return { results: [], citations: [] };

  try {
    const queryVec = await embedder.embed(query.trim());
    const vecResults = searchKbChunkVec(queryVec, topK);
    if (vecResults.length === 0) return { results: [], citations: [] };

    const results: RecallResult[] = [];
    for (const vr of vecResults) {
      const chunkRow = db.prepare(
        'SELECT c.id, c.content, c.chunk_index, f.file_path FROM kb_chunks c JOIN kb_files f ON c.file_id = f.id WHERE c.id = ?',
      ).get(vr.chunkId) as { id: string; content: string; chunk_index: number; file_path: string } | undefined;
      if (chunkRow) {
        results.push({
          chunkId: chunkRow.id,
          filePath: chunkRow.file_path,
          content: chunkRow.content,
          score: Math.max(0, 1 - vr.distance),
          chunkIndex: chunkRow.chunk_index,
        });
      }
    }

    const sorted = results.sort((a, b) => b.score - a.score);

    // M8: 构建引用列表
    const citations: Citation[] = sorted.map((r) => ({
      sourceId: r.chunkId,
      sourceType: 'kb_chunk' as const,
      content: r.content.slice(0, 200),
      score: Math.round(r.score * 100) / 100,
      filePath: r.filePath,
      chunkIndex: r.chunkIndex,
    }));

    return { results: sorted, citations };
  } catch (err) {
    console.warn('[kb] recall 失败:', err instanceof Error ? err.message : String(err));
    return { results: [], citations: [] };
  }
}
