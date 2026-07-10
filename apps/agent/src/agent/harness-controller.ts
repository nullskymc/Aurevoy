import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AutoModeLevel,
  ContinueBudgetRequest,
  Message,
  MessageAttachment,
  PlanStep,
  RevertMode,
  Task,
  TaskBudget,
  TaskErrorCategory,
  TaskPhase,
  TaskStatus,
  TaskTraceKind,
} from '@aurevoy/shared';
import { config } from '../config.js';
import { taskEvents } from './events.js';
import {
  followUpPiHarnessTask,
  resolvePiHarnessClarificationAnswer,
  runPiHarnessTask,
  steerPiHarnessTask,
} from './pi-harness.js';
import { cancelPiApprovals, resolvePiApproval, resolvePlanApproval, waitForPlanApproval } from './pi-approval.js';
import { createInitialAutoModeState, syncAutoModeState } from './approval.js';
import { taskStore, projectStore } from '../store/db.js';
import { createTaskLogger } from '../logging/trace.js';
import { resumeIncompletePlan } from './plan-progress.js';
import {
  ensureLifetimeAllowsAnotherRun,
  initialBudgetUsage,
  mergeBudget,
  snapshotTaskBudgets,
} from './m6-state.js';
import { initialTaskTitle, isTitleStillAuto } from './task-title.js';

/** 进程重启后不会再有内存执行句柄的状态；启动时必须收敛成可解释失败。 */
const INTERRUPTED_STATUSES: readonly TaskStatus[] = ['pending', 'planning', 'running', 'paused'];
/** Pi harness 的取消句柄。 */
const activeAbortControllers = new Map<string, AbortController>();


/** 取消一个进行中的任务。 */
export function cancelTask(taskId: string): boolean {
  const ac = activeAbortControllers.get(taskId);
  if (!ac) return false;
  ac.abort();
  cancelPiApprovals(taskId);
  return true;
}

/** 该任务当前是否有正在执行的 Pi harness。 */
export function isTaskRunning(taskId: string): boolean {
  return activeAbortControllers.has(taskId);
}

/**
 * 启动期恢复扫描：SQLite 里仍处于运行态/等待态的任务，说明上一次进程已中断。
 * 不自动续跑，因为审批、外部工具副作用和用户意图都可能已经过期。
 */
export function markInterruptedTasksAfterRestart(): Task[] {
  const recovered: Task[] = [];
  for (const task of taskStore.list()) {
    if (!INTERRUPTED_STATUSES.includes(task.status)) continue;
    const previousStatus = task.status;
    const previousPhase = task.phase;
    task.status = 'failed';
    task.phase = 'failed';
    task.pendingApprovals = [];
    task.plan = task.plan.map((step) =>
      step.status === 'completed' ? step : { ...step, status: 'failed' },
    );
    task.updatedAt = new Date().toISOString();
    taskStore.save(task);
    writeTrace(task.id, 'error', 'failed', {
      ok: false,
      errorCategory: 'unknown',
      summary: '引擎启动时发现任务在上次进程中断前未结束，已标记为可恢复失败',
      data: { previousStatus, previousPhase, recoveredAt: task.updatedAt },
    });
    recovered.push(task);
  }
  return recovered;
}

/** 恢复一个历史任务：修补悬空工具结果后交给 Pi harness 继续。 */
export function prepareTaskForResume(task: Task): Task {
  const now = new Date().toISOString();
  const previousStatus = task.status;
  const previousPhase = task.phase;
  const patchedToolResults = patchDanglingToolResults(task.messages).length;
  const lastCheckpoint = task.checkpoints?.at(-1);
  // 预算触顶恢复：保证寿命额度还能再跑一整轮
  if (previousPhase === 'waiting_budget' || task.budgetExceeded) {
    ensureLifetimeAllowsAnotherRun(task);
  }
  task.status = 'pending';
  task.phase = 'initializing';
  task.pendingApprovals = [];
  task.budgetExceeded = undefined;
  // run 用量在 runPiHarnessTask 入口 beginRunBudget 清零
  task.plan = resumePlanFromCheckpoint(task.plan, lastCheckpoint?.stepId);
  task.updatedAt = now;
  taskStore.save(task);
  writeTrace(task.id, 'phase', 'initializing', {
    ok: true,
    summary: lastCheckpoint
      ? `用户恢复历史任务，从 checkpoint 继续：${lastCheckpoint.label}`
      : '用户恢复历史任务，使用持久消息历史重新进入 Pi harness',
    data: { previousStatus, previousPhase, patchedToolResults, checkpoint: lastCheckpoint },
  });
  return task;
}

