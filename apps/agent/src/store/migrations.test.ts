import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, readSchemaStatus, runSchemaMigrations } from './migrations.js';

const roots: string[] = [];

function makeDatabasePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'aurevoy-migration-'));
  roots.push(root);
  return join(root, 'aurevoy.sqlite');
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('SQLite schema migrations', () => {
  it('creates the current schema in one versioned chain', () => {
    const path = makeDatabasePath();
    const db = new Database(path);

    const result = runSchemaMigrations(db, path);

    expect(result).toMatchObject({
      fromVersion: 0,
      toVersion: CURRENT_SCHEMA_VERSION,
      backupPath: null,
      appliedMigrations: ['initial-schema', 'current-product-schema', 'mcp-credential-store', 'task-file-change-summary', 'task-recall-summary', 'restart-recovery-marker'],
    });
    expect(readSchemaStatus(db)).toEqual({
      version: CURRENT_SCHEMA_VERSION,
      expectedVersion: CURRENT_SCHEMA_VERSION,
      migrationCount: 6,
    });
    expect((db.prepare('PRAGMA quick_check(1)').get() as { quick_check: string }).quick_check).toBe('ok');
    expect(db.prepare('PRAGMA table_info(tasks)').all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'clarifications' }),
        expect.objectContaining({ name: 'automation_id' }),
      ]),
    );
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_credentials'").get())
      .toEqual({ name: 'mcp_credentials' });
    expect(db.prepare('PRAGMA table_info(tasks)').all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'file_changes' }),
        expect.objectContaining({ name: 'recall_summary' }),
        expect.objectContaining({ name: 'resumed_after_restart' }),
      ]),
    );
    db.close();
  });

  it('backs up an existing legacy database and preserves its data', () => {
    const path = makeDatabasePath();
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT '[]',
        messages TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO tasks(id, goal, status, created_at, updated_at)
      VALUES ('legacy-1', 'keep this task', 'completed', '2026-08-06', '2026-08-06');
    `);
    legacy.close();

    const db = new Database(path);
    const result = runSchemaMigrations(db, path);

    expect(result.backupPath).toBeTruthy();
    expect(statSync(result.backupPath as string).size).toBeGreaterThan(0);
    expect(readFileSync(result.backupPath as string).subarray(0, 16).toString()).toContain('SQLite format 3');
    expect(db.prepare('SELECT goal FROM tasks WHERE id = ?').get('legacy-1')).toEqual({ goal: 'keep this task' });
    expect((db.prepare('PRAGMA quick_check(1)').get() as { quick_check: string }).quick_check).toBe('ok');
    db.close();
  });

  it('rolls back schema changes when a legacy object blocks migration', () => {
    const path = makeDatabasePath();
    const db = new Database(path);
    db.exec('CREATE VIEW tasks AS SELECT 1 AS id');

    expect(() => runSchemaMigrations(db, path)).toThrow(/SQLite schema migration failed/);
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(0);
    expect(db.prepare("SELECT type FROM sqlite_master WHERE name = 'tasks'").get()).toEqual({ type: 'view' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").get()).toBeUndefined();
    db.close();
  });
});
