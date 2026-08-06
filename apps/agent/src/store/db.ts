import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { config } from '../config.js';
import { runSchemaMigrations } from './migrations.js';
import { createAutomationStore } from './automation-repository.js';
import { createMemoryStore } from './memory-repository.js';
import { createMemorySummaryStore } from './memory-summary-repository.js';
import { createPiSessionTreeStore } from './session-tree-repository.js';
import { createProjectStore } from './project-repository.js';
import { createTaskAndTraceStores } from './task-repository.js';
import { createVectorStore } from './vector-repository.js';
import {
  createSkillSettingsStore,
  createSettingsStore,
  createToolSettingsStore,
} from './settings-repository.js';

/** 导出会话树快照类型，保持原有 db 模块导入路径兼容。 */
export type { PiSessionTreeSnapshotRow } from './session-tree-repository.js';

// 确保 SQLite 文件父目录存在（安装版 app bundle 内 cwd 只读，数据在 ~/.aurevoy/）。
mkdirSync(dirname(config.dbPath), { recursive: true });

const db: DatabaseType = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/** 导出 db 实例供 knowledge-base、LLM store 等基础设施使用。 */
export { db };

// 加载 sqlite-vec 向量扩展（失败时静默降级）。
try {
  sqliteVec.load(db);
  db.prepare('SELECT vec_version()').get();
} catch {
  console.warn('[db] sqlite-vec 加载失败，向量检索将降级为纯关键词');
}

const migrationResult = runSchemaMigrations(db, config.dbPath);
if (migrationResult.appliedMigrations.length > 0) {
  // stdout 可能承载回归子进程的 JSON 结果；启动诊断写 stderr，避免污染机器可读输出。
  console.warn('[db] schema migrated', {
    fromVersion: migrationResult.fromVersion,
    toVersion: migrationResult.toVersion,
    appliedMigrations: migrationResult.appliedMigrations,
    backupCreated: migrationResult.backupPath !== null,
  });
}

// repository 只接收已完成迁移的连接；db.ts 不再承载具体 SQL 读写实现。
const taskAndTraceStores = createTaskAndTraceStores(db);
export const { taskStore, traceStore } = taskAndTraceStores;
export const piSessionTreeStore = createPiSessionTreeStore(db);

export const memoryStore = createMemoryStore(db);

export const settingsStore = createSettingsStore(db);
export const toolSettingsStore = createToolSettingsStore(db);
export const skillSettingsStore = createSkillSettingsStore(db);

const memorySummaryStore = createMemorySummaryStore(db);
export const {
  getMemorySummary,
  setMemorySummary,
  invalidateMemorySummary,
} = memorySummaryStore;

const vectorStore = createVectorStore(db, () => memorySummaryStore.invalidateMemorySummary());
export const {
  isVecLoaded,
  serializeVector,
  deserializeVector,
  detectVectorDimensions,
  upsertMemoryVec,
  deleteMemoryVec,
  searchMemoryVec,
  upsertKbChunkVec,
  deleteKbChunkVec,
  searchKbChunkVec,
} = vectorStore;

export const projectStore = createProjectStore(db);
export const automationStore = createAutomationStore(db);