/**
 * 预算触顶后续跑：可选扩容寿命 / 覆盖 run 预算，再 prepare + 由调用方 runHarnessTask。
 */
export function prepareTaskForBudgetContinue(
  task: Task,
  body?: ContinueBudgetRequest,
): Task {
  if (body?.runBudget) {
    task.budget = mergeBudget(
      snapshotTaskBudgets({ budget: task.budget }).budget,
      body.runBudget,
    );
  }
  ensureLifetimeAllowsAnotherRun(task, body?.additionalLifetime);
  return prepareTaskForResume(task);
}

/** 编辑重试截断：移除目标消息及其之后的对话；前端再立刻 continue 编辑稿。 */
export function revertTask(
  task: Task,
  messageId: string,
  mode: RevertMode = 'code_and_conv',
): {
  task: Task;
  removedContent: string | null;
  removedMessageId: string | null;
  removedCount: number;
} {
  const index = task.messages.findIndex((m) => m.id === messageId);
  if (index < 0) {
    return { task, removedContent: null, removedMessageId: null, removedCount: 0 };
  }

  const removed = task.messages[index];
  const removedMessages = task.messages.slice(index);
  task.archivedMessages = removedMessages;
  task.messages = task.messages.slice(0, index);

  if (mode === 'code_and_conv') {
    const revertTime = removed.createdAt;
    task.checkpoints = (task.checkpoints ?? []).filter((cp) => cp.createdAt < revertTime);
    task.artifacts = (task.artifacts ?? []).filter((artifact) =>
      artifact.status === 'applied' || artifact.createdAt < revertTime,
    );
    task.plan = task.plan.filter((step) => step.status === 'completed');
  }

  task.status = 'paused';
  task.phase = null;
  task.pendingApprovals = [];
  task.updatedAt = new Date().toISOString();
  taskStore.save(task);

  taskEvents.publish({
    type: 'reverted',
    taskId: task.id,
    messageId,
    removedCount: removedMessages.length,
    archivedCount: removedMessages.length,
  });
  writeTrace(task.id, 'phase', null, {
    ok: true,
    summary: `编辑重试截断(mode=${mode})：截断到消息 ${messageId} 之前，移除 ${removedMessages.length} 条消息`,
    data: { messageId, mode, removedCount: removedMessages.length },
  });

  return {
    task,
    removedContent: removed.role === 'user' ? removed.content : null,
    removedMessageId: removed.id,
    removedCount: removedMessages.length,
  };
}

/** 撤销上一次 revert：从 archivedMessages 恢复（仅 continue 尚未提交时）。 */
export function unrevertTask(task: Task): { task: Task; restoredCount: number } {
  const archived = task.archivedMessages ?? [];
  if (archived.length === 0) return { task, restoredCount: 0 };

  task.messages = [...task.messages, ...archived];
  task.archivedMessages = [];
  task.status = 'completed';
  task.phase = 'finalizing';
  task.updatedAt = new Date().toISOString();
  taskStore.save(task);

  taskEvents.publish({ type: 'unreverted', taskId: task.id, restoredCount: archived.length });
  writeTrace(task.id, 'phase', null, {
    ok: true,
    summary: `撤销编辑重试截断：恢复 ${archived.length} 条归档消息到活跃历史`,
    data: { restoredCount: archived.length },
  });
  return { task, restoredCount: archived.length };
}

