import type { Database as DatabaseType } from 'better-sqlite3';
import type {
  Automation,
  AutomationCadence,
  AutomationRun,
  AutomationRunStatus,
} from '@aurevoy/shared';

interface AutomationRow {
  id: string;
  name: string;
  goal: string;
  project_id: string | null;
  execution_mode: string;
  budget: string | null;
  lifetime_budget: string | null;
  cadence: string;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_task_id: string | null;
  last_status: string | null;
  last_error: string | null;
  run_count: number;
  failure_count: number;
  created_at: string;
  updated_at: string;
}

interface AutomationRunRow {
  id: string;
  automation_id: string;
  task_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

const ACTIVE_AUTOMATION_STATUSES: readonly AutomationRunStatus[] = [
  'running',
  'waiting_approval',
  'waiting_clarification',
  'waiting_budget',
  'waiting_completion',
];

/** 自动化 repository 只依赖注入后的 SQLite 连接，避免调度和路由反向依赖总 db 模块。 */
export function createAutomationStore(db: DatabaseType) {
  function get(id: string): Automation | undefined {
    const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as AutomationRow | undefined;
    return row ? rowToAutomation(row) : undefined;
  }

  return {
    create(automation: Automation): Automation {
      db.prepare(
        `INSERT INTO automations (
          id, name, goal, project_id, execution_mode, budget, lifetime_budget, cadence,
          enabled, next_run_at, last_run_at, last_task_id, last_status, last_error,
          run_count, failure_count, created_at, updated_at
        ) VALUES (
          @id, @name, @goal, @projectId, @executionMode, @budget, @lifetimeBudget, @cadence,
          @enabled, @nextRunAt, @lastRunAt, @lastTaskId, @lastStatus, @lastError,
          @runCount, @failureCount, @createdAt, @updatedAt
        )`,
      ).run(automationParams(automation));
      return automation;
    },

    get,

    list(): Automation[] {
      const rows = db.prepare('SELECT * FROM automations ORDER BY updated_at DESC').all() as AutomationRow[];
      return rows.map(rowToAutomation);
    },

    update(
      id: string,
      patch: Partial<Pick<Automation, 'name' | 'goal' | 'executionMode' | 'budget' | 'lifetimeBudget' | 'cadence' | 'enabled'>> & { projectId?: string | null; nextRunAt?: string | null },
    ): Automation | undefined {
      const current = get(id);
      if (!current) return undefined;
      const next: Automation = {
        ...current,
        name: patch.name ?? current.name,
        goal: patch.goal ?? current.goal,
        executionMode: patch.executionMode ?? current.executionMode,
        cadence: patch.cadence ?? current.cadence,
        enabled: patch.enabled ?? current.enabled,
        projectId: patch.projectId === null ? undefined : (patch.projectId ?? current.projectId),
        budget: patch.budget !== undefined ? patch.budget : current.budget,
        lifetimeBudget: patch.lifetimeBudget !== undefined ? patch.lifetimeBudget : current.lifetimeBudget,
        nextRunAt: patch.nextRunAt !== undefined ? (patch.nextRunAt ?? undefined) : current.nextRunAt,
        updatedAt: new Date().toISOString(),
      };
      db.prepare(
        `UPDATE automations SET
          name=@name, goal=@goal, project_id=@projectId, execution_mode=@executionMode,
          budget=@budget, lifetime_budget=@lifetimeBudget, cadence=@cadence, enabled=@enabled,
          next_run_at=@nextRunAt, updated_at=@updatedAt
         WHERE id=@id`,
      ).run(automationParams(next));
      return next;
    },

    delete(id: string): boolean {
      return db.prepare('DELETE FROM automations WHERE id = ?').run(id).changes > 0;
    },

    /** 原子地占用一个到期配方，避免 scheduler tick 重入产生重复任务。 */
    claimForRun(id: string, now: string, force = false): Automation | undefined {
      const current = get(id);
      if (!current || (current.lastStatus && ACTIVE_AUTOMATION_STATUSES.includes(current.lastStatus))) return undefined;
      if (!force && (!current.enabled || current.cadence === 'manual')) return undefined;
      if (!force && current.nextRunAt && current.nextRunAt > now) return undefined;
      const result = db.prepare(
        `UPDATE automations SET
           last_run_at=@now, last_status='running', last_error=NULL,
           run_count=run_count + 1, updated_at=@now
         WHERE id=@id AND last_status IS NOT 'running'`,
      ).run({ id, now });
      return result.changes > 0 ? get(id) : undefined;
    },

    setLastTask(id: string, taskId: string): Automation | undefined {
      db.prepare('UPDATE automations SET last_task_id = ?, updated_at = ? WHERE id = ?')
        .run(taskId, new Date().toISOString(), id);
      return get(id);
    },

    failClaim(id: string, error: string, nextRunAt: string | undefined): Automation | undefined {
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE automations SET last_status='failed', last_error=?, next_run_at=?,
         failure_count=failure_count + 1, updated_at=? WHERE id=?`,
      ).run(error, nextRunAt ?? null, now, id);
      return get(id);
    },

    /** 运行记录进入等待态时只更新状态，不增加失败次数，也不推进下一次计划。 */
    setRunStatus(runId: string, status: AutomationRunStatus): Automation | undefined {
      const now = new Date().toISOString();
      const run = db.prepare('SELECT automation_id FROM automation_runs WHERE id = ?').get(runId) as { automation_id: string } | undefined;
      if (!run) return undefined;
      db.transaction(() => {
        db.prepare('UPDATE automation_runs SET status = ?, error = NULL WHERE id = ?').run(status, runId);
        db.prepare('UPDATE automations SET last_status = ?, last_error = NULL, updated_at = ? WHERE id = ?')
          .run(status, now, run.automation_id);
      })();
      return get(run.automation_id);
    },

    /** 引擎启动后若发现只完成了 claim、没有留下 run 记录，则解除悬挂占用并安排重试。 */
    recoverOrphanedClaims(now = new Date().toISOString()): number {
      const result = db.prepare(`
        UPDATE automations
        SET last_status = 'failed',
            last_error = '上次引擎在创建自动化运行记录前退出，已恢复并安排重试',
            next_run_at = CASE WHEN cadence = 'manual' THEN NULL ELSE ? END,
            failure_count = failure_count + 1,
            updated_at = ?
        WHERE last_status = 'running'
          AND NOT EXISTS (
            SELECT 1 FROM automation_runs
            WHERE automation_runs.automation_id = automations.id
              AND automation_runs.status IN ('running', 'waiting_approval', 'waiting_clarification', 'waiting_budget', 'waiting_completion')
          )
      `).run(now, now);
      return result.changes;
    },

    /** 休眠/停机跨过多个周期时保留可见的 missed 状态，但不伪造一条没有 task 的运行记录。 */
    markMissed(id: string, nextRunAt: string | undefined, detail: string): Automation | undefined {
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE automations
        SET last_status = 'missed', last_error = ?, next_run_at = ?, updated_at = ?
        WHERE id = ? AND last_status IS NOT 'running'
      `).run(detail, nextRunAt ?? null, now, id);
      return get(id);
    },

    finishRun(
      runId: string,
      status: AutomationRunStatus,
      nextRunAt: string | undefined,
      error?: string,
    ): Automation | undefined {
      const now = new Date().toISOString();
      const run = db.prepare('SELECT automation_id FROM automation_runs WHERE id = ?').get(runId) as { automation_id: string } | undefined;
      if (!run) return undefined;
      db.transaction(() => {
        db.prepare(
          `UPDATE automation_runs SET status=@status, finished_at=@finishedAt, error=@error WHERE id=@id`,
        ).run({ id: runId, status, finishedAt: now, error: error ?? null });
        db.prepare(
          `UPDATE automations SET
             last_status=@status, last_error=@error, next_run_at=@nextRunAt,
             failure_count=failure_count + @failure, updated_at=@updatedAt
           WHERE id=@id`,
        ).run({
          id: run.automation_id,
          status,
          error: error ?? null,
          nextRunAt: nextRunAt ?? null,
          failure: status === 'failed' || status === 'cancelled' ? 1 : 0,
          updatedAt: now,
        });
      })();
      return get(run.automation_id);
    },

    createRun(run: AutomationRun): AutomationRun {
      db.prepare(
        `INSERT INTO automation_runs (id, automation_id, task_id, status, started_at, finished_at, error)
         VALUES (@id, @automationId, @taskId, @status, @startedAt, @finishedAt, @error)`,
      ).run({
        id: run.id,
        automationId: run.automationId,
        taskId: run.taskId,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt ?? null,
        error: run.error ?? null,
      });
      return run;
    },

    getRun(id: string): AutomationRun | undefined {
      const row = db.prepare('SELECT * FROM automation_runs WHERE id = ?').get(id) as AutomationRunRow | undefined;
      return row ? rowToAutomationRun(row) : undefined;
    },

    listRuns(automationId: string, limit = 30): AutomationRun[] {
      const rows = db.prepare(
        'SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?',
      ).all(automationId, Math.max(1, Math.min(100, limit))) as AutomationRunRow[];
      return rows.map(rowToAutomationRun);
    },

    listRunningRuns(): AutomationRun[] {
      const rows = db.prepare("SELECT * FROM automation_runs WHERE status IN ('running', 'waiting_approval', 'waiting_clarification', 'waiting_budget', 'waiting_completion') ORDER BY started_at ASC")
        .all() as AutomationRunRow[];
      return rows.map(rowToAutomationRun);
    },
  };
}

function rowToAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    name: row.name,
    goal: row.goal,
    projectId: row.project_id ?? undefined,
    executionMode: row.execution_mode === 'plan' ? 'plan' : 'auto',
    budget: (parseJsonColumn(row.budget) as Automation['budget']) ?? undefined,
    lifetimeBudget: (parseJsonColumn(row.lifetime_budget) as Automation['lifetimeBudget']) ?? undefined,
    cadence: normalizeAutomationCadence(row.cadence),
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    lastTaskId: row.last_task_id ?? undefined,
    lastStatus: (row.last_status as Automation['lastStatus']) ?? undefined,
    lastError: row.last_error ?? undefined,
    runCount: row.run_count,
    failureCount: row.failure_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAutomationRun(row: AutomationRunRow): AutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    taskId: row.task_id,
    status: normalizeAutomationRunStatus(row.status),
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    error: row.error ?? undefined,
  };
}

function normalizeAutomationCadence(value: string): AutomationCadence {
  return value === 'hourly' || value === 'every_6_hours' || value === 'daily' || value === 'weekly'
    ? value
    : 'manual';
}

function normalizeAutomationRunStatus(value: string): AutomationRunStatus {
  return value === 'pending'
      || value === 'running'
      || value === 'waiting_approval'
      || value === 'waiting_clarification'
      || value === 'waiting_budget'
      || value === 'waiting_completion'
      || value === 'completed'
      || value === 'failed'
      || value === 'cancelled'
      || value === 'missed'
    ? value
    : 'failed';
}

function parseJsonColumn(value: string | null): unknown {
  if (value == null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function automationParams(automation: Automation): Record<string, unknown> {
  return {
    id: automation.id,
    name: automation.name,
    goal: automation.goal,
    projectId: automation.projectId ?? null,
    executionMode: automation.executionMode,
    budget: automation.budget === undefined ? null : JSON.stringify(automation.budget),
    lifetimeBudget: automation.lifetimeBudget === undefined ? null : JSON.stringify(automation.lifetimeBudget),
    cadence: automation.cadence,
    enabled: automation.enabled ? 1 : 0,
    nextRunAt: automation.nextRunAt ?? null,
    lastRunAt: automation.lastRunAt ?? null,
    lastTaskId: automation.lastTaskId ?? null,
    lastStatus: automation.lastStatus ?? null,
    lastError: automation.lastError ?? null,
    runCount: automation.runCount,
    failureCount: automation.failureCount,
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
  };
}
