import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AgentThinkingLevel,
  AutoModeLevel,
  ContinueBudgetRequest,
  Message,
  MessageAttachment,
  MessageImagePart,
  PlanStep,
  RevertMode,
  Task,
  TaskBudget,
  TaskErrorCategory,
  TaskModelSnapshot,
  TaskPhase,
  TaskStatus,
  TaskTraceKind,
} from '@aurevoy/shared';
import { config } from '../config.js';
import { taskEvents } from './events.js';
import {
  clearPiHarnessTaskQueue,
  followUpPiHarnessTask,
  getActivePiTaskController,
  recordPiSessionExecutionMode,
  resolvePiHarnessClarificationAnswer,
  runPiHarnessTask,
  steerPiHarnessTask,
  summarizeTaskMessagesWithPi,
} from './pi-harness.js';
import { createPiModel } from '../llm/pi-provider.js';
import { cancelPiApprovals, resolvePiApproval } from './pi-approval.js';
import { createInitialAutoModeState, syncAutoModeState } from './approval.js';
import { taskStore, projectStore } from '../store/db.js';
import { createTaskLogger } from '../logging/trace.js';
import { resumeIncompletePlan } from './plan-progress.js';
import { applyQuestionFirstSteering } from './control-policy.js';
import {
  ensureLifetimeAllowsAnotherRun,
  initialBudgetUsage,
  mergeBudget,
  snapshotTaskBudgets,
} from './m6-state.js';
import { initialTaskTitle } from './task-title.js';

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
 *
 * 对齐 `pi -r`：当 `config.agent.autoResumeInterruptedTasks` 开启时，对「可安全续跑」
 * 的在途任务（running/planning/pending 且无挂起审批/预算触顶）自动 prepare+续跑；
 * 对嵌有脆弱状态（paused、等待审批/澄清/预算）的任务保守处理——标记为可恢复失败，
 * 由用户手动决定，避免在审批/副作用已过期的情况下擅自续跑。
 *
 * 返回 resumed（已 prepare，待 boot 流程 runHarnessTask）与 manual（保守标记）两组。
 */
export function recoverInterruptedTasksOnBoot(): { resumed: Task[]; manual: Task[] } {
  const resumed: Task[] = [];
  const manual: Task[] = [];
  const autoResume = config.agent.autoResumeInterruptedTasks;
  for (const task of taskStore.list()) {
    if (!INTERRUPTED_STATUSES.includes(task.status)) continue;
    if (autoResume && isAutoResumableOnRestart(task)) {
      const prepared = prepareTaskForResume(task);
      prepared.resumedAfterRestart = true;
      taskStore.save(prepared);
      writeTrace(prepared.id, 'phase', 'initializing', {
        ok: true,
        summary: '引擎重启后自动恢复在途任务（对齐 pi -r），悬挂工具结果已修补',
        data: { previousStatus: task.status, automatic: true },
      });
      resumed.push(prepared);
    } else {
      markTaskInterruptedForManualResume(task, autoResume);
      manual.push(task);
    }
  }
  return { resumed, manual };
}

/** 兼容旧调用方：只保守标记，不自动续跑（测试与无需恢复的场景）。 */
export function markInterruptedTasksAfterRestart(): Task[] {
  const manual: Task[] = [];
  for (const task of taskStore.list()) {
    if (!INTERRUPTED_STATUSES.includes(task.status)) continue;
    markTaskInterruptedForManualResume(task, false);
    manual.push(task);
  }
  return manual;
}

/** 在途任务是否可在重启后安全自动续跑：排除等待外部状态（审批/澄清/预算）的任务。 */
function isAutoResumableOnRestart(task: Task): boolean {
  if (task.status === 'paused') return false;
  if ((task.pendingApprovals?.length ?? 0) > 0) return false;
  if (task.budgetExceeded || task.phase === 'waiting_budget') return false;
  if (task.phase === 'waiting_approval' || task.phase === 'waiting_clarification') return false;
  return true;
}