/** 从指定消息处分支出一个新任务。 */
export function branchTask(
  parentTask: Task,
  messageId: string,
  goalOverride?: string,
): { task: Task; messageCount: number } {
  const index = parentTask.messages.findIndex((m) => m.id === messageId);
  const sourceMessages = index < 0 ? [] : parentTask.messages.slice(0, index + 1);
  const idMap = new Map<string, string>();
  for (const msg of sourceMessages) {
    idMap.set(msg.id, randomUUID());
    for (const call of msg.toolCalls ?? []) idMap.set(call.id, randomUUID());
  }

  const clonedMessages: Message[] = sourceMessages.map((msg) => ({
    ...msg,
    id: idMap.get(msg.id)!,
    toolCalls: msg.toolCalls?.map((tc) => ({ ...tc, id: idMap.get(tc.id) ?? randomUUID() })),
    toolCallId: msg.toolCallId ? (idMap.get(msg.toolCallId) ?? msg.toolCallId) : undefined,
  }));
  const clonedSubagentRuns = (parentTask.subagentRuns ?? [])
    .filter((run) => idMap.has(run.parentCallId))
    .map((run) => ({
      ...run,
      id: randomUUID(),
      parentCallId: idMap.get(run.parentCallId)!,
      activities: run.activities.map((activity) => ({ ...activity, id: randomUUID() })),
    }));

  const now = new Date().toISOString();
  const branchGoal = goalOverride ?? parentTask.goal;
  const budgets = snapshotTaskBudgets({
    budget: parentTask.budget,
    lifetimeBudget: parentTask.lifetimeBudget,
  });
  const task: Task = {
    id: randomUUID(),
    goal: branchGoal,
    title: goalOverride ? initialTaskTitle(branchGoal) : (parentTask.title || initialTaskTitle(branchGoal)),
    titleSource: goalOverride ? 'truncated' : (parentTask.titleSource ?? 'truncated'),
    status: clonedMessages.length > 0 ? 'completed' : 'pending',
    phase: clonedMessages.length > 0 ? 'finalizing' : 'initializing',
    plan: [],
    messages: clonedMessages,
    artifacts: [],
    clarifications: [],
    pendingApprovals: [],
    subagentRuns: clonedSubagentRuns,
    checkpoints: [],
    budget: budgets.budget,
    budgetUsage: initialBudgetUsage(),
    lifetimeBudget: budgets.lifetimeBudget,
    lifetimeUsage: initialBudgetUsage(),
    tokenUsage: { available: false, provider: config.llm.provider, model: config.llm.model },
    parentTaskId: parentTask.id,
    projectId: parentTask.projectId,
    // 分支任务重新走权限门禁，不继承父任务的 planApproved
    autoModeState: createInitialAutoModeState(currentAutoModeLevel()),
    createdAt: now,
    updatedAt: now,
  };
  taskStore.save(task);

  taskEvents.publish({
    type: 'branched',
    taskId: task.id,
    parentTaskId: parentTask.id,
    messageId,
    messageCount: clonedMessages.length,
  });
  writeTrace(task.id, 'phase', null, {
    ok: true,
    summary: `从任务 ${parentTask.id} 分支，克隆 ${clonedMessages.length} 条消息到消息 ${messageId}`,
    data: { parentTaskId: parentTask.id, messageId, messageCount: clonedMessages.length },
  });

  return { task, messageCount: clonedMessages.length };
}

