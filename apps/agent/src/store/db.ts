import Database from 'better-sqlite3';
import type { MemoryEntry, Task, TaskTraceEntry } from '@aurevoy/shared';
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
    phase      TEXT,
    plan       TEXT NOT NULL DEFAULT '[]',
    messages   TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_traces (
    id             TEXT PRIMARY KEY,
    task_id        TEXT NOT NULL,
    kind           TEXT NOT NULL,
    phase          TEXT,
    iteration      INTEGER,
    call_id        TEXT,
    tool_name      TEXT,
    risk_level     TEXT,
    provider       TEXT,
    model          TEXT,
    finish_reason  TEXT,
    token_usage    TEXT,
    started_at     TEXT NOT NULL,
    ended_at       TEXT,
    duration_ms    INTEGER,
    ok             INTEGER,
    error_category TEXT,
    error_message  TEXT,
    summary        TEXT,
    data           TEXT,
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_task_traces_task_started
    ON task_traces(task_id, started_at);

  CREATE TABLE IF NOT EXISTS memories (
    id            TEXT PRIMARY KEY,
    category      TEXT NOT NULL,
    content       TEXT NOT NULL,
    confidence    REAL NOT NULL DEFAULT 1,
    enabled       INTEGER NOT NULL DEFAULT 1,
    origin        TEXT NOT NULL,
    source_task_id TEXT,
    source_task_goal TEXT,
    source_created_at TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memories_enabled
    ON memories(enabled, updated_at);
`);

const taskColumns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
if (!taskColumns.some((column) => column.name === 'phase')) {
  db.exec('ALTER TABLE tasks ADD COLUMN phase TEXT');
}

interface TaskRow {
  id: string;
  goal: string;
  status: string;
  phase: string | null;
  plan: string;
  messages: string;
  created_at: string;
  updated_at: string;
}

interface TaskTraceRow {
  id: string;
  task_id: string;
  kind: string;
  phase: string | null;
  iteration: number | null;
  call_id: string | null;
  tool_name: string | null;
  risk_level: string | null;
  provider: string | null;
  model: string | null;
  finish_reason: string | null;
  token_usage: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  ok: number | null;
  error_category: string | null;
  error_message: string | null;
  summary: string | null;
  data: string | null;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    goal: row.goal,
    status: row.status as Task['status'],
    phase: (row.phase as Task['phase']) ?? null,
    plan: JSON.parse(row.plan),
    messages: JSON.parse(row.messages),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJsonColumn(value: string | null): unknown {
  if (value == null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function rowToTrace(row: TaskTraceRow): TaskTraceEntry {
  const tokenUsage = parseJsonColumn(row.token_usage) as TaskTraceEntry['tokenUsage'] | undefined;
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind as TaskTraceEntry['kind'],
    phase: (row.phase as TaskTraceEntry['phase']) ?? null,
    iteration: row.iteration ?? undefined,
    callId: row.call_id ?? undefined,
    toolName: row.tool_name ?? undefined,
    riskLevel: (row.risk_level as TaskTraceEntry['riskLevel']) ?? undefined,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    finishReason: row.finish_reason ?? undefined,
    tokenUsage: tokenUsage === undefined ? null : tokenUsage,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    ok: row.ok == null ? undefined : row.ok === 1,
    errorCategory: (row.error_category as TaskTraceEntry['errorCategory']) ?? undefined,
    errorMessage: row.error_message ?? undefined,
    summary: row.summary ?? undefined,
    data: parseJsonColumn(row.data),
  };
}

function nullable<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

export const taskStore = {
  save(task: Task): void {
    db.prepare(
      `INSERT INTO tasks (id, goal, status, phase, plan, messages, created_at, updated_at)
       VALUES (@id, @goal, @status, @phase, @plan, @messages, @createdAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         goal=excluded.goal, status=excluded.status, phase=excluded.phase, plan=excluded.plan,
         messages=excluded.messages, updated_at=excluded.updated_at`,
    ).run({
      id: task.id,
      goal: task.goal,
      status: task.status,
      phase: task.phase,
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

export const traceStore = {
  append(entry: TaskTraceEntry): void {
    db.prepare(
      `INSERT INTO task_traces (
         id, task_id, kind, phase, iteration, call_id, tool_name, risk_level,
         provider, model, finish_reason, token_usage, started_at, ended_at,
         duration_ms, ok, error_category, error_message, summary, data
       ) VALUES (
         @id, @taskId, @kind, @phase, @iteration, @callId, @toolName, @riskLevel,
         @provider, @model, @finishReason, @tokenUsage, @startedAt, @endedAt,
         @durationMs, @ok, @errorCategory, @errorMessage, @summary, @data
       )`,
    ).run({
      id: entry.id,
      taskId: entry.taskId,
      kind: entry.kind,
      phase: nullable(entry.phase),
      iteration: nullable(entry.iteration),
      callId: nullable(entry.callId),
      toolName: nullable(entry.toolName),
      riskLevel: nullable(entry.riskLevel),
      provider: nullable(entry.provider),
      model: nullable(entry.model),
      finishReason: nullable(entry.finishReason),
      tokenUsage: JSON.stringify(entry.tokenUsage),
      startedAt: entry.startedAt,
      endedAt: nullable(entry.endedAt),
      durationMs: nullable(entry.durationMs),
      ok: entry.ok == null ? null : entry.ok ? 1 : 0,
      errorCategory: nullable(entry.errorCategory),
      errorMessage: nullable(entry.errorMessage),
      summary: nullable(entry.summary),
      data: entry.data === undefined ? null : JSON.stringify(entry.data),
    });
  },

  list(taskId: string): TaskTraceEntry[] {
    const rows = db
      .prepare('SELECT * FROM task_traces WHERE task_id = ? ORDER BY started_at ASC')
      .all(taskId) as TaskTraceRow[];
    return rows.map(rowToTrace);
  },
};

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
  };
}

export const memoryStore = {
  create(entry: MemoryEntry): MemoryEntry {
    db.prepare(
      `INSERT INTO memories (
         id, category, content, confidence, enabled, origin,
         source_task_id, source_task_goal, source_created_at, created_at, updated_at
       ) VALUES (
         @id, @category, @content, @confidence, @enabled, @origin,
         @sourceTaskId, @sourceTaskGoal, @sourceCreatedAt, @createdAt, @updatedAt
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
    });
    return entry;
  },

  get(id: string): MemoryEntry | undefined {
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    return row ? rowToMemory(row) : undefined;
  },

  list(): MemoryEntry[] {
    const rows = db
      .prepare('SELECT * FROM memories ORDER BY updated_at DESC')
      .all() as MemoryRow[];
    return rows.map(rowToMemory);
  },

  /** 仅启用的记忆，用于注入 Agent 上下文（按更新时间升序，稳定排列）。 */
  listEnabled(): MemoryEntry[] {
    const rows = db
      .prepare('SELECT * FROM memories WHERE enabled = 1 ORDER BY updated_at ASC')
      .all() as MemoryRow[];
    return rows.map(rowToMemory);
  },

  update(id: string, patch: Partial<Pick<MemoryEntry, 'content' | 'category' | 'confidence' | 'enabled'>>): MemoryEntry | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next: MemoryEntry = {
      ...current,
      content: patch.content ?? current.content,
      category: patch.category ?? current.category,
      confidence: patch.confidence ?? current.confidence,
      enabled: patch.enabled ?? current.enabled,
      updatedAt: new Date().toISOString(),
    };
    db.prepare(
      `UPDATE memories SET content=@content, category=@category, confidence=@confidence,
         enabled=@enabled, updated_at=@updatedAt WHERE id=@id`,
    ).run({
      id,
      content: next.content,
      category: next.category,
      confidence: next.confidence,
      enabled: next.enabled ? 1 : 0,
      updatedAt: next.updatedAt,
    });
    return next;
  },

  delete(id: string): boolean {
    const info = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    return info.changes > 0;
  },
};
