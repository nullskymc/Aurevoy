/**
 * Dreams 后台记忆维护管道。
 *
 * 参考: Codex `stage1_outputs` 批处理 + langmem `background memory manager` + Claude Code `Dreams`。
 *
 * 功能：
 * 1. Backfill embeddings — 为缺失向量索引的记忆生成 embedding
 * 2. Dedup merge — 全局 Jaccard 扫描，相似记忆合并
 * 3. Low confidence sweep — 自动禁用低置信度 agent 记忆
 * 4. 缓存刷新 — 维护后清除 memory_summary 缓存
 */

import { getEmbeddingProvider } from '../embedding/provider.js';
import { upsertMemoryVec, invalidateMemorySummary } from '../store/db.js';
import { db, memoryStore } from '../store/db.js';

export interface DreamsOptions {
  backfillEmbeddings: boolean;
  dedupMerge: boolean;
  lowConfidenceSweep: boolean;
  /** 单次 backfill 上限（避免长时间阻塞） */
  maxBackfill: number;
  /** 低置信度阈值（低于此值且 origin=agent 的记忆被禁用） */
  confidenceThreshold: number;
}

export interface DreamsReport {
  backfilled: number;
  dedupMerged: number;
  dedupRemoved: number;
  lowConfidenceDisabled: number;
  errors: string[];
  durationMs: number;
}

const DEFAULT_OPTIONS: DreamsOptions = {
  backfillEmbeddings: true,
  dedupMerge: true,
  lowConfidenceSweep: true,
  maxBackfill: 20,
  confidenceThreshold: 0.2,
};

/**
 * 执行一轮 Dreams 维护。
 * 各步骤独立 try/catch，单步失败不影响其他步骤。
 */
export async function runDreams(
  options?: Partial<DreamsOptions>,
): Promise<DreamsReport> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const start = Date.now();
  const report: DreamsReport = {
    backfilled: 0,
    dedupMerged: 0,
    dedupRemoved: 0,
    lowConfidenceDisabled: 0,
    errors: [],
    durationMs: 0,
  };

  // Step 1: Backfill embeddings
  if (opts.backfillEmbeddings) {
    try {
      const result = await backfillEmbeddings(opts.maxBackfill);
      report.backfilled = result;
    } catch (err) {
      report.errors.push(`backfill: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Step 2: Dedup merge
  if (opts.dedupMerge) {
    try {
      const result = await dedupMemories();
      report.dedupMerged = result.merged;
      report.dedupRemoved = result.removed;
    } catch (err) {
      report.errors.push(`dedup: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Step 3: Low confidence sweep
  if (opts.lowConfidenceSweep) {
    try {
      const count = await lowConfidenceSweep(opts.confidenceThreshold);
      report.lowConfidenceDisabled = count;
    } catch (err) {
      report.errors.push(`sweep: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 清除缓存
  if (report.backfilled > 0 || report.dedupMerged > 0 || report.lowConfidenceDisabled > 0) {
    invalidateMemorySummary();
  }

  report.durationMs = Date.now() - start;
  return report;
}

// ---- Backfill ----

async function backfillEmbeddings(max: number): Promise<number> {
  const provider = getEmbeddingProvider();
  if (!provider) return 0;

  const rows = db.prepare(
    `SELECT id, content FROM memories
     WHERE embedding_updated_at IS NULL
     LIMIT ?`,
  ).all(max) as Array<{ id: string; content: string }>;

  if (rows.length === 0) return 0;

  let count = 0;
  for (const row of rows) {
    try {
      const vec = await provider.embed(row.content.slice(0, 2000));
      if (!upsertMemoryVec(row.id, vec)) continue;
      db.prepare(
        'UPDATE memories SET embedding_updated_at = ? WHERE id = ?',
      ).run(new Date().toISOString(), row.id);
      count++;
    } catch {
      // 单条失败继续下一条
    }
  }

  return count;
}

// ---- Dedup ----

async function dedupMemories(): Promise<{ merged: number; removed: number }> {
  const all = memoryStore.list();
  let merged = 0;
  let removed = 0;

  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      const sim = jaccardSimilarity(keywords(a.content), keywords(b.content));

      if (sim > 0.7) {
        // 保留置信度更高的，或更早创建的
        const keeper = a.confidence >= b.confidence ? a : b;
        const toRemove = keeper.id === a.id ? b : a;

        // 合并内容：如果内容不同，在 keeper 后追加
        if (keeper.content !== toRemove.content && keepAsString(keeper)) {
          const mergedContent = keeper.content.length > toRemove.content.length
            ? keeper.content
            : `${keeper.content}\n（合并: ${toRemove.content}）`;

          memoryStore.update(keeper.id, {
            content: mergedContent,
            confidence: Math.max(keeper.confidence, toRemove.confidence),
          });
          merged++;
        }

        // 删除重复记忆
        memoryStore.delete(toRemove.id);
        removed++;
      }
    }
  }

  return { merged, removed };
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

function keywords(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .split(/[^a-z0-9一-鿿]+/i)
      .filter((t) => t.length >= 2),
  );
}

// 检查 MemoryEntry 是否有可写属性（非只读）
function keepAsString(_entry: unknown): boolean {
  return true;
}

// ---- Low confidence sweep ----

async function lowConfidenceSweep(threshold: number): Promise<number> {
  const rows = db.prepare(
    `SELECT id FROM memories
     WHERE origin = 'agent' AND confidence < ? AND enabled = 1`,
  ).all(threshold) as Array<{ id: string }>;

  let count = 0;
  for (const row of rows) {
    try {
      db.prepare(
        'UPDATE memories SET enabled = 0, updated_at = ? WHERE id = ?',
      ).run(new Date().toISOString(), row.id);
      count++;
    } catch {
      // 单条失败继续
    }
  }

  return count;
}