/** 本地压缩历史消息为 system 摘要，供下一次 Pi harness 运行读取。 */
export async function compactTask(
  task: Task,
  fromMessageId?: string,
  toMessageId?: string,
): Promise<{ task: Task; originalCount: number; summaryLength: number }> {
  const messages = task.messages;
  const fromIndex = fromMessageId ? messages.findIndex((m) => m.id === fromMessageId) : 0;
  const toIndex = toMessageId ? messages.findIndex((m) => m.id === toMessageId) : messages.length - 1;

  if (fromIndex < 0 || toIndex < 0 || fromIndex > toIndex) {
    return { task, originalCount: 0, summaryLength: 0 };
  }

  const toCompress = messages.slice(fromIndex, toIndex + 1);
  if (toCompress.length <= 1) {
    return { task, originalCount: toCompress.length, summaryLength: 0 };
  }

  const summaryText = summarizeMessages(toCompress);
  const summaryMessage: Message = {
    id: randomUUID(),
    role: 'system',
    content: `[上下文摘要] ${summaryText}`,
    createdAt: new Date().toISOString(),
  };
  task.messages = [...messages.slice(0, fromIndex), summaryMessage, ...messages.slice(toIndex + 1)];
  task.updatedAt = new Date().toISOString();
  taskStore.save(task);

  taskEvents.publish({
    type: 'compacted',
    taskId: task.id,
    originalCount: toCompress.length,
    summaryLength: summaryText.length,
  });
  writeTrace(task.id, 'phase', null, {
    ok: true,
    summary: `本地压缩 ${toCompress.length} 条消息为 ${summaryText.length} 字符摘要`,
    data: { fromIndex, toIndex, originalCount: toCompress.length, summaryLength: summaryText.length },
  });

  return { task, originalCount: toCompress.length, summaryLength: summaryText.length };
}

/** 在同一任务内追加一轮用户输入。 */
export function addUserTurn(
  task: Task,
  content: string,
  attachments?: MessageAttachment[],
): Message {
  const patchedToolResults = patchDanglingToolResults(task.messages);
  for (const patched of patchedToolResults) {
    taskEvents.publish({ type: 'message', taskId: task.id, message: patched });
  }

  const parsed = parseSlashCommand(content);
  const messageContent = parsed.planRequested ? (parsed.text || task.goal) : content;
  if (parsed.planRequested) {
    task.goal = messageContent;
    if (isTitleStillAuto(task)) {
      task.title = initialTaskTitle(messageContent);
      task.titleSource = 'truncated';
    }
    // /plan 重新要求确认计划
    const state = syncAutoModeState(task, currentAutoModeLevel());
    state.planApproved = false;
    state.planReady = false;
  }

  const userMsg: Message = {
    id: randomUUID(),
    role: 'user',
    content: messageContent,
    createdAt: new Date().toISOString(),
    attachments,
  };
  task.messages.push(userMsg);
  // continue 一旦写入新用户消息，上一次 revert 的归档不再可撤销
  task.archivedMessages = [];
  task.status = 'pending';
  task.phase = 'initializing';
  task.pendingApprovals = [];
  task.updatedAt = userMsg.createdAt;
  taskStore.save(task);
  taskEvents.publish({ type: 'message', taskId: task.id, message: userMsg });
  writeTrace(task.id, 'phase', 'initializing', {
    ok: true,
    summary: '收到后续输入，继续 Pi harness',
    data: { message: messageContent, patchedToolResults: patchedToolResults.length },
  });
  return userMsg;
}

/** 任务运行中追加用户消息，并投递到 Pi steering/follow-up 队列。 */
export function queueRunningUserTurn(
  task: Task,
  content: string,
  delivery: 'steering' | 'follow_up' = 'steering',
  attachments?: MessageAttachment[],
): { message: Message; delivered: boolean } {
  const userMsg: Message = {
    id: randomUUID(),
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
    attachments,
    delivery,
  };

  const delivered = delivery === 'follow_up'
    ? followUpPiHarnessTask(task.id, userMsg)
    : steerPiHarnessTask(task.id, userMsg);
  if (delivered) {
    task.messages.push(userMsg);
    task.updatedAt = userMsg.createdAt;
    taskStore.save(task);
    taskEvents.publish({ type: 'message', taskId: task.id, message: userMsg });
  }
  writeTrace(task.id, 'phase', task.phase ?? 'thinking', {
    ok: delivered,
    summary: delivered
      ? `运行中追加用户消息已投递到 ${delivery} 队列`
      : `运行中追加用户消息未投递：Pi harness 不可用`,
    data: { delivery, message: content },
  });
  return { message: userMsg, delivered };
}

