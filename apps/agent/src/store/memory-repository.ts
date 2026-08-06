import type Database from 'better-sqlite3';
import type { MemoryEntry } from '@aurevoy/shared';

type DatabaseType = Database.Database;

interface MemoryRow {
  id: string;
  category: string;
  content: string;
  confidence: number;
  enabled: number;
  origin: string;
  source_task_id: string | null;
  source_task_goal: string | null;
  source_created_at: string;
  created_at: string;
  updated_at: string;
  name_slug: string | null;
  why: string | null;
  how_to_apply: string | null;
  embedding_updated_at: string | null;
}

type MemoryPatch = Partial<Pick<
  MemoryEntry,
  'content' | 'category' | 'confidence' | 'enabled' | 'nameSlug' | 'why' | 'howToApply' | 'embeddingUpdatedAt'
>>;

/** 记忆 CRUD repository；向量索引和摘要缓存由独立模块负责。 */
export function createMemoryStore(db: DatabaseType) {
  const store = {
    create(entry: MemoryEntry): MemoryEntry {
      db.prepare(
        `INSERT INTO memories (
           id, category, content, confidence, enabled, origin,
           source_task_id, source_task_goal, source_created_at, created_at, updated_at,
           name_slug, why, how_to_apply
         ) VALUES (
           @id, @category, @content, @confidence, @enabled, @origin,
           @sourceTaskId, @sourceTaskGoal, @sourceCreatedAt, @createdAt, @updatedAt,
           @nameSlug, @why, @howToApply
         )`,
      ).run({
        id: entry.id,
        category: entry.category,
        content: entry.content,
        confidence: entry.confidence,
        enabled: entry.enabled ? 1 : 0,
        origin: entry.source.origin,
        sourceTaskId: nullable(entry.source.taskId),
        sourceTaskGoal: nullable(entry.source.taskGoal),
        sourceCreatedAt: entry.source.createdAt,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        nameSlug: entry.nameSlug ?? null,
        why: entry.why ?? null,
        howToApply: entry.howToApply ?? null,
      });
      return entry;
    },

    get(id: string): MemoryEntry | undefined {
      const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
      return row ? rowToMemory(row) : undefined;
    },

    list(): MemoryEntry[] {
      const rows = db.prepare('SELECT * FROM memories ORDER BY updated_at DESC').all() as MemoryRow[];
      return rows.map(rowToMemory);
    },

    /** 仅启用的记忆，用于注入 Agent 上下文（按更新时间升序，稳定排列）。 */
    listEnabled(): MemoryEntry[] {
      const rows = db.prepare('SELECT * FROM memories WHERE enabled = 1 ORDER BY updated_at ASC').all() as MemoryRow[];
      return rows.map(rowToMemory);
    },

    update(id: string, patch: MemoryPatch): MemoryEntry | undefined {
      const current = store.get(id);
      if (!current) return undefined;
      const next: MemoryEntry = {
        ...current,
        content: patch.content ?? current.content,
        category: patch.category ?? current.category,
        confidence: patch.confidence ?? current.confidence,
        enabled: patch.enabled ?? current.enabled,
        nameSlug: patch.nameSlug !== undefined ? patch.nameSlug : current.nameSlug,
        why: patch.why !== undefined ? patch.why : current.why,
        howToApply: patch.howToApply !== undefined ? patch.howToApply : current.howToApply,
        embeddingUpdatedAt: patch.embeddingUpdatedAt !== undefined ? patch.embeddingUpdatedAt : current.embeddingUpdatedAt,
        updatedAt: new Date().toISOString(),
      };
      db.prepare(
        `UPDATE memories SET content=@content, category=@category, confidence=@confidence,
           enabled=@enabled, name_slug=@nameSlug, why=@why, how_to_apply=@howToApply, embedding_updated_at=@embeddingUpdatedAt,
           updated_at=@updatedAt WHERE id=@id`,
      ).run({
        id,
        content: next.content,
        category: next.category,
        confidence: next.confidence,
        enabled: next.enabled ? 1 : 0,
        nameSlug: next.nameSlug ?? null,
        why: next.why ?? null,
        howToApply: next.howToApply ?? null,
        embeddingUpdatedAt: next.embeddingUpdatedAt ?? null,
        updatedAt: next.updatedAt,
      });
      return next;
    },

    /** 按 nameSlug 查找记忆，用于 [[link]] 引用解析。 */
    findByNameSlug(slug: string): MemoryEntry | undefined {
      const row = db.prepare('SELECT * FROM memories WHERE name_slug = ?').get(slug) as MemoryRow | undefined;
      return row ? rowToMemory(row) : undefined;
    },

    delete(id: string): boolean {
      const info = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      return info.changes > 0;
    },

    count(): number {
      const row = db.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number };
      return row.count;
    },
  };
  return store;
}

function rowToMemory(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    category: row.category as MemoryEntry['category'],
    content: row.content,
    confidence: row.confidence,
    enabled: row.enabled === 1,
    source: {
      origin: row.origin as MemoryEntry['source']['origin'],
      taskId: row.source_task_id ?? undefined,
      taskGoal: row.source_task_goal ?? undefined,
      createdAt: row.source_created_at,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nameSlug: row.name_slug ?? undefined,
    why: row.why ?? undefined,
    howToApply: row.how_to_apply ?? undefined,
    embeddingUpdatedAt: row.embedding_updated_at ?? null,
  };
}

function nullable<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}
