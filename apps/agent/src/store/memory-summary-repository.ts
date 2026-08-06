import type Database from "better-sqlite3";

export interface MemorySummaryRow {
  key: string;
  content: string;
  citations: string | null;
  scoredIds: string;
  totalEnabled: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySummaryStore {
  getMemorySummary(goal?: string): MemorySummaryRow | undefined;
  setMemorySummary(
    goal: string | undefined,
    content: string,
    citations: string,
    scoredIds: string,
    totalEnabled: number,
  ): void;
  invalidateMemorySummary(goal?: string): void;
}

/** 记忆摘要缓存 repository；缓存异常不能阻断主任务流程。 */
export function createMemorySummaryStore(db: Database.Database): MemorySummaryStore {
  function getMemorySummary(goal?: string): MemorySummaryRow | undefined {
    try {
      const key = summaryKey(goal);
      return db.prepare("SELECT * FROM memory_summary WHERE key = ?").get(key) as MemorySummaryRow | undefined;
    } catch {
      return undefined;
    }
  }

  function setMemorySummary(
    goal: string | undefined,
    content: string,
    citations: string,
    scoredIds: string,
    totalEnabled: number,
  ): void {
    try {
      const key = summaryKey(goal);
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO memory_summary (key, content, citations, scored_ids, total_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           content=excluded.content, citations=excluded.citations,
           scored_ids=excluded.scored_ids, total_enabled=excluded.total_enabled,
           updated_at=excluded.updated_at`,
      ).run(key, content, citations, scoredIds, totalEnabled, now, now);
    } catch {
      // 缓存失败不影响主流程。
    }
  }

  function invalidateMemorySummary(goal?: string): void {
    try {
      if (goal) {
        db.prepare("DELETE FROM memory_summary WHERE key = ?").run(summaryKey(goal));
      } else {
        db.prepare("DELETE FROM memory_summary").run();
      }
    } catch {
      // 数据库清理失败留给下一次摘要重建处理。
    }
  }

  return { getMemorySummary, setMemorySummary, invalidateMemorySummary };
}

function summaryKey(goal?: string): string {
  return goal ? `goal:${hashString(goal).slice(0, 16)}` : "default";
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash &= hash;
  }
  return Math.abs(hash).toString(16);
}
