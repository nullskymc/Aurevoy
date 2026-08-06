import {
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';

/** 当前 SQLite schema 版本；升级只能通过下面的有序迁移完成。 */
export const CURRENT_SCHEMA_VERSION = 6;

export interface DatabaseMigrationResult {
  fromVersion: number;
  toVersion: number;
  backupPath: string | null;
  appliedMigrations: string[];
}

interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseType) => void;
}

interface ColumnMigration {
  name: string;
  sql: string;
}

/** 读取 SQLite 的 user_version，并拒绝未来版本的数据库。 */
function readUserVersion(db: DatabaseType): number {
  const value = db.pragma('user_version', { simple: true });
  const version = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`SQLite schema version is invalid: ${String(value)}`);
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `SQLite schema version ${version} is newer than this Aurevoy build supports (max ${CURRENT_SCHEMA_VERSION})`,
    );
  }
  return version;
}

/** 迁移中只接收源码内固定列名，避免把动态标识符直接拼入 SQL。 */
function addMissingColumns(db: DatabaseType, table: string, migrations: readonly ColumnMigration[]): void {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
  );
  for (const migration of migrations) {
    if (!columns.has(migration.name)) {
      db.exec(migration.sql);
      columns.add(migration.name);
    }
  }
}

/** v1 保存最初的产品数据模型；新库也从这里开始，以便迁移链可重放。 */
function createInitialSchema(db: DatabaseType): void {
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

    CREATE TABLE IF NOT EXISTS message_parts (
      id         TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      type       TEXT NOT NULL CHECK (type = 'image'),
      data       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_message_parts_task_message
      ON message_parts(task_id, message_id);

    CREATE TABLE IF NOT EXISTS pi_session_trees (
      task_id       TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      version       INTEGER NOT NULL,
      entries       TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memories (
      id             TEXT PRIMARY KEY,
      category       TEXT NOT NULL,
      content        TEXT NOT NULL,
      confidence     REAL NOT NULL DEFAULT 1,
      enabled        INTEGER NOT NULL DEFAULT 1,
      origin         TEXT NOT NULL,
      source_task_id TEXT,
      source_task_goal TEXT,
      source_created_at TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
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
    CREATE TABLE IF NOT EXISTS skill_settings (
      name       TEXT PRIMARY KEY,
      enabled    INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      path       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_path ON projects(path);
  `);
}

/** v2 把历史上的补列、知识库和多 Provider 表纳入统一事务。 */
function addCurrentSchema(db: DatabaseType): void {
  addMissingColumns(db, 'tasks', [
    { name: 'phase', sql: 'ALTER TABLE tasks ADD COLUMN phase TEXT' },
    { name: 'artifacts', sql: "ALTER TABLE tasks ADD COLUMN artifacts TEXT NOT NULL DEFAULT '[]'" },
    { name: 'clarifications', sql: "ALTER TABLE tasks ADD COLUMN clarifications TEXT NOT NULL DEFAULT '[]'" },
    { name: 'pending_approvals', sql: "ALTER TABLE tasks ADD COLUMN pending_approvals TEXT NOT NULL DEFAULT '[]'" },
    { name: 'approved_approval_keys', sql: "ALTER TABLE tasks ADD COLUMN approved_approval_keys TEXT NOT NULL DEFAULT '[]'" },
    { name: 'checkpoints', sql: "ALTER TABLE tasks ADD COLUMN checkpoints TEXT NOT NULL DEFAULT '[]'" },
    { name: 'budget', sql: 'ALTER TABLE tasks ADD COLUMN budget TEXT' },
    { name: 'budget_usage', sql: 'ALTER TABLE tasks ADD COLUMN budget_usage TEXT' },
    { name: 'lifetime_budget', sql: 'ALTER TABLE tasks ADD COLUMN lifetime_budget TEXT' },
    { name: 'lifetime_usage', sql: 'ALTER TABLE tasks ADD COLUMN lifetime_usage TEXT' },
    { name: 'budget_exceeded', sql: 'ALTER TABLE tasks ADD COLUMN budget_exceeded TEXT' },
    { name: 'token_usage', sql: 'ALTER TABLE tasks ADD COLUMN token_usage TEXT' },
    { name: 'archived_messages', sql: "ALTER TABLE tasks ADD COLUMN archived_messages TEXT NOT NULL DEFAULT '[]'" },
    { name: 'parent_task_id', sql: 'ALTER TABLE tasks ADD COLUMN parent_task_id TEXT' },
    { name: 'project_id', sql: 'ALTER TABLE tasks ADD COLUMN project_id TEXT' },
    { name: 'active_skills', sql: 'ALTER TABLE tasks ADD COLUMN active_skills TEXT' },
    { name: 'plan_mode', sql: 'ALTER TABLE tasks ADD COLUMN plan_mode TEXT' },
    { name: 'auto_mode_state', sql: 'ALTER TABLE tasks ADD COLUMN auto_mode_state TEXT' },
    { name: 'context_tokens', sql: 'ALTER TABLE tasks ADD COLUMN context_tokens INTEGER' },
    { name: 'title', sql: 'ALTER TABLE tasks ADD COLUMN title TEXT' },
    { name: 'title_source', sql: 'ALTER TABLE tasks ADD COLUMN title_source TEXT' },
    { name: 'subagent_runs', sql: "ALTER TABLE tasks ADD COLUMN subagent_runs TEXT NOT NULL DEFAULT '[]'" },
    { name: 'automation_id', sql: 'ALTER TABLE tasks ADD COLUMN automation_id TEXT' },
  ]);

  addMissingColumns(db, 'pi_session_trees', [
    { name: 'message_ids', sql: "ALTER TABLE pi_session_trees ADD COLUMN message_ids TEXT NOT NULL DEFAULT '[]'" },
    { name: 'message_links', sql: "ALTER TABLE pi_session_trees ADD COLUMN message_links TEXT NOT NULL DEFAULT '[]'" },
  ]);

  addMissingColumns(db, 'memories', [
    { name: 'name_slug', sql: 'ALTER TABLE memories ADD COLUMN name_slug TEXT' },
    { name: 'why', sql: 'ALTER TABLE memories ADD COLUMN why TEXT' },
    { name: 'how_to_apply', sql: 'ALTER TABLE memories ADD COLUMN how_to_apply TEXT' },
    { name: 'embedding_updated_at', sql: 'ALTER TABLE memories ADD COLUMN embedding_updated_at TEXT' },
  ]);
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_name_slug ON memories(name_slug)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS automations (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      goal           TEXT NOT NULL,
      project_id     TEXT,
      execution_mode TEXT NOT NULL DEFAULT 'auto',
      budget         TEXT,
      lifetime_budget TEXT,
      cadence        TEXT NOT NULL DEFAULT 'manual',
      enabled        INTEGER NOT NULL DEFAULT 0,
      next_run_at    TEXT,
      last_run_at    TEXT,
      last_task_id   TEXT,
      last_status    TEXT,
      last_error     TEXT,
      run_count      INTEGER NOT NULL DEFAULT 0,
      failure_count  INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_automations_due ON automations(enabled, next_run_at);
    CREATE TABLE IF NOT EXISTS automation_runs (
      id            TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      task_id       TEXT NOT NULL,
      status        TEXT NOT NULL,
      started_at    TEXT NOT NULL,
      finished_at   TEXT,
      error         TEXT,
      FOREIGN KEY(automation_id) REFERENCES automations(id) ON DELETE CASCADE,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_automation_runs_automation
      ON automation_runs(automation_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS kb_dirs (
      id TEXT PRIMARY KEY, dir_path TEXT NOT NULL UNIQUE,
      recursive INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kb_files (
      id TEXT PRIMARY KEY, dir_id TEXT NOT NULL,
      file_path TEXT NOT NULL, file_hash TEXT NOT NULL,
      mtime TEXT NOT NULL, chunk_count INTEGER NOT NULL DEFAULT 0,
      indexed_at TEXT NOT NULL,
      FOREIGN KEY(dir_id) REFERENCES kb_dirs(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_files_path ON kb_files(file_path);
    CREATE TABLE IF NOT EXISTS kb_chunks (
      id TEXT PRIMARY KEY, file_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL, content TEXT NOT NULL,
      char_count INTEGER NOT NULL, embedding_updated_at TEXT,
      FOREIGN KEY(file_id) REFERENCES kb_files(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS memory_summary (
      key TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      citations TEXT,
      scored_ids TEXT NOT NULL,
      total_enabled INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS llm_global (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      active_provider TEXT NOT NULL DEFAULT 'openai',
      vision_model    TEXT NOT NULL DEFAULT '',
      temperature     REAL NOT NULL DEFAULT 0.7,
      timeout_ms      INTEGER NOT NULL DEFAULT 120000,
      max_tokens      INTEGER NOT NULL DEFAULT 8192,
      updated_at      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_providers (
      provider_id   TEXT PRIMARY KEY,
      base_url      TEXT NOT NULL DEFAULT '',
      default_model TEXT NOT NULL DEFAULT '',
      max_tokens    INTEGER,
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_credentials (
      provider_id      TEXT PRIMARY KEY
                       REFERENCES llm_providers(provider_id) ON DELETE CASCADE,
      auth_type        TEXT NOT NULL CHECK (auth_type IN ('api_key', 'oauth')),
      api_key          TEXT,
      oauth_access     TEXT,
      oauth_refresh    TEXT,
      oauth_expires_at TEXT,
      oauth_extra_json TEXT,
      updated_at       TEXT NOT NULL,
      CHECK (
        (auth_type = 'api_key' AND api_key IS NOT NULL AND oauth_access IS NULL)
        OR
        (auth_type = 'oauth' AND oauth_access IS NOT NULL AND api_key IS NULL)
      )
    );
    CREATE TABLE IF NOT EXISTS llm_models (
      provider_id TEXT NOT NULL REFERENCES llm_providers(provider_id) ON DELETE CASCADE,
      model_id    TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'remote'
                  CHECK (source IN ('remote', 'static', 'custom')),
      enabled     INTEGER NOT NULL DEFAULT 0,
      is_default  INTEGER NOT NULL DEFAULT 0,
      supports_image INTEGER NOT NULL DEFAULT 0,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (provider_id, model_id)
    );
    CREATE INDEX IF NOT EXISTS idx_llm_models_enabled ON llm_models(provider_id, enabled);
  `);
}

/** v3 将 MCP 的远程请求头与 stdio 敏感环境变量独立存储，设置 JSON 只保留占位符。 */
function addMcpCredentialSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_credentials (
      server_name TEXT NOT NULL,
      field_name  TEXT NOT NULL,
      value       TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (server_name, field_name)
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_credentials_server
      ON mcp_credentials(server_name);
  `);
}

/** v4 持久化文件变更摘要；只保存计数和路径，不复制文件正文。 */
function addFileChangeSchema(db: DatabaseType): void {
  addMissingColumns(db, 'tasks', [
    { name: 'file_changes', sql: "ALTER TABLE tasks ADD COLUMN file_changes TEXT NOT NULL DEFAULT '[]'" },
  ]);
}

/** v5 持久化最近一轮记忆/知识库召回的状态摘要，不保存召回正文。 */
function addRecallSummarySchema(db: DatabaseType): void {
  addMissingColumns(db, 'tasks', [
    { name: 'recall_summary', sql: 'ALTER TABLE tasks ADD COLUMN recall_summary TEXT' },
  ]);
}

/** v6 持久化重启恢复标记，使刷新页面/重新打开任务仍能解释自动续跑。 */
function addRestartRecoverySchema(db: DatabaseType): void {
  addMissingColumns(db, 'tasks', [
    { name: 'resumed_after_restart', sql: 'ALTER TABLE tasks ADD COLUMN resumed_after_restart INTEGER NOT NULL DEFAULT 0' },
  ]);
}

const migrations: readonly Migration[] = [
  { version: 1, name: 'initial-schema', up: createInitialSchema },
  { version: 2, name: 'current-product-schema', up: addCurrentSchema },
  { version: 3, name: 'mcp-credential-store', up: addMcpCredentialSchema },
  { version: 4, name: 'task-file-change-summary', up: addFileChangeSchema },
  { version: 5, name: 'task-recall-summary', up: addRecallSummarySchema },
  { version: 6, name: 'restart-recovery-marker', up: addRestartRecoverySchema },
];

/** 在迁移前做一次可恢复的文件级备份；WAL 先 checkpoint，避免只复制主库漏掉 WAL 页面。 */
function backupBeforeMigration(db: DatabaseType, dbPath: string, targetVersion: number): string | null {
  if (!existsSync(dbPath)) return null;
  try {
    if (statSync(dbPath).size === 0) return null;
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (error) {
    throw new Error(
      `SQLite migration backup could not checkpoint the database: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const directory = dirname(dbPath);
  mkdirSync(directory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = resolve(directory, `${basename(dbPath)}.backup-v${targetVersion}-${timestamp}`);
  copyFileSync(dbPath, backupPath);
  return backupPath;
}

/**
 * 初始化或升级 SQLite schema。
 *
 * 所有迁移在同一事务中执行；失败时 SQLite 自动回滚，迁移前备份保留给恢复流程使用。
 */
export function runSchemaMigrations(db: DatabaseType, dbPath: string): DatabaseMigrationResult {
  const fromVersion = readUserVersion(db);
  const pending = migrations.filter((migration) => migration.version > fromVersion);
  if (pending.length === 0) {
    return { fromVersion, toVersion: fromVersion, backupPath: null, appliedMigrations: [] };
  }

  const backupPath = backupBeforeMigration(db, dbPath, pending[pending.length - 1].version);
  const appliedMigrations: string[] = [];
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        name      TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const record = db.prepare(
      'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
    );
    for (const migration of pending) {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      record.run(migration.version, migration.name, new Date().toISOString());
      appliedMigrations.push(migration.name);
    }
  });

  try {
    migrate();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `SQLite schema migration failed at ${appliedMigrations.at(-1) ?? 'before first migration'}; backupCreated=${backupPath !== null}: ${detail}`,
      { cause: error },
    );
  }

  return {
    fromVersion,
    toVersion: pending[pending.length - 1].version,
    backupPath,
    appliedMigrations,
  };
}

/** 供健康诊断和测试使用的只读 schema 状态。 */
export function readSchemaStatus(db: DatabaseType): { version: number; expectedVersion: number; migrationCount: number } {
  const version = readUserVersion(db);
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { name?: string } | undefined;
  const migrationCount = table
    ? Number((db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number }).count)
    : 0;
  return { version, expectedVersion: CURRENT_SCHEMA_VERSION, migrationCount };
}
