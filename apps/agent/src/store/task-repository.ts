import type Database from "better-sqlite3";
import {
  formatTaskTitle,
  type Message,
  type MessageImagePart,
  type TaskRecallSummary,
  type Task,
  type TaskSummary,
  type TaskTraceEntry,
} from "@aurevoy/shared";

type DatabaseType = Database.Database;

/** 任务与轨迹 repository；Task JSON 仍是产品真相，图片分片独立保存。 */
export function createTaskAndTraceStores(db: DatabaseType) {
interface TaskRow {
  id: string;
  goal: string;
  title: string | null;
  title_source: string | null;
  status: string;
  phase: string | null;
  plan: string;
  messages: string;
  artifacts: string;
  file_changes: string;
  recall_summary: string | null;
  clarifications: string;
  pending_approvals: string;
  approved_approval_keys: string;
  checkpoints: string;
  budget: string | null;
  budget_usage: string | null;
  lifetime_budget: string | null;
  lifetime_usage: string | null;
  budget_exceeded: string | null;
  token_usage: string | null;
  archived_messages: string;
  parent_task_id: string | null;
  project_id: string | null;
  plan_mode: string | null;
  auto_mode_state: string | null;
  context_tokens: number | null;
  subagent_runs: string;
  automation_id: string | null;
  resumed_after_restart: number;
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

interface TaskSummaryRow {
  id: string;
  goal: string;
  title: string;
  title_source: string | null;
  status: string;
  project_id: string | null;
  automation_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTaskSummary(row: TaskSummaryRow): TaskSummary {
  return {
    id: row.id,
    goal: row.goal,
    title: row.title?.trim() || formatTaskTitle(row.goal),
    titleSource: row.title_source === 'llm' ? 'llm' : 'truncated',
    status: row.status as Task['status'],
    projectId: row.project_id ?? undefined,
    automationId: row.automation_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTask(row: TaskRow): Task {
  const goal = row.goal;
  const titleFromDb = row.title?.trim();
  const titleSource = row.title_source === 'llm' ? 'llm' : 'truncated';
  const messages = hydrateMessageParts(row.id, JSON.parse(row.messages) as Message[]);
  const archivedMessages = hydrateMessageParts(row.id, (parseJsonColumn(row.archived_messages) as Message[]) ?? []);
  return {
    id: row.id,
    goal,
    title: titleFromDb || formatTaskTitle(goal),
    titleSource,
    status: row.status as Task['status'],
    phase: (row.phase as Task['phase']) ?? null,
    plan: JSON.parse(row.plan),
    messages,
    artifacts: (parseJsonColumn(row.artifacts) as Task['artifacts']) ?? [],
    fileChanges: (parseJsonColumn(row.file_changes) as Task['fileChanges']) ?? [],
    recallSummary: (parseJsonColumn(row.recall_summary) as TaskRecallSummary) ?? undefined,
    clarifications: (parseJsonColumn(row.clarifications) as Task['clarifications']) ?? [],
    pendingApprovals: (parseJsonColumn(row.pending_approvals) as Task['pendingApprovals']) ?? [],
    checkpoints: (parseJsonColumn(row.checkpoints) as Task['checkpoints']) ?? [],
    budget: (parseJsonColumn(row.budget) as Task['budget']) ?? undefined,
    budgetUsage: (parseJsonColumn(row.budget_usage) as Task['budgetUsage']) ?? undefined,
    lifetimeBudget: (parseJsonColumn(row.lifetime_budget) as Task['lifetimeBudget']) ?? undefined,
    lifetimeUsage: (parseJsonColumn(row.lifetime_usage) as Task['lifetimeUsage']) ?? undefined,
    budgetExceeded: (parseJsonColumn(row.budget_exceeded) as Task['budgetExceeded']) ?? undefined,
    tokenUsage: (parseJsonColumn(row.token_usage) as Task['tokenUsage']) ?? undefined,
    archivedMessages,
    parentTaskId: row.parent_task_id ?? undefined,
    projectId: row.project_id ?? undefined,
    automationId: row.automation_id ?? undefined,
    executionMode: row.plan_mode === 'plan' ? 'plan' : 'auto',
    autoModeState: (parseJsonColumn(row.auto_mode_state) as Task['autoModeState']) ?? undefined,
    contextTokens: row.context_tokens ?? undefined,
    subagentRuns: (parseJsonColumn(row.subagent_runs) as Task['subagentRuns']) ?? [],
    resumedAfterRestart: row.resumed_after_restart === 1 ? true : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 将图片载荷从消息 JSON 注入内存消息；UI 和模型始终只读取 imageParts。 */
function hydrateMessageParts(taskId: string, messages: Message[]): Message[] {
  if (!messages.length) return messages;
  const rows = db.prepare('SELECT message_id, data FROM message_parts WHERE task_id = ? ORDER BY created_at').all(taskId) as Array<{ message_id: string; data: string }>;
  if (!rows.length) return messages;
  const byMessage = new Map<string, MessageImagePart[]>();
  for (const row of rows) {
    const part = parseJsonColumn(row.data) as MessageImagePart | undefined;
    if (!part) continue;
    byMessage.set(row.message_id, [...(byMessage.get(row.message_id) ?? []), part]);
  }
  return messages.map((message) => {
    const imageParts = byMessage.get(message.id);
    return imageParts?.length ? { ...message, imageParts } : message;
  });
}

/** 增量同步图片分片；保留未变化 base64，避免每次任务保存都删除重写。 */
function syncMessageParts(task: Task): void {
  const upsert = db.prepare(`
    INSERT INTO message_parts (id, task_id, message_id, type, data, created_at)
    VALUES (?, ?, ?, 'image', ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  const allMessages = [...task.messages, ...(task.archivedMessages ?? [])];
  const images = allMessages.flatMap((message) =>
    (message.imageParts ?? []).map((image) => ({ image, messageId: message.id, createdAt: message.createdAt })),
  );
  const write = db.transaction(() => {
    for (const { image, messageId, createdAt } of images) {
      upsert.run(image.id, task.id, messageId, JSON.stringify(image), createdAt);
    }
    if (images.length === 0) {
      db.prepare('DELETE FROM message_parts WHERE task_id = ?').run(task.id);
    } else {
      const placeholders = images.map(() => '?').join(', ');
      db.prepare(`DELETE FROM message_parts WHERE task_id = ? AND id NOT IN (${placeholders})`)
        .run(task.id, ...images.map(({ image }) => image.id));
    }
  });
  write();
}

function serializeMessages(messages: Message[]): string {
  return JSON.stringify(messages.map(({ imageParts: _imageParts, ...message }) => message));
}

function serializeMessage(message: Message): string {
  const { imageParts: _imageParts, ...serializable } = message;
  return JSON.stringify(serializable);
}

/** 新增消息只写入自己的图片分片，不再扫描整段历史。 */
function appendMessageParts(taskId: string, message: Message): void {
  const images = message.imageParts ?? [];
  if (images.length === 0) return;
  const upsert = db.prepare(`
    INSERT INTO message_parts (id, task_id, message_id, type, data, created_at)
    VALUES (?, ?, ?, 'image', ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  const write = db.transaction(() => {
    for (const image of images) {
      upsert.run(image.id, taskId, message.id, JSON.stringify(image), message.createdAt);
    }
  });
  write();
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

const taskStore = {
  save(task: Task): void {
    db.prepare(
      `INSERT INTO tasks (
         id, goal, title, title_source, status, phase, plan, messages, artifacts, file_changes, recall_summary, clarifications, pending_approvals, checkpoints,
         budget, budget_usage, lifetime_budget, lifetime_usage, budget_exceeded, token_usage, archived_messages, parent_task_id, project_id,
         automation_id, plan_mode, auto_mode_state, context_tokens, subagent_runs, resumed_after_restart, created_at, updated_at
       )
       VALUES (
         @id, @goal, @title, @titleSource, @status, @phase, @plan, @messages, @artifacts, @fileChanges, @recallSummary, @clarifications,
         @pendingApprovals, @checkpoints, @budget, @budgetUsage, @lifetimeBudget, @lifetimeUsage, @budgetExceeded,
         @tokenUsage, @archivedMessages, @parentTaskId,
         @projectId, @automationId, @planMode, @autoModeState, @contextTokens, @subagentRuns, @resumedAfterRestart, @createdAt, @updatedAt
       )
       ON CONFLICT(id) DO UPDATE SET
         goal=excluded.goal, title=excluded.title, title_source=excluded.title_source,
         status=excluded.status, phase=excluded.phase, plan=excluded.plan,
         messages=excluded.messages, artifacts=excluded.artifacts, file_changes=excluded.file_changes, recall_summary=excluded.recall_summary,
         clarifications=excluded.clarifications, pending_approvals=excluded.pending_approvals,
         checkpoints=excluded.checkpoints,
         budget=excluded.budget, budget_usage=excluded.budget_usage,
         lifetime_budget=excluded.lifetime_budget, lifetime_usage=excluded.lifetime_usage,
         budget_exceeded=excluded.budget_exceeded,
         token_usage=excluded.token_usage, archived_messages=excluded.archived_messages,
         parent_task_id=excluded.parent_task_id, project_id=excluded.project_id,
         automation_id=excluded.automation_id,
         plan_mode=excluded.plan_mode,
         auto_mode_state=excluded.auto_mode_state,
         context_tokens=excluded.context_tokens,
         subagent_runs=excluded.subagent_runs,
         resumed_after_restart=excluded.resumed_after_restart,
         updated_at=excluded.updated_at`,
    ).run({
      id: task.id,
      goal: task.goal,
      title: task.title || formatTaskTitle(task.goal),
      titleSource: task.titleSource === 'llm' ? 'llm' : 'truncated',
      status: task.status,
      phase: task.phase,
      plan: JSON.stringify(task.plan),
      messages: serializeMessages(task.messages),
      artifacts: JSON.stringify(task.artifacts ?? []),
      fileChanges: JSON.stringify(task.fileChanges ?? []),
      recallSummary: task.recallSummary === undefined ? null : JSON.stringify(task.recallSummary),
      clarifications: JSON.stringify(task.clarifications ?? []),
      pendingApprovals: JSON.stringify(task.pendingApprovals ?? []),
      checkpoints: JSON.stringify(task.checkpoints ?? []),
      budget: task.budget === undefined ? null : JSON.stringify(task.budget),
      budgetUsage: task.budgetUsage === undefined ? null : JSON.stringify(task.budgetUsage),
      lifetimeBudget: task.lifetimeBudget === undefined ? null : JSON.stringify(task.lifetimeBudget),
      lifetimeUsage: task.lifetimeUsage === undefined ? null : JSON.stringify(task.lifetimeUsage),
      budgetExceeded: task.budgetExceeded === undefined ? null : JSON.stringify(task.budgetExceeded),
      tokenUsage: task.tokenUsage === undefined ? null : JSON.stringify(task.tokenUsage),
      archivedMessages: serializeMessages(task.archivedMessages ?? []),
      parentTaskId: task.parentTaskId ?? null,
      projectId: task.projectId ?? null,
      automationId: task.automationId ?? null,
      planMode: task.executionMode ?? 'auto',
      autoModeState: task.autoModeState === undefined ? null : JSON.stringify(task.autoModeState),
      contextTokens: task.contextTokens ?? null,
      subagentRuns: JSON.stringify(task.subagentRuns ?? []),
      resumedAfterRestart: task.resumedAfterRestart === true ? 1 : 0,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
    syncMessageParts(task);
  },

  /** 消息/计划推进专用增量保存，避免重写与本次变化无关的任务 JSON 列。 */
  saveMessages(task: Task): void {
    db.prepare(
      `UPDATE tasks SET
         messages = ?, plan = ?, checkpoints = ?, token_usage = ?,
         budget_usage = ?, lifetime_usage = ?, context_tokens = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      serializeMessages(task.messages),
      JSON.stringify(task.plan),
      JSON.stringify(task.checkpoints ?? []),
      task.tokenUsage === undefined ? null : JSON.stringify(task.tokenUsage),
      task.budgetUsage === undefined ? null : JSON.stringify(task.budgetUsage),
      task.lifetimeUsage === undefined ? null : JSON.stringify(task.lifetimeUsage),
      task.contextTokens ?? null,
      task.updatedAt,
      task.id,
    );
    syncMessageParts(task);
  },

  /**
   * 消息热路径：使用 SQLite JSON append 追加单条消息，同时更新关联运行态。
   * 避免每次 message/tool_result 都在 JS 中重序列化全部历史并重扫图片分片。
   */
  appendMessage(task: Task, message: Message): void {
    db.prepare(
      `UPDATE tasks SET
         messages = json_insert(messages, '$[#]', json(?)),
         plan = ?, checkpoints = ?, token_usage = ?,
         budget_usage = ?, lifetime_usage = ?, context_tokens = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      serializeMessage(message),
      JSON.stringify(task.plan),
      JSON.stringify(task.checkpoints ?? []),
      task.tokenUsage === undefined ? null : JSON.stringify(task.tokenUsage),
      task.budgetUsage === undefined ? null : JSON.stringify(task.budgetUsage),
      task.lifetimeUsage === undefined ? null : JSON.stringify(task.lifetimeUsage),
      task.contextTokens ?? null,
      task.updatedAt,
      task.id,
    );
    appendMessageParts(task.id, message);
  },

  /**
   * 增量更新：只更新变更的列，避免全量 JSON.stringify。
   * 传入的 fields 只会 SET 对应列，updated_at 自动刷新。
   * 高频场景（每轮 touch）用此替代 save()。
   */
  patch(taskId: string, fields: Partial<Pick<Task, 'status' | 'phase' | 'budgetUsage' | 'lifetimeUsage' | 'tokenUsage' | 'contextTokens' | 'pendingApprovals' | 'subagentRuns' | 'fileChanges' | 'recallSummary'>>): void {
    const now = new Date().toISOString();
    const assignments: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (fields.status !== undefined) { assignments.push('status = ?'); values.push(fields.status); }
    if (fields.phase !== undefined) { assignments.push('phase = ?'); values.push(fields.phase); }
    if (fields.budgetUsage !== undefined) { assignments.push('budget_usage = ?'); values.push(JSON.stringify(fields.budgetUsage)); }
    if (fields.lifetimeUsage !== undefined) { assignments.push('lifetime_usage = ?'); values.push(JSON.stringify(fields.lifetimeUsage)); }
    if (fields.tokenUsage !== undefined) { assignments.push('token_usage = ?'); values.push(JSON.stringify(fields.tokenUsage)); }
    if (fields.contextTokens !== undefined) { assignments.push('context_tokens = ?'); values.push(fields.contextTokens); }
    if (fields.pendingApprovals !== undefined) { assignments.push('pending_approvals = ?'); values.push(JSON.stringify(fields.pendingApprovals)); }
    if (fields.subagentRuns !== undefined) { assignments.push('subagent_runs = ?'); values.push(JSON.stringify(fields.subagentRuns)); }
    if (fields.fileChanges !== undefined) { assignments.push('file_changes = ?'); values.push(JSON.stringify(fields.fileChanges)); }
    if (fields.recallSummary !== undefined) { assignments.push('recall_summary = ?'); values.push(JSON.stringify(fields.recallSummary)); }

    values.push(taskId);
    db.prepare(`UPDATE tasks SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
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

  listSummaries(projectId?: string | null): TaskSummary[] {
    const columns = 'id, goal, title, title_source, status, project_id, automation_id, created_at, updated_at';
    const rows = projectId === undefined
      ? db.prepare(`SELECT ${columns} FROM tasks ORDER BY updated_at DESC`).all()
      : projectId === null
        ? db.prepare(`SELECT ${columns} FROM tasks WHERE project_id IS NULL ORDER BY updated_at DESC`).all()
        : db.prepare(`SELECT ${columns} FROM tasks WHERE project_id = ? ORDER BY updated_at DESC`).all(projectId);
    return (rows as TaskSummaryRow[]).map(rowToTaskSummary);
  },

  count(): number {
    const row = db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number };
    return row.count;
  },

  cleanupTerminal(olderThanDays: number): {
    deletedTasks: number;
    deletedTraces: number;
    deletedMessageParts: number;
    deletedSessionTrees: number;
  } {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const ids = db
      .prepare(
        `SELECT id FROM tasks
         WHERE updated_at < ?
           AND status IN ('completed', 'failed', 'cancelled')`,
      )
      .all(cutoff) as Array<{ id: string }>;
    if (ids.length === 0) {
      return { deletedTasks: 0, deletedTraces: 0, deletedMessageParts: 0, deletedSessionTrees: 0 };
    }

    const deleteOne = db.transaction((taskIds: string[]) => {
      let deletedTraces = 0;
      let deletedMessageParts = 0;
      let deletedSessionTrees = 0;
      let deletedTasks = 0;
      for (const id of taskIds) {
        deletedTraces += db.prepare('DELETE FROM task_traces WHERE task_id = ?').run(id).changes;
        deletedMessageParts += db.prepare('DELETE FROM message_parts WHERE task_id = ?').run(id).changes;
        deletedSessionTrees += db.prepare('DELETE FROM pi_session_trees WHERE task_id = ?').run(id).changes;
        deletedTasks += db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes;
      }
      return { deletedTasks, deletedTraces, deletedMessageParts, deletedSessionTrees };
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


const traceStore = {
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


  return { taskStore, traceStore };
}
