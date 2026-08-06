import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSkillSettingsStore,
  createSettingsStore,
  createToolSettingsStore,
} from './settings-repository.js';

const databases: DatabaseType[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function makeDatabase(): DatabaseType {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      is_secret INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE tool_settings (
      name TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE skill_settings (
      name TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  databases.push(database);
  return database;
}

describe('settings repositories', () => {
  it('persists app values and replaces existing keys', () => {
    const store = createSettingsStore(makeDatabase());
    store.set('theme', 'dark');
    store.set('theme', 'light', true);

    expect(store.get('theme')).toBe('light');
    expect(store.entries()).toEqual({ theme: 'light' });
    store.delete('theme');
    expect(store.get('theme')).toBeUndefined();
  });

  it('keeps tool and skill enablement independent', () => {
    const database = makeDatabase();
    const tools = createToolSettingsStore(database);
    const skills = createSkillSettingsStore(database);

    tools.setEnabled('bash', false);
    skills.setEnabled('research', true);

    expect(tools.list()).toEqual(new Map([['bash', false]]));
    expect(skills.list()).toEqual(new Map([['research', true]]));
    expect(skills.isEnabled('missing')).toBeNull();
    expect(skills.isEnabled('research')).toBe(true);
  });
});
