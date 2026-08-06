import type { Database as DatabaseType } from 'better-sqlite3';
import type { Project } from '@aurevoy/shared';

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  created_at: string;
  updated_at: string;
}

/** 项目 repository 只依赖注入后的 SQLite 连接，不反向依赖总 db 模块。 */
export function createProjectStore(db: DatabaseType) {
  return {
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
      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
      return row ? rowToProject(row) : undefined;
    },

    getByPath(path: string): Project | undefined {
      const row = db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as ProjectRow | undefined;
      return row ? rowToProject(row) : undefined;
    },

    list(): Project[] {
      const rows = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as ProjectRow[];
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