/** plan 模式下恢复暂停的任务继续执行。 */
export function resumeAutoMode(taskId: string): boolean {
  const task = taskStore.get(taskId);
  if (!task?.autoModeState?.paused) return false;
  task.autoModeState.paused = false;
  task.autoModeState.pausedReason = undefined;
  task.updatedAt = new Date().toISOString();
  taskStore.save(task);
  taskEvents.publish({ type: 'auto_mode_state', taskId, state: { ...task.autoModeState } });
  return true;
}

/** 投递一次工具审批决策到 Pi 审批桥。 */
export function resolveApproval(
  taskId: string,
  callId: string,
  approved: boolean,
): boolean {
  return resolvePiApproval(taskId, callId, approved);
}

/** 投递一次计划审批决策到 Pi 运行前的计划门禁。 */
export function resolvePlanApprovalDecision(
  taskId: string,
  approved: boolean,
): boolean {
  return resolvePlanApproval(taskId, approved);
}

/** 投递 ask_user 工具的用户补充答案。 */
export function resolveClarificationAnswer(
  taskId: string,
  clarificationId: string,
  answer: string,
): boolean {
  return resolvePiHarnessClarificationAnswer(taskId, clarificationId, answer);
}

/** 创建一个新任务并持久化（尚未开始执行）。 */
export function createTask(
  goal: string,
  budget?: TaskBudget,
  projectId?: string,
  attachments?: MessageAttachment[],
  lifetimeBudget?: TaskBudget,
): Task {
  const now = new Date().toISOString();
  const parsed = parseSlashCommand(goal);
  const taskGoal = parsed.planRequested ? (parsed.text || goal) : goal;
  const userMsg: Message = {
    id: randomUUID(),
    role: 'user',
    content: taskGoal,
    createdAt: now,
    attachments,
  };
  const autoModeLevel = currentAutoModeLevel();
  const budgets = snapshotTaskBudgets({ budget, lifetimeBudget });
  const task: Task = {
    id: randomUUID(),
    goal: taskGoal,
    title: initialTaskTitle(taskGoal),
    titleSource: 'truncated',
    status: 'pending',
    phase: 'initializing',
    plan: [],
    messages: [userMsg],
    artifacts: [],
    clarifications: [],
    pendingApprovals: [],
    checkpoints: [],
    budget: budgets.budget,
    budgetUsage: initialBudgetUsage(),
    lifetimeBudget: budgets.lifetimeBudget,
    lifetimeUsage: initialBudgetUsage(),
    tokenUsage: { available: false, provider: config.llm.provider, model: config.llm.model },
    projectId: projectId ?? undefined,
    autoModeState: createInitialAutoModeState(autoModeLevel),
    createdAt: now,
    updatedAt: now,
  };
  taskStore.save(task);
  writeTrace(task.id, 'phase', 'initializing', {
    ok: true,
    summary: '任务已创建，等待 Pi harness 执行',
    data: {
      goal: taskGoal,
      autoModeLevel,
      budget: budgets.budget,
      lifetimeBudget: budgets.lifetimeBudget,
    },
  });
  return task;
}

/** 解析任务的有效工作区目录。 */
export async function resolveTaskWorkspace(task: Task): Promise<string> {
  if (task.projectId) {
    const project = projectStore.get(task.projectId);
    if (project) return resolve(project.path);
  }
  const standaloneDir = resolve(config.workspaceDir, '.sessions', task.id);
  await fs.mkdir(standaloneDir, { recursive: true });
  return standaloneDir;
}