/** 把中断任务保守标记为可恢复失败：保留 completed 计划步，其余标 failed，清空挂起审批。 */
function markTaskInterruptedForManualResume(task: Task, autoResumeEnabled: boolean): void {
  const previousStatus = task.status;
  const previousPhase = task.phase;
  task.status = 'failed';
  task.phase = 'failed';
  task.resumedAfterRestart = false;
  task.pendingApprovals = [];
  task.plan = task.plan.map((step) =>
    step.status === 'completed' ? step : { ...step, status: 'failed' },
  );
  task.updatedAt = new Date().toISOString();
  taskStore.save(task);
  writeTrace(task.id, 'error', 'failed', {
    ok: false,
    errorCategory: 'unknown',
    summary: autoResumeEnabled
      ? '引擎启动时发现任务嵌有等待审批/预算等过期状态，已保守标记为待手动恢复'
      : '引擎启动时发现任务在上次进程中断前未结束，已标记为可恢复失败',
    data: { previousStatus, previousPhase, recoveredAt: task.updatedAt },
  });
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
  // 手动 resume 不应继续显示上一次自动恢复提示；启动自动恢复会在本函数返回后重新置 true。
  task.resumedAfterRestart = false;
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

/** 输入框切换模式时更新同一任务；模式是会话运行属性，不是全局设置。 */
export function setTaskExecutionMode(task: Task, mode: AutoModeLevel): void {
  if (task.executionMode === mode && task.autoModeState?.level === mode) return;
  task.executionMode = mode;
  task.autoModeState = createInitialAutoModeState(mode);
  task.updatedAt = new Date().toISOString();
  taskStore.save(task);
  void recordPiSessionExecutionMode(task.id, mode).catch((error) => {
    writeTrace(task.id, 'error', task.phase, {
      ok: false,
      errorCategory: 'unknown',
      errorMessage: error instanceof Error ? error.message : String(error),
      summary: '写入会话执行模式变化节点失败',
    });
  });
  taskEvents.publish({ type: 'auto_mode_state', taskId: task.id, state: { ...task.autoModeState } });
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
    autoModeState: createInitialAutoModeState(),
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

/**
 * 手动 /compact：把指定范围历史压缩为一条 LLM 摘要（可携带用户指令）。
 * LLM 摘要失败时退回确定性文本折叠并明确标注，绝不用截断冒充摘要。
 */
export async function compactTask(
  task: Task,
  fromMessageId?: string,
  toMessageId?: string,
  instructions?: string,
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

  const llmSummary = await summarizeTaskMessagesWithPi(task, toCompress, instructions);
  const usedLlm = llmSummary !== null && llmSummary.trim().length > 0;
  const summaryText = usedLlm ? llmSummary : summarizeMessages(toCompress);
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
    summary: summaryText,
    instructed: !!instructions?.trim(),
    automatic: false,
  });
  writeTrace(task.id, 'phase', null, {
    ok: usedLlm,
    errorCategory: usedLlm ? undefined : 'model',
    summary: usedLlm
      ? `LLM 压缩 ${toCompress.length} 条消息为 ${summaryText.length} 字符摘要${instructions ? '（按用户指令）' : ''}`
      : `LLM 摘要失败，${toCompress.length} 条消息退回确定性折叠（${summaryText.length} 字符）`,
    data: { fromIndex, toIndex, originalCount: toCompress.length, summaryLength: summaryText.length, usedLlm, instructed: !!instructions },
  });

  return { task, originalCount: toCompress.length, summaryLength: summaryText.length };
}

/**
 * 会话内即时切换任务模型 / 推理档（P1-2 模型粘性）。
 *
 * - 固化到 task.modelSnapshot：后续 resume / 续跑恢复该模型，不随全局设置漂移。
 * - 运行中：同步到活动 harness（setModel/setThinkingLevel），使当前 run 后续轮次即用新配置；
 *   harness own-event 回写快照为幂等。空闲：仅持久化，下一次 run 读取快照生效。
 * 始终广播 model_updated，前端据此更新模型徽标。
 */
export async function updateTaskModel(
  task: Task,
  patch: { provider?: string; model?: string; thinkingLevel?: AgentThinkingLevel },
): Promise<{ task: Task; modelSnapshot: TaskModelSnapshot }> {
  const modelSnapshot: TaskModelSnapshot = {
    provider: patch.provider?.trim() || task.modelSnapshot?.provider || config.llm.provider,
    model: patch.model?.trim() || task.modelSnapshot?.model || config.llm.model,
    thinkingLevel: patch.thinkingLevel ?? task.modelSnapshot?.thinkingLevel ?? config.agent.thinkingLevel,
  };
  task.modelSnapshot = modelSnapshot;
  task.updatedAt = new Date().toISOString();
  taskStore.save(task);
  taskEvents.publish({
    type: 'model_updated',
    taskId: task.id,
    provider: modelSnapshot.provider,
    model: modelSnapshot.model,
    thinkingLevel: modelSnapshot.thinkingLevel,
  });
  writeTrace(task.id, 'phase', task.phase ?? null, {
    ok: true,
    summary: `任务模型切换为 ${modelSnapshot.provider}:${modelSnapshot.model}（推理 ${modelSnapshot.thinkingLevel}）`,
    data: { provider: modelSnapshot.provider, model: modelSnapshot.model, thinkingLevel: modelSnapshot.thinkingLevel },
  });

  const controller = getActivePiTaskController(task.id);
  if (controller) {
    if (patch.model?.trim() || patch.provider?.trim()) {
      await controller.setModel(createPiModel(modelSnapshot.model, modelSnapshot.provider));
    }
    if (patch.thinkingLevel) {
      await controller.setThinkingLevel(modelSnapshot.thinkingLevel);
    }
  }
  return { task, modelSnapshot };
}

