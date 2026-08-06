import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabaseBackup, checkDatabaseFile, restoreDatabaseBackup } from './database-maintenance.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'aurevoy-db-maintenance-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('database maintenance', () => {
  it('creates and validates a backup, then restores it offline', async () => {
    const root = makeRoot();
    const dbPath = join(root, 'aurevoy.sqlite');
    const backupPath = join(root, 'backup.sqlite');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE values_table (value TEXT NOT NULL); INSERT INTO values_table VALUES (\'before\')');

    const backup = await createDatabaseBackup(db, dbPath, backupPath);
    expect(backup).toMatchObject({ backupPath, quickCheck: 'ok' });
    db.prepare('UPDATE values_table SET value = \'after\'').run();
    db.close();

    const restored = restoreDatabaseBackup(dbPath, backupPath);
    expect(restored.quickCheck).toBe('ok');
    const restoredDb = new Database(dbPath, { readonly: true });
    expect(restoredDb.prepare('SELECT value FROM values_table').get()).toEqual({ value: 'before' });
    restoredDb.close();
    expect(checkDatabaseFile(backupPath).quickCheck).toBe('ok');
  });

  it('fails before writing when the disk-space check reports full', async () => {
    const root = makeRoot();
    const dbPath = join(root, 'aurevoy.sqlite');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE values_table (value TEXT NOT NULL); INSERT INTO values_table VALUES (\'before\')');

    await expect(
      createDatabaseBackup(db, dbPath, join(root, 'backup.sqlite'), {
        diskSpaceCheck: () => false,
      }),
    ).rejects.toThrow('Not enough disk space');
    expect(() => statSync(join(root, 'backup.sqlite'))).toThrow();
    db.close();
  });

  it('fails before replacing the target when restore space is unavailable', async () => {
    const root = makeRoot();
    const dbPath = join(root, 'aurevoy.sqlite');
    const backupPath = join(root, 'backup.sqlite');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE values_table (value TEXT NOT NULL); INSERT INTO values_table VALUES (\'before\')');
    await createDatabaseBackup(db, dbPath, backupPath);
    db.close();

    const target = new Database(dbPath);
    target.prepare('UPDATE values_table SET value = \'current\'').run();
    target.close();
    expect(() => restoreDatabaseBackup(dbPath, backupPath, { diskSpaceCheck: () => false })).toThrow(
      'Not enough disk space',
    );
    const unchanged = new Database(dbPath, { readonly: true });
    expect(unchanged.prepare('SELECT value FROM values_table').get()).toEqual({ value: 'current' });
    unchanged.close();
  });
});