/** 主执行入口：任务控制只委托 Pi harness。 */
export async function runHarnessTask(task: Task): Promise<void> {
  task.pendingApprovals = [];
  const autoModeLevel = currentAutoModeLevel();
  const autoModeState = syncAutoModeState(task, autoModeLevel);
  taskEvents.publish({ type: 'auto_mode_state', taskId: task.id, state: { ...autoModeState } });

  if (task.plan.length === 0) {
    task.plan = createInitialPlan(task);
  } else {
    task.plan = resumeIncompletePlan(task.plan);
  }
  task.updatedAt = new Date().toISOString();
  taskStore.save(task);
  taskEvents.publish({ type: 'plan', taskId: task.id, plan: task.plan });
  taskEvents.publish({ type: 'plan_generated', taskId: task.id, plan: task.plan, source: 'heuristic' });

  const abortController = new AbortController();
  activeAbortControllers.set(task.id, abortController);
  try {
    // plan：先批计划；已批准则跳过。auto：直接执行。
    if (autoModeLevel === 'plan' && !task.autoModeState?.planApproved) {
      const approved = await requestManualPlanApproval(task, abortController.signal);
      if (!approved) return;
    }
    await runPiHarnessTask(task, {
      workspaceDir: await resolveTaskWorkspace(task),
      signal: abortController.signal,
      taskStartedAtMs: Date.now(),
    });
  } finally {
    activeAbortControllers.delete(task.id);
  }
}

function currentAutoModeLevel(): AutoModeLevel {
  return config.autoMode.level === 'plan' ? 'plan' : 'auto';
}

function createInitialPlan(task: Task): PlanStep[] {
  if (!shouldUseMultiStepPlan(task.goal)) {
    return [{ id: 'exec', description: 'Agent 执行任务', status: 'running' }];
  }
  // 三步模板由 plan-progress 在工具/终稿/收尾时推进，避免 discover 永久 running
  return [
    { id: 'discover', description: '搜集并确认本地材料', status: 'running' },
    { id: 'synthesize', description: '整理关键信息并形成结构', status: 'pending' },
    { id: 'deliver', description: '输出最终结果并检查完整性', status: 'pending' },
  ];
}

function shouldUseMultiStepPlan(goal: string): boolean {
  return /(整理|报告|Markdown|材料|多步|计划|report|markdown|plan|summari[sz]e|organize)/i.test(goal);
}

async function requestManualPlanApproval(task: Task, signal: AbortSignal): Promise<boolean> {
  const state = syncAutoModeState(task, currentAutoModeLevel());
  state.planReady = true;
  state.planApproved = false;
  task.status = 'paused';
  task.phase = 'waiting_approval';
  task.updatedAt = new Date().toISOString();
  taskStore.save(task);
  taskEvents.publish({ type: 'status', taskId: task.id, status: 'paused' });
  taskEvents.publish({ type: 'phase', taskId: task.id, phase: 'waiting_approval', detail: '等待确认执行计划' });
  taskEvents.publish({ type: 'auto_mode_state', taskId: task.id, state: { ...state } });
  taskEvents.publish({
    type: 'plan_approval_request',
    taskId: task.id,
    plan: task.plan,
    reasoning: '当前为 Plan 模式：请确认执行计划后，Agent 将自动执行（执行期不再逐工具审批）。',
  });

  const decision = await waitForPlanApproval(task.id, signal, config.agent.approvalTimeoutMs);
  taskEvents.publish({
    type: 'plan_approval_resolved',
    taskId: task.id,
    approved: decision.approved,
    reason: decision.approved ? undefined : '用户拒绝或超时未确认执行计划',
  });

  if (!decision.approved) {
    if (task.autoModeState) {
      task.autoModeState.planReady = false;
      task.autoModeState.planApproved = false;
    }
    task.status = 'cancelled';
    task.phase = 'cancelled';
    task.updatedAt = new Date().toISOString();
    taskStore.save(task);
    taskEvents.publish({ type: 'status', taskId: task.id, status: task.status });
    taskEvents.publish({ type: 'phase', taskId: task.id, phase: task.phase });
    if (task.autoModeState) {
      taskEvents.publish({ type: 'auto_mode_state', taskId: task.id, state: { ...task.autoModeState } });
    }
    taskEvents.publish({ type: 'done', taskId: task.id, status: task.status });
    writeTrace(task.id, 'approval', 'cancelled', {
      ok: false,
      errorCategory: 'permission',
      summary: '执行计划未获批准，任务已取消',
    });
    return false;
  }

  // 计划已批：执行期与 auto 相同
  const approvedState = syncAutoModeState(task, currentAutoModeLevel());
  approvedState.planApproved = true;
  approvedState.planReady = false;
  task.status = 'running';
  task.phase = 'initializing';
  task.plan = resumeIncompletePlan(task.plan);
  task.updatedAt = new Date().toISOString();
  taskStore.save(task);
  taskEvents.publish({ type: 'status', taskId: task.id, status: task.status });
  taskEvents.publish({ type: 'phase', taskId: task.id, phase: task.phase, detail: '计划已确认，启动 Pi harness' });
  taskEvents.publish({ type: 'plan', taskId: task.id, plan: task.plan });
  taskEvents.publish({ type: 'auto_mode_state', taskId: task.id, state: { ...approvedState } });
  writeTrace(task.id, 'approval', 'initializing', {
    ok: true,
    summary: '执行计划已批准，执行期自动放行工具（等同 auto）',
  });
  return true;
}