/** 在同一任务内追加一轮用户输入。 */
export function addUserTurn(
  task: Task,
  content: string,
  attachments?: MessageAttachment[],
  imageParts?: MessageImagePart[],
): Message {
  const patchedToolResults = patchDanglingToolResults(task.messages);
  for (const patched of patchedToolResults) {
    taskEvents.publish({ type: 'message', taskId: task.id, message: patched });
  }

  const parsed = parseSlashCommand(content);
  const messageContent = parsed.text || content;

  const userMsg: Message = {
    id: randomUUID(),
    role: 'user',
    content: messageContent,
    createdAt: new Date().toISOString(),
    attachments,
    imageParts,
  };
  task.messages.push(userMsg);
  // continue 一旦写入新用户消息，上一次 revert 的归档不再可撤销
  task.archivedMessages = [];
  // 用户已主动继续交互，重启恢复标识完成使命
  task.resumedAfterRestart = false;
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
export async function queueRunningUserTurn(
  task: Task,
  content: string,
  delivery: 'steering' | 'follow_up' = 'steering',
  attachments?: MessageAttachment[],
  imageParts?: MessageImagePart[],
): Promise<{ message: Message; delivered: boolean }> {
  // OpenCode proactiveness: status/question asks get a text-first reminder on the wire to the model.
  // Durable transcript keeps the user's raw content; steering payload may include the prefix.
  const steeredContent = applyQuestionFirstSteering(content);
  const userMsg: Message = {
    id: randomUUID(),
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
    attachments,
    imageParts,
    delivery,
  };
  // Model-facing message for the queue (may include system-reminder); transcript stores raw `content`.
  const modelFacingMsg: Message =
    steeredContent === content
      ? userMsg
      : { ...userMsg, content: steeredContent };

  // 真实投递结果：harness 拒绝（run 已收尾/不可用）时 delivered=false，
  // 用户消息不入 transcript，前端据此提示重发而非假装已送达。
  const delivered = await (delivery === 'follow_up'
    ? followUpPiHarnessTask(task.id, modelFacingMsg)
    : steerPiHarnessTask(task.id, modelFacingMsg));
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
      : `运行中追加用户消息未投递：Pi harness 队列不可用或已收尾`,
    data: { delivery, message: content },
  });
  return { message: userMsg, delivered };
}

/** 按投递语义撤回仍未注入的运行中消息队列。 */
export async function clearRunningUserQueue(
  task: Task,
  kind: 'steering' | 'follow_up' | 'all',
): Promise<boolean> {
  const cleared = await clearPiHarnessTaskQueue(task.id, kind);
  writeTrace(task.id, 'phase', task.phase ?? 'thinking', {
    ok: cleared,
    summary: cleared ? `已撤回 ${kind} 待注入队列` : `待注入队列不可用，未执行撤回`,
    data: { kind },
  });
  return cleared;
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
  executionMode?: AutoModeLevel,
  imageParts?: MessageImagePart[],
  automationId?: string,
): Task {
  const now = new Date().toISOString();
  const parsed = parseSlashCommand(goal);
  const taskGoal = parsed.text || goal;
  const userMsg: Message = {
    id: randomUUID(),
    role: 'user',
    content: taskGoal,
    createdAt: now,
    attachments,
    imageParts,
  };
  const autoModeLevel = executionMode ?? currentAutoModeLevel();
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
    automationId: automationId ?? undefined,
    executionMode: autoModeLevel,
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
      automationId,
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
  const taskMode = task.executionMode ?? autoModeLevel;
  task.executionMode = taskMode;
  const autoModeState = syncAutoModeState(task, taskMode);
  taskEvents.publish({ type: 'auto_mode_state', taskId: task.id, state: { ...autoModeState } });

  // Plan 模式只读讨论时保留 proposed；切回 Agent 后才打开首个未完成步骤。
  if (task.plan.length > 0 && taskMode === 'auto') {
    task.plan = resumeIncompletePlan(task.plan);
  }
  task.updatedAt = new Date().toISOString();
  taskStore.save(task);
  if (task.plan.length > 0) taskEvents.publish({ type: 'plan', taskId: task.id, plan: task.plan });

  const abortController = new AbortController();
  activeAbortControllers.set(task.id, abortController);
  try {
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
  // 模式是输入框的单次选择；旧客户端未携带时安全回落为自动执行。
  return 'auto';
}

function parseSlashCommand(content: string): { planRequested: boolean; text: string } {
  // /plan 历史兼容：剥掉前缀，不再进入计划审批
  const match = content.match(/^\/(\S+)(?:\s+(.*))?/s);
  if (!match) return { planRequested: false, text: content };
  if (match[1] === 'plan') return { planRequested: false, text: match[2]?.trim() || content };
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
