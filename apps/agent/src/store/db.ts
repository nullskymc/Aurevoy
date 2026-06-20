import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { MemoryEntry, Project, Task, TaskTraceEntry } from '@aurevoy/shared';
import { config } from '../config.js';

/**
 * 本地持久化层 (SQLite)。
 *
 * 当前用单表存储任务（计划/消息以 JSON 列保存，便于早期迭代）。
 * 后续可拆分 messages / steps / memory 等表，并加入向量检索。
 */

// 确保 SQLite 文件父目录存在（安装版 app bundle 内 cwd 只读，数据在 ~/.aurevoy/）
mkdirSync(dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id         TEXT PRIMARY KEY,
    goal       TEXT NOT NULL,
    status     TEXT NOT NULL,
    phase      TEXT,
    plan       TEXT NOT NULL DEFAULT '[]',
    messages   TEXT NOT NULL DEFAULT '[]',
    artifacts  TEXT NOT NULL DEFAULT '[]',
    clarifications TEXT NOT NULL DEFAULT '[]',
    pending_approvals TEXT NOT NULL DEFAULT '[]',
    approved_approval_keys TEXT NOT NULL DEFAULT '[]',
    checkpoints TEXT NOT NULL DEFAULT '[]',
    budget     TEXT,
    budget_usage TEXT,
    token_usage TEXT,
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

  CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    is_secret  INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tool_settings (
    name       TEXT PRIMARY KEY,
    enabled    INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    path       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_path
    ON projects(path);
`);

const taskColumns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
if (!taskColumns.some((column) => column.name === 'phase')) {
  db.exec('ALTER TABLE tasks ADD COLUMN phase TEXT');
}
const taskColumnMigrations: Array<{ name: string; sql: string }> = [
  { name: 'artifacts', sql: "ALTER TABLE tasks ADD COLUMN artifacts TEXT NOT NULL DEFAULT '[]'" },
  {
    name: 'clarifications',
    sql: "ALTER TABLE tasks ADD COLUMN clarifications TEXT NOT NULL DEFAULT '[]'",
  },
  { name: 'pending_approvals', sql: "ALTER TABLE tasks ADD COLUMN pending_approvals TEXT NOT NULL DEFAULT '[]'" },
  { name: 'approved_approval_keys', sql: "ALTER TABLE tasks ADD COLUMN approved_approval_keys TEXT NOT NULL DEFAULT '[]'" },
  { name: 'checkpoints', sql: "ALTER TABLE tasks ADD COLUMN checkpoints TEXT NOT NULL DEFAULT '[]'" },
  { name: 'budget', sql: 'ALTER TABLE tasks ADD COLUMN budget TEXT' },
  { name: 'budget_usage', sql: 'ALTER TABLE tasks ADD COLUMN budget_usage TEXT' },
  { name: 'token_usage', sql: 'ALTER TABLE tasks ADD COLUMN token_usage TEXT' },
  { name: 'archived_messages', sql: "ALTER TABLE tasks ADD COLUMN archived_messages TEXT NOT NULL DEFAULT '[]'" },
  { name: 'parent_task_id', sql: 'ALTER TABLE tasks ADD COLUMN parent_task_id TEXT' },
  { name: 'project_id', sql: 'ALTER TABLE tasks ADD COLUMN project_id TEXT' },
  { name: 'active_skills', sql: 'ALTER TABLE tasks ADD COLUMN active_skills TEXT' },
  { name: 'plan_mode', sql: 'ALTER TABLE tasks ADD COLUMN plan_mode TEXT' },
  { name: 'context_tokens', sql: 'ALTER TABLE tasks ADD COLUMN context_tokens INTEGER' },
];
for (const migration of taskColumnMigrations) {
  if (!taskColumns.some((column) => column.name === migration.name)) {
    db.exec(migration.sql);
  }
}

// P5: memory 表新增字段迁移
const memoryColumns = db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>;
const memoryColumnMigrations: Array<{ name: string; sql: string }> = [
  { name: 'name_slug', sql: 'ALTER TABLE memories ADD COLUMN name_slug TEXT' },
  { name: 'why', sql: 'ALTER TABLE memories ADD COLUMN why TEXT' },
  { name: 'how_to_apply', sql: 'ALTER TABLE memories ADD COLUMN how_to_apply TEXT' },
];
for (const migration of memoryColumnMigrations) {
  if (!memoryColumns.some((column) => column.name === migration.name)) {
    db.exec(migration.sql);
  }
}
// 确保 name_slug 索引存在（列必须在索引之前创建）
db.exec('CREATE INDEX IF NOT EXISTS idx_memories_name_slug ON memories(name_slug)');

interface TaskRow {
  id: string;
  goal: string;
  status: string;
  phase: string | null;
  plan: string;
  messages: string;
  artifacts: string;
  clarifications: string;
  pending_approvals: string;
  approved_approval_keys: string;
  checkpoints: string;
  budget: string | null;
  budget_usage: string | null;
  token_usage: string | null;
  archived_messages: string;
  parent_task_id: string | null;
  project_id: string | null;
  plan_mode: string | null;
  context_tokens: number | null;
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
    artifacts: (parseJsonColumn(row.artifacts) as Task['artifacts']) ?? [],
    clarifications: (parseJsonColumn(row.clarifications) as Task['clarifications']) ?? [],
    pendingApprovals: (parseJsonColumn(row.pending_approvals) as Task['pendingApprovals']) ?? [],
    approvedApprovalKeys: (parseJsonColumn(row.approved_approval_keys) as Task['approvedApprovalKeys']) ?? [],
    checkpoints: (parseJsonColumn(row.checkpoints) as Task['checkpoints']) ?? [],
    budget: (parseJsonColumn(row.budget) as Task['budget']) ?? undefined,
    budgetUsage: (parseJsonColumn(row.budget_usage) as Task['budgetUsage']) ?? undefined,
    tokenUsage: (parseJsonColumn(row.token_usage) as Task['tokenUsage']) ?? undefined,
    archivedMessages: (parseJsonColumn(row.archived_messages) as Task['archivedMessages']) ?? [],
    parentTaskId: row.parent_task_id ?? undefined,
    projectId: row.project_id ?? undefined,
    planMode: row.plan_mode === 'manual' ? 'manual' : undefined,
    contextTokens: row.context_tokens ?? undefined,
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
      `INSERT INTO tasks (
         id, goal, status, phase, plan, messages, artifacts, clarifications, pending_approvals, approved_approval_keys, checkpoints,
         budget, budget_usage, token_usage, archived_messages, parent_task_id, project_id,
         plan_mode, context_tokens, created_at, updated_at
       )
       VALUES (
         @id, @goal, @status, @phase, @plan, @messages, @artifacts, @clarifications,
         @pendingApprovals, @approvedApprovalKeys, @checkpoints, @budget, @budgetUsage, @tokenUsage, @archivedMessages, @parentTaskId,
         @projectId, @planMode, @contextTokens, @createdAt, @updatedAt
       )
       ON CONFLICT(id) DO UPDATE SET
         goal=excluded.goal, status=excluded.status, phase=excluded.phase, plan=excluded.plan,
         messages=excluded.messages, artifacts=excluded.artifacts,
         clarifications=excluded.clarifications, pending_approvals=excluded.pending_approvals,
         approved_approval_keys=excluded.approved_approval_keys,
         checkpoints=excluded.checkpoints,
         budget=excluded.budget, budget_usage=excluded.budget_usage,
         token_usage=excluded.token_usage, archived_messages=excluded.archived_messages,
         parent_task_id=excluded.parent_task_id, project_id=excluded.project_id,
         plan_mode=excluded.plan_mode,
         context_tokens=excluded.context_tokens,
         updated_at=excluded.updated_at`,
    ).run({
      id: task.id,
      goal: task.goal,
      status: task.status,
      phase: task.phase,
      plan: JSON.stringify(task.plan),
      messages: JSON.stringify(task.messages),
      artifacts: JSON.stringify(task.artifacts ?? []),
      clarifications: JSON.stringify(task.clarifications ?? []),
      pendingApprovals: JSON.stringify(task.pendingApprovals ?? []),
      approvedApprovalKeys: JSON.stringify(task.approvedApprovalKeys ?? []),
      checkpoints: JSON.stringify(task.checkpoints ?? []),
      budget: task.budget === undefined ? null : JSON.stringify(task.budget),
      budgetUsage: task.budgetUsage === undefined ? null : JSON.stringify(task.budgetUsage),
      tokenUsage: task.tokenUsage === undefined ? null : JSON.stringify(task.tokenUsage),
      archivedMessages: JSON.stringify(task.archivedMessages ?? []),
      parentTaskId: task.parentTaskId ?? null,
      projectId: task.projectId ?? null,
      planMode: task.planMode ?? null,
      contextTokens: task.contextTokens ?? null,
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

  listByProject(projectId: string | null): Task[] {
    if (projectId === null) {
      const rows = db
        .prepare('SELECT * FROM tasks WHERE project_id IS NULL ORDER BY created_at DESC')
        .all() as TaskRow[];
      return rows.map(rowToTask);
    }
    const rows = db
      .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as TaskRow[];
    return rows.map(rowToTask);
  },

  count(): number {
    const row = db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number };
    return row.count;
  },

  cleanupTerminal(olderThanDays: number): { deletedTasks: number; deletedTraces: number } {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const ids = db
      .prepare(
        `SELECT id FROM tasks
         WHERE updated_at < ?
           AND status IN ('completed', 'failed', 'cancelled')`,
      )
      .all(cutoff) as Array<{ id: string }>;
    if (ids.length === 0) return { deletedTasks: 0, deletedTraces: 0 };

    const deleteOne = db.transaction((taskIds: string[]) => {
      let deletedTraces = 0;
      let deletedTasks = 0;
      for (const id of taskIds) {
        deletedTraces += db.prepare('DELETE FROM task_traces WHERE task_id = ?').run(id).changes;
        deletedTasks += db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes;
      }
      return { deletedTasks, deletedTraces };
    });
    return deleteOne(ids.map((row) => row.id));
  },

  /** 删除单个任务及其关联轨迹 */
  delete(id: string): { deleted: boolean; deletedTraces: number } {
    const result = db.transaction(() => {
      const traces = db.prepare('DELETE FROM task_traces WHERE task_id = ?').run(id).changes;
      const task = db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes;
      return { deleted: task > 0, deletedTraces: traces };
    })();
    return result;
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

  count(): number {
    const row = db.prepare('SELECT COUNT(*) AS count FROM task_traces').get() as { count: number };
    return row.count;
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
  name_slug: string | null;
  why: string | null;
  how_to_apply: string | null;
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
    // linkedMemoryIds 从 content 中的 [[link]] 动态解析，不持久化独立列
  };
}

export const memoryStore = {
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

  update(id: string, patch: Partial<Pick<MemoryEntry, 'content' | 'category' | 'confidence' | 'enabled' | 'nameSlug' | 'why' | 'howToApply'>>): MemoryEntry | undefined {
    const current = this.get(id);
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
      updatedAt: new Date().toISOString(),
    };
    db.prepare(
      `UPDATE memories SET content=@content, category=@category, confidence=@confidence,
         enabled=@enabled, name_slug=@nameSlug, why=@why, how_to_apply=@howToApply,
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
      updatedAt: next.updatedAt,
    });
    return next;
  },

  /** P5: 按 nameSlug 查找记忆（用于 [[link]] 引用解析）。 */
  findByNameSlug(slug: string): MemoryEntry | undefined {
    const row = db.prepare('SELECT * FROM memories WHERE name_slug = ?').get(slug) as
      | MemoryRow
      | undefined;
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

export const settingsStore = {
  get(key: string): string | undefined {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  },

  set(key: string, value: string, isSecret = false): void {
    db.prepare(
      `INSERT INTO app_settings (key, value, is_secret, updated_at)
       VALUES (@key, @value, @isSecret, @updatedAt)
       ON CONFLICT(key) DO UPDATE SET
         value=excluded.value,
         is_secret=excluded.is_secret,
         updated_at=excluded.updated_at`,
    ).run({
      key,
      value,
      isSecret: isSecret ? 1 : 0,
      updatedAt: new Date().toISOString(),
    });
  },

  entries(): Record<string, string> {
    const rows = db.prepare('SELECT key, value FROM app_settings').all() as Array<{
      key: string;
      value: string;
    }>;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  },

  delete(key: string): void {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  },
};

export const toolSettingsStore = {
  setEnabled(name: string, enabled: boolean): void {
    db.prepare(
      `INSERT INTO tool_settings (name, enabled, updated_at)
       VALUES (@name, @enabled, @updatedAt)
       ON CONFLICT(name) DO UPDATE SET
         enabled=excluded.enabled,
         updated_at=excluded.updated_at`,
    ).run({
      name,
      enabled: enabled ? 1 : 0,
      updatedAt: new Date().toISOString(),
    });
  },

  list(): Map<string, boolean> {
    const rows = db.prepare('SELECT name, enabled FROM tool_settings').all() as Array<{
      name: string;
      enabled: number;
    }>;
    return new Map(rows.map((row) => [row.name, row.enabled === 1]));
  },
};

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  created_at: string;
  updated_at: string;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const projectStore = {
  create(project: Project): Project {
    db.prepare(
      `INSERT INTO projects (id, name, path, created_at, updated_at)
       VALUES (@id, @name, @path, @createdAt, @updatedAt)`,
    ).run({
      id: project.id,
      name: project.name,
      path: project.path,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });
    return project;
  },

  get(id: string): Project | undefined {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | ProjectRow
      | undefined;
    return row ? rowToProject(row) : undefined;
  },

  getByPath(path: string): Project | undefined {
    const row = db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as
      | ProjectRow
      | undefined;
    return row ? rowToProject(row) : undefined;
  },

  list(): Project[] {
    const rows = db
      .prepare('SELECT * FROM projects ORDER BY created_at DESC')
      .all() as ProjectRow[];
    return rows.map(rowToProject);
  },

  update(id: string, patch: { name?: string }): Project | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next: Project = {
      ...current,
      name: patch.name ?? current.name,
      updatedAt: new Date().toISOString(),
    };
    db.prepare(
      'UPDATE projects SET name = @name, updated_at = @updatedAt WHERE id = @id',
    ).run({ id, name: next.name, updatedAt: next.updatedAt });
    return next;
  },

  delete(id: string): { deleted: boolean; orphanedTasks: number } {
    const orphanedTasks = db
      .prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?')
      .run(id).changes;
    const info = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return { deleted: info.changes > 0, orphanedTasks };
  },

  count(): number {
    const row = db.prepare('SELECT COUNT(*) AS count FROM projects').get() as { count: number };
    return row.count;
  },
};
