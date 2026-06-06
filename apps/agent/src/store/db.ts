import Database from 'better-sqlite3';
import type { Task } from '@aurevoy/shared';
import { config } from '../config.js';

/**
 * 本地持久化层 (SQLite)。
 *
 * 当前用单表存储任务（计划/消息以 JSON 列保存，便于早期迭代）。
 * 后续可拆分 messages / steps / memory 等表，并加入向量检索。
 */
const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id         TEXT PRIMARY KEY,
    goal       TEXT NOT NULL,
    status     TEXT NOT NULL,
    plan       TEXT NOT NULL DEFAULT '[]',
    messages   TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

interface TaskRow {
  id: string;
  goal: string;
  status: string;
  plan: string;
  messages: string;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    goal: row.goal,
    status: row.status as Task['status'],
    plan: JSON.parse(row.plan),
    messages: JSON.parse(row.messages),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const taskStore = {
  save(task: Task): void {
    db.prepare(
      `INSERT INTO tasks (id, goal, status, plan, messages, created_at, updated_at)
       VALUES (@id, @goal, @status, @plan, @messages, @createdAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         goal=excluded.goal, status=excluded.status, plan=excluded.plan,
         messages=excluded.messages, updated_at=excluded.updated_at`,
    ).run({
      id: task.id,
      goal: task.goal,
      status: task.status,
      plan: JSON.stringify(task.plan),
      messages: JSON.stringify(task.messages),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
  },

  get(id: string): Task | undefined {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | TaskRow
      | undefined;
    return row ? rowToTask(row) : undefined;
  },

  list(): Task[] {
    const rows = db
      .prepare('SELECT * FROM tasks ORDER BY created_at DESC')
      .all() as TaskRow[];
    return rows.map(rowToTask);
  },
};
