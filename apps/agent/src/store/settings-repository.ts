import type { Database as DatabaseType } from 'better-sqlite3';

/** 应用级设置、工具开关和 Skill 开关的独立持久化边界。 */
export function createSettingsStore(db: DatabaseType) {
  return {
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
}

export function createToolSettingsStore(db: DatabaseType) {
  return createBooleanSettingsStore(db, 'tool_settings');
}

export function createSkillSettingsStore(db: DatabaseType) {
  const base = createBooleanSettingsStore(db, 'skill_settings');
  return {
    ...base,

    isEnabled(name: string): boolean | null {
      const row = db.prepare(
        'SELECT enabled FROM skill_settings WHERE name = ?',
      ).get(name) as { enabled: number } | undefined;
      return row ? row.enabled === 1 : null; // null = 未设置，由上层决定默认值
    },
  };
}

function createBooleanSettingsStore(db: DatabaseType, table: 'tool_settings' | 'skill_settings') {
  return {
    setEnabled(name: string, enabled: boolean): void {
      db.prepare(
        `INSERT INTO ${table} (name, enabled, updated_at)
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
      const rows = db.prepare(`SELECT name, enabled FROM ${table}`).all() as Array<{
        name: string;
        enabled: number;
      }>;
      return new Map(rows.map((row) => [row.name, row.enabled === 1]));
    },
  };
}