function parseSlashCommand(content: string): { planRequested: boolean; text: string } {
  const match = content.match(/^\/(\S+)(?:\s+(.*))?/s);
  if (!match) return { planRequested: false, text: content };
  if (match[1] === 'plan') return { planRequested: true, text: match[2]?.trim() || '' };
  return { planRequested: false, text: content };
}

function patchDanglingToolResults(messages: Message[]): Message[] {
  const patched: Message[] = [];
  const resultIds = new Set(messages.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => m.toolCallId!));
  const knownCallNames = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      knownCallNames.set(call.id, call.function.name);
    }
  }
  for (const [callId, toolName] of knownCallNames) {
    if (resultIds.has(callId)) continue;
    const msg: Message = {
      id: randomUUID(),
      role: 'tool',
      content: JSON.stringify({
        error: `上次运行在工具 ${toolName} 返回前中断；该调用结果不可用。`,
      }),
      toolCallId: callId,
      createdAt: new Date().toISOString(),
    };
    messages.push(msg);
    patched.push(msg);
  }
  return patched;
}

function resumePlanFromCheckpoint(plan: PlanStep[], checkpointStepId?: string): PlanStep[] {
  if (plan.length === 0) return plan;
  if (!checkpointStepId) {
    return resumeIncompletePlan(plan);
  }
  const checkpointIndex = plan.findIndex((step) => step.id === checkpointStepId);
  const marked = plan.map((step, index) => {
    if (checkpointIndex >= 0 && index <= checkpointIndex) return { ...step, status: 'completed' as const };
    return { ...step, status: 'pending' as const };
  });
  return resumeIncompletePlan(marked);
}

function summarizeMessages(messages: Message[]): string {
  const lines = messages.map((message) => {
    const content = message.content.replace(/\s+/g, ' ').trim();
    const suffix = content.length > 500 ? `${content.slice(0, 500)}...` : content;
    return `${message.role}: ${suffix}`;
  });
  const summary = lines.join('\n');
  return summary.length > 4000 ? `${summary.slice(0, 4000)}\n[摘要已截断]` : summary;
}

function writeTrace(
  taskId: string,
  kind: TaskTraceKind,
  phase: TaskPhase | null,
  entry: {
    ok?: boolean;
    errorCategory?: TaskErrorCategory;
    errorMessage?: string;
    summary?: string;
    data?: unknown;
  } = {},
): void {
  createTaskLogger(taskId).trace(kind, phase, entry);
}
