import type Database from 'better-sqlite3';

type DatabaseType = Database.Database;

export interface PiSessionTreeSnapshotRow {
  version: number;
  entries: unknown[];
  messageCount: number;
  messageIds: string[];
  messageLinks: Array<{ messageId: string; entryId: string }>;
  updatedAt: string;
}

function parseJsonColumn(value: string | null): unknown {
  if (value == null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Pi 会话树独立持久化；避免高频 entry 写入重写完整 Task。 */
export function createPiSessionTreeStore(db: DatabaseType) {
  return {
    get(taskId: string): PiSessionTreeSnapshotRow | undefined {
      const row = db.prepare(
        `SELECT version, entries, message_count, message_ids, message_links, updated_at
         FROM pi_session_trees WHERE task_id = ?`,
      ).get(taskId) as {
        version: number;
        entries: string;
        message_count: number;
        message_ids: string;
        message_links: string;
        updated_at: string;
      } | undefined;
      if (!row) return undefined;
      const entries = parseJsonColumn(row.entries);
      if (!Array.isArray(entries)) return undefined;
      const messageIds = parseJsonColumn(row.message_ids);
      const messageLinks = parseJsonColumn(row.message_links);
      return {
        version: row.version,
        entries,
        messageCount: row.message_count,
        messageIds: Array.isArray(messageIds)
          ? messageIds.filter((id): id is string => typeof id === 'string')
          : [],
        messageLinks: Array.isArray(messageLinks)
          ? messageLinks.filter((link): link is { messageId: string; entryId: string } => (
              typeof link === 'object' &&
              link !== null &&
              'messageId' in link &&
              typeof link.messageId === 'string' &&
              'entryId' in link &&
              typeof link.entryId === 'string'
            ))
          : [],
        updatedAt: row.updated_at,
      };
    },

    save(taskId: string, snapshot: Omit<PiSessionTreeSnapshotRow, 'updatedAt'>): void {
      const updatedAt = new Date().toISOString();
      db.prepare(
        `INSERT INTO pi_session_trees (task_id, version, entries, message_count, message_ids, message_links, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           version = excluded.version,
           entries = excluded.entries,
           message_count = excluded.message_count,
           message_ids = excluded.message_ids,
           message_links = excluded.message_links,
           updated_at = excluded.updated_at`,
      ).run(
        taskId,
        snapshot.version,
        JSON.stringify(snapshot.entries),
        snapshot.messageCount,
        JSON.stringify(snapshot.messageIds),
        JSON.stringify(snapshot.messageLinks),
        updatedAt,
      );
    },

    delete(taskId: string): boolean {
      return db.prepare('DELETE FROM pi_session_trees WHERE task_id = ?').run(taskId).changes > 0;
    },
  };
}
