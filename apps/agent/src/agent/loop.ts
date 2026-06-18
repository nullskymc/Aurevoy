import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  FileSnapshot,
  GeneratedPlan,
  Message,
  MessageAttachment,
  MessageToolCall,
  PlanStep,
  RevertMode,
  ScoutReport,
  Task,
  TaskArtifact,
  TaskErrorCategory,
  TaskPhase,
  TaskStatus,
  TaskTraceEntry,
  TaskBudget,
  TokenUsage,
  ToolCall,
  ToolResult,
  ToolRiskLevel,
} from '@aurevoy/shared';
import { taskEvents } from './events.js';
import { getProvider, getProviderName, type AccumulatedToolCall } from '../llm/provider.js';
import { autoCompactIfNeeded, buildContextWindow, buildMemorySystemMessage, buildSkillSystemMessage } from './context.js';
import { toolRegistry } from '../tools/registry.js';
import { skillRegistry } from '../skills/registry.js';
import { withRetry } from './retry.js';
import { taskStore, memoryStore, projectStore } from '../store/db.js';
import { createTaskLogger } from '../logging/trace.js';
import { config } from '../config.js';
import {
  addTokenUsage,
  assertBudgetWithinLimits,
  BudgetExceededError,
  createArtifact,
  createCheckpoint,
  createClarification,
  effectiveBudget,
  initialBudgetUsage,
  markArtifactApplied,
  normalizeBudget,
  resolveClarification,
  updateWallTime,
} from './m6-state.js';

/** 同一工具+相同参数最多重复调用次数，超过即注入纠正提示 */
const DUPLICATE_CALL_LIMIT = 3;
/** 单轮最多并行工具调用数 */
const MAX_TOOL_CALLS_PER_TURN = 10;
/** P6: 写入类工具（需要执行前文件快照） */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'apply_artifact', 'copy_file', 'move_file', 'rename_file']);
/** 进程重启后不会再有内存执行句柄的状态；启动时必须收敛成可解释失败。 */
const INTERRUPTED_STATUSES: readonly TaskStatus[] = ['pending', 'planning', 'running', 'paused'];
/** 进行中任务的取消句柄 */
const activeAbortControllers = new Map<string, AbortController>();

/** 等待中的工具审批：taskId → (callId → 决策回调) */
const pendingApprovals = new Map<string, Map<string, (approved: boolean) => void>>();
/** 等待中的用户追问：taskId → (clarificationId → 回复回调) */
const pendingClarifications = new Map<string, Map<string, (answer: string | null) => void>>();

/** 取消一个进行中的任务（hard cancel：中断 fetch 流） */
export function cancelTask(taskId: string): boolean {
  const ac = activeAbortControllers.get(taskId);
  if (!ac) return false;
  ac.abort();
  const clarifications = pendingClarifications.get(taskId);
  for (const resolve of clarifications?.values() ?? []) resolve(null);
  pendingClarifications.delete(taskId);
  return true;
}

/** 该任务当前是否有正在执行的循环（用于续聊并发守卫）。 */
export function isTaskRunning(taskId: string): boolean {
  return activeAbortControllers.has(taskId);
}

/**
 * 启动期恢复扫描：SQLite 里仍处于运行态/等待态的任务，说明上一次进程已中断。
 *
 * 这里不自动续跑，因为审批、外部工具副作用和用户意图都可能已经过期；
 * 先收敛为可解释的 failed，再由用户显式 resume。
 */
export function markInterruptedTasksAfterRestart(): Task[] {
  const recovered: Task[] = [];
  for (const task of taskStore.list()) {
    if (!INTERRUPTED_STATUSES.includes(task.status)) continue;
    const previousStatus = task.status;
    const previousPhase = task.phase;
    task.status = 'failed';
    task.phase = 'failed';
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

/**
 * 恢复一个历史任务：不追加假用户输入，只修补协议层悬空工具结果后重新运行。
 *
 * 某些 LLM API 要求 assistant tool_calls 后必须紧跟 tool 结果；如果崩溃发生在
 * 工具调用与结果写入之间，直接续跑会被 Provider 拒绝，因此恢复前先写入可解释结果。
 */
export function prepareTaskForResume(task: Task): Task {
  const now = new Date().toISOString();
  const previousStatus = task.status;
  const previousPhase = task.phase;
  const patchedToolResults = patchDanglingToolResults(task.messages);
  const lastCheckpoint = task.checkpoints?.at(-1);
  task.status = 'pending';
  task.phase = 'initializing';
  task.plan = resumePlanFromCheckpoint(task.plan, lastCheckpoint?.stepId);
  task.updatedAt = now;
  taskStore.save(task);
  writeTrace(task.id, 'phase', 'initializing', {
    ok: true,
    summary: lastCheckpoint
      ? `用户恢复历史任务，从 checkpoint 继续：${lastCheckpoint.label}`
      : '用户恢复历史任务，使用持久消息历史重新进入 Agent 循环',
    data: { previousStatus, previousPhase, patchedToolResults, checkpoint: lastCheckpoint },
  });
  return task;
}

/**
 * 编辑重跑（Claude Code Rewind 的对话截断语义）：
 * 把目标消息及其之后的所有消息从活跃历史移除，使任务回到该消息发送前的状态。
 * 不回滚已落盘文件（Aurevoy 当前无 per-tool 文件快照，且已 apply 的产物不应被静默回滚）。
 * 截断前将移除的消息归档到 archivedMessages（支持 unrevert）。
 *
 * - code_and_conv: 截断对话 + 清除 checkpoint/artifact/plan（完整重做）
 * - conv_only: 仅截断对话，保留 checkpoint/artifact/plan（文件没问题，只想重新推理）
 *
 * 截断后调用方通常再 addUserTurn(编辑后的文本) + runTask，实现"带上下文从该点重新生成"。
 */
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
  const removedCount = removedMessages.length;

  task.archivedMessages = removedMessages;
  task.messages = task.messages.slice(0, index);

  if (mode === 'code_and_conv') {
    const revertTime = removed.createdAt;
    task.checkpoints = (task.checkpoints ?? []).filter((cp) => cp.createdAt < revertTime);
    task.artifacts = (task.artifacts ?? []).filter((artifact) => {
      if (artifact.status === 'applied') return true;
      return artifact.createdAt < revertTime;
    });
    task.plan = task.plan.filter((step) => step.status === 'completed');

    // P6: 回滚被截断消息关联的文件写入（从快照恢复）
    const removedCallIds = new Set(
      removedMessages.flatMap((m) => m.toolCalls ?? []).map((tc) => tc.id),
    );
    const snapshotsToRestore = (task.fileSnapshots ?? [])
      .filter((s) => removedCallIds.has(s.callId));
    if (snapshotsToRestore.length > 0) {
      restoreFilesFromSnapshots(task, snapshotsToRestore).catch(() => {
        // 文件恢复失败不阻塞 revert 操作
      });
    }
  }

  task.status = 'paused';
  task.phase = null;
  task.updatedAt = new Date().toISOString();
  taskStore.save(task);

  taskEvents.publish({
    type: 'reverted',
    taskId: task.id,
    messageId,
    removedCount,
    archivedCount: removedMessages.length,
  });

  writeTrace(task.id, 'phase', null, {
    ok: true,
    summary: `编辑重跑(mode=${mode})：截断到消息 ${messageId} 之前，移除 ${removedCount} 条消息（已归档），不回滚已落盘文件`,
    data: { messageId, mode, removedCount, archivedCount: removedMessages.length },
  });

  return {
    task,
    removedContent: removed.role === 'user' ? removed.content : null,
    removedMessageId: removed.id,
    removedCount,
  };
}

/**
 * 撤销上一次 revert：从 archivedMessages 恢复被截断的消息到活跃历史。
 * 仅在 revert 后尚未提交新的 continue 时可用（archivedMessages 非空且任务处于 paused）。
 */
export function unrevertTask(task: Task): { task: Task; restoredCount: number } {
  const archived = task.archivedMessages ?? [];
  if (archived.length === 0) {
    return { task, restoredCount: 0 };
  }

  task.messages = [...task.messages, ...archived];
  task.archivedMessages = [];

  const lastMessage = task.messages.at(-1);
  task.status = lastMessage?.role === 'user' ? 'completed' : 'completed';
  task.phase = 'finalizing';
  task.updatedAt = new Date().toISOString();
  taskStore.save(task);

  const restoredCount = archived.length;

  taskEvents.publish({
    type: 'unreverted',
    taskId: task.id,
    restoredCount,
  });

  writeTrace(task.id, 'phase', null, {
    ok: true,
    summary: `撤销编辑重跑：恢复 ${restoredCount} 条归档消息到活跃历史`,
    data: { restoredCount },
  });

  return { task, restoredCount };
}

/**
 * 从指定消息处分支出一个新任务（非破坏性 fork）。
 * 克隆父任务到目标消息（含）为止的所有消息，每条消息分配新 ID，
 * 新任务独立演进，原任务不受影响。
 */
export function branchTask(
  parentTask: Task,
  messageId: string,
  goalOverride?: string,
): { task: Task; messageCount: number } {
  const index = parentTask.messages.findIndex((m) => m.id === messageId);
  if (index < 0) {
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      goal: goalOverride ?? parentTask.goal,
      status: 'pending',
      phase: 'initializing',
      plan: [],
      messages: [],
      parentTaskId: parentTask.id,
      projectId: parentTask.projectId,
      createdAt: now,
      updatedAt: now,
    };
    taskStore.save(task);
    return { task, messageCount: 0 };
  }

  const sourceMessages = parentTask.messages.slice(0, index + 1);
  const idMap = new Map<string, string>();
  for (const msg of sourceMessages) {
    idMap.set(msg.id, randomUUID());
  }

  const clonedMessages: Message[] = sourceMessages.map((msg) => {
    const cloned: Message = {
      ...msg,
      id: idMap.get(msg.id)!,
    };
    if (cloned.toolCalls) {
      cloned.toolCalls = cloned.toolCalls.map((tc) => ({
        ...tc,
        id: idMap.get(tc.id) ?? randomUUID(),
      }));
    }
    if (cloned.toolCallId) {
      cloned.toolCallId = idMap.get(cloned.toolCallId) ?? cloned.toolCallId;
    }
    return cloned;
  });

  const now = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    goal: goalOverride ?? parentTask.goal,
    status: 'completed',
    phase: 'finalizing',
    plan: [],
    messages: clonedMessages,
    parentTaskId: parentTask.id,
    projectId: parentTask.projectId,
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
 * 将指定消息范围压缩为 LLM 生成的摘要（上下文窗口管理）。
 * 替换原消息为一条 system 摘要消息，释放上下文空间。
 * 不截断对话，仅压缩旧消息。
 */
export async function compactTask(
  task: Task,
  fromMessageId?: string,
  toMessageId?: string,
): Promise<{ task: Task; originalCount: number; summaryLength: number }> {
  const messages = task.messages;
  const fromIndex = fromMessageId
    ? messages.findIndex((m) => m.id === fromMessageId)
    : 0;
  const toIndex = toMessageId
    ? messages.findIndex((m) => m.id === toMessageId)
    : messages.length - 1;

  if (fromIndex < 0 || toIndex < 0 || fromIndex > toIndex) {
    return { task, originalCount: 0, summaryLength: 0 };
  }

  const toCompress = messages.slice(fromIndex, toIndex + 1);
  if (toCompress.length <= 1) {
    return { task, originalCount: toCompress.length, summaryLength: 0 };
  }

  const transcript = toCompress
    .map((m) => `[${m.role}]: ${m.content.slice(0, 800)}`)
    .join('\n\n');

  let summaryText = '';
  try {
    const promptMessages: Message[] = [
      {
        id: randomUUID(),
        role: 'user',
        content: `请将以下对话记录压缩为一段简洁的摘要（200字以内），保留关键信息、决策和结论。只输出摘要文本，不要加前缀：\n\n${transcript}`,
        createdAt: new Date().toISOString(),
      },
    ];
    for await (const chunk of getProvider().stream(promptMessages)) {
      if (chunk.textDelta) summaryText += chunk.textDelta;
    }
  } catch (err) {
    writeTrace(task.id, 'error', null, {
      ok: false,
      errorCategory: 'model',
      errorMessage: err instanceof Error ? err.message : String(err),
      summary: 'compact LLM 摘要调用失败',
    });
    return { task, originalCount: toCompress.length, summaryLength: 0 };
  }

  if (!summaryText.trim()) {
    return { task, originalCount: toCompress.length, summaryLength: 0 };
  }

  const summaryMessage: Message = {
    id: randomUUID(),
    role: 'system',
    content: `[上下文摘要] ${summaryText.trim()}`,
    createdAt: new Date().toISOString(),
  };

  const before = messages.slice(0, fromIndex);
  const after = messages.slice(toIndex + 1);
  task.messages = [...before, summaryMessage, ...after];

  const originalCount = toCompress.length;
  const summaryLength = summaryText.trim().length;

  task.updatedAt = new Date().toISOString();
  taskStore.save(task);

  taskEvents.publish({
    type: 'compacted',
    taskId: task.id,
    originalCount,
    summaryLength,
  });

  writeTrace(task.id, 'phase', null, {
    ok: true,
    summary: `压缩 ${originalCount} 条消息为 ${summaryLength} 字符摘要`,
    data: { fromIndex, toIndex, originalCount, summaryLength },
  });

  return { task, originalCount, summaryLength };
}

/** 解析用户输入中的斜杠命令前缀。返回 skill 名称和去除前缀后的文本。 */
function parseSlashCommand(content: string): { skillName: string | null; text: string } {
  const match = content.match(/^\/(\S+)(?:\s+(.*))?/s);
  if (!match) return { skillName: null, text: content };
  const skillName = match[1];
  // 保留 /compact 为前端专有命令，不当作 skill
  if (skillName === 'compact') return { skillName: null, text: content };
  return { skillName, text: match[2]?.trim() || '' };
}

/**
 * 在同一任务内追加一轮用户输入（多轮对话）。
 *
 * 仅追加 user 消息并持久化、广播；调用方随后再 `runTask(task)`，
 * 循环会带着完整的历史 `task.messages` 作为上下文继续推进。
 */
export function addUserTurn(
  task: Task,
  content: string,
  attachments?: MessageAttachment[],
): Message {
  // Skill: 解析斜杠命令前缀
  const parsed = parseSlashCommand(content);
  let messageContent = content;
  if (parsed.skillName) {
    const skill = skillRegistry.get(parsed.skillName);
    if (skill) {
      task.activeSkills = [parsed.skillName];
      messageContent = parsed.text || parsed.skillName;
      taskEvents.publish({
        type: 'skill_activated',
        taskId: task.id,
        skillName: parsed.skillName,
        allowedTools: skill.frontmatter['allowed-tools'],
      });
    }
  }

  const userMsg: Message = {
    id: randomUUID(),
    role: 'user',
    content: messageContent,
    createdAt: new Date().toISOString(),
    attachments,
  };
  task.messages.push(userMsg);
  // 复用任务时，从终态回到待运行；phase 进入 initializing
  task.status = 'pending';
  task.phase = 'initializing';
  task.updatedAt = userMsg.createdAt;
  taskStore.save(task);
  taskEvents.publish({ type: 'message', taskId: task.id, message: userMsg });
  writeTrace(task.id, 'phase', 'initializing', {
    ok: true,
    summary: '收到后续输入，继续任务',
    data: { message: messageContent },
  });
  return userMsg;
}

/** 投递一次工具审批决策（由 server 的审批端点调用）。返回是否命中等待中的请求。 */
export function resolveApproval(taskId: string, callId: string, approved: boolean): boolean {
  const resolve = pendingApprovals.get(taskId)?.get(callId);
  if (!resolve) return false;
  resolve(approved);
  return true;
}

/** 投递一次用户追问回复；返回是否命中等待中的请求。 */
export function resolveClarificationAnswer(
  taskId: string,
  clarificationId: string,
  answer: string,
): boolean {
  const resolve = pendingClarifications.get(taskId)?.get(clarificationId);
  if (!resolve) return false;
  resolve(answer);
  return true;
}

/** 等待用户对某次工具调用的审批；超时或任务取消视为拒绝。 */
function waitForApproval(taskId: string, callId: string, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      const map = pendingApprovals.get(taskId);
      map?.delete(callId);
      if (map && map.size === 0) pendingApprovals.delete(taskId);
    };
    const finish = (approved: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(approved);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), config.agent.approvalTimeoutMs);

    if (signal.aborted) return finish(false);
    signal.addEventListener('abort', onAbort, { once: true });
    let map = pendingApprovals.get(taskId);
    if (!map) {
      map = new Map();
      pendingApprovals.set(taskId, map);
    }
    map.set(callId, finish);
  });
}

/** 等待用户回复追问；超时或任务取消返回 null，不伪造用户输入。 */
function waitForClarification(
  taskId: string,
  clarificationId: string,
  signal: AbortSignal,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      const map = pendingClarifications.get(taskId);
      map?.delete(clarificationId);
      if (map && map.size === 0) pendingClarifications.delete(taskId);
    };
    const finish = (answer: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(answer);
    };
    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(null), config.agent.approvalTimeoutMs);

    if (signal.aborted) return finish(null);
    signal.addEventListener('abort', onAbort, { once: true });
    let map = pendingClarifications.get(taskId);
    if (!map) {
      map = new Map();
      pendingClarifications.set(taskId, map);
    }
    map.set(clarificationId, finish);
  });
}

/** 创建一个新任务并持久化（尚未开始执行） */
export function createTask(
  goal: string,
  budget?: TaskBudget,
  projectId?: string,
  attachments?: MessageAttachment[],
): Task {
  const now = new Date().toISOString();
  const userMsg: Message = {
    id: randomUUID(),
    role: 'user',
    content: goal,
    createdAt: now,
    attachments,
  };
  const task: Task = {
    id: randomUUID(),
    goal,
    status: 'pending',
    phase: 'initializing',
    plan: [],
    messages: [userMsg],
    artifacts: [],
    clarifications: [],
    checkpoints: [],
    budget: normalizeBudget(budget),
    budgetUsage: initialBudgetUsage(),
    tokenUsage: { available: false, provider: getProviderName(), model: config.llm.model },
    projectId: projectId ?? undefined,
    createdAt: now,
    updatedAt: now,
  };
  taskStore.save(task);
  writeTrace(task.id, 'phase', 'initializing', {
    ok: true,
    summary: '任务已创建',
    data: { goal },
  });
  return task;
}

/**
 * 解析任务的有效工作区目录。
 * - 有项目：使用项目目录
 * - 无项目：使用全局 workspace/.sessions/<taskId> 隔离
 */
export async function resolveTaskWorkspace(task: Task): Promise<string> {
  if (task.projectId) {
    const project = projectStore.get(task.projectId);
    if (project) return resolve(project.path);
  }
  const standaloneDir = resolve(config.workspaceDir, '.sessions', task.id);
  await fs.mkdir(standaloneDir, { recursive: true });
  return standaloneDir;
}

/** P6: 在写操作前捕获文件快照（用于 Rewind 回滚）。 */
async function captureFileSnapshot(
  filePath: string,
  taskId: string,
  workspaceDir: string,
): Promise<string | null> {
  const snapshotDir = join(workspaceDir, '.aurevoy-snapshots', taskId);
  await fs.mkdir(snapshotDir, { recursive: true });
  const snapshotId = randomUUID();
  const snapshotPath = join(snapshotDir, snapshotId);

  try {
    await fs.copyFile(filePath, snapshotPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // 文件不存在（即将创建），记录空快照
      await fs.writeFile(snapshotPath, '', 'utf8');
    } else {
      return null; // 快照失败不阻塞操作
    }
  }

  return snapshotId;
}

/** P6: 从快照恢复文件（Rewind 时调用）。 */
async function restoreFilesFromSnapshots(
  task: Task,
  snapshots: FileSnapshot[],
): Promise<void> {
  const workspaceDir = await resolveTaskWorkspace(task);
  for (const snapshot of snapshots) {
    const snapshotPath = join(
      workspaceDir,
      '.aurevoy-snapshots',
      task.id,
      snapshot.id,
    );
    const targetPath = resolve(workspaceDir, snapshot.path);
    try {
      const stat = await fs.stat(snapshotPath);
      if (stat.size === 0) {
        // 空快照 = 文件在写入前不存在，删除目标文件
        await fs.unlink(targetPath).catch(() => {});
      } else {
        await fs.copyFile(snapshotPath, targetPath);
      }
    } catch {
      // 快照文件可能已被清理
    }
  }
}

/** 已知的文本文件扩展名集合，用于判断附件是否可直接读入上下文。 */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.jsonc', '.json5',
  '.css', '.scss', '.sass', '.less',
  '.html', '.htm', '.xml', '.svg',
  '.md', '.mdx', '.markdown',
  '.txt', '.log', '.csv',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.env',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.hh',
  '.sh', '.bash', '.zsh', '.fish',
  '.sql', '.graphql', '.gql',
  '.vue', '.svelte', '.astro',
  '.prisma', '.proto',
  '.gitignore', '.gitattributes', '.editorconfig',
  '.eslintrc', '.prettierrc',
]);

function isTextFile(mimeType: string, name: string): boolean {
  if (mimeType.startsWith('text/')) return true;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
  return TEXT_EXTENSIONS.has(ext);
}

/** 最大注入到上下文中的单文件字符数（~8K tokens，防止单文件撑满窗口）。 */
const MAX_ATTACHMENT_CONTENT_CHARS = 30_000;

/**
 * 为任务中带附件的用户消息构建附加上下文。
 * 读取文本文件内容，合成为一条 system 消息，注入到 LLM 请求中。
 */
async function buildAttachmentSystemMessage(task: Task): Promise<string | null> {
  // 找到所有带附件的用户消息（取最新的那条，避免多轮重复注入）
  const messagesWithAttachments = task.messages.filter(
    (m) => m.role === 'user' && m.attachments && m.attachments.length > 0,
  );
  if (messagesWithAttachments.length === 0) return null;

  // 只取最后一轮（最新）带附件的消息
  const lastMsg = messagesWithAttachments[messagesWithAttachments.length - 1];
  if (!lastMsg.attachments) return null;

  const lines: string[] = [];
  lines.push('[Attached Files]');
  lines.push('');

  for (const att of lastMsg.attachments) {
    // 图片附件由 Provider 层以多模态 content block 注入，此处不处理
    if (att.type === 'image') continue;

    if (isTextFile(att.mimeType, att.name)) {
      try {
        let content = await fs.readFile(att.path, 'utf8');
        if (content.length > MAX_ATTACHMENT_CONTENT_CHARS) {
          content = content.slice(0, MAX_ATTACHMENT_CONTENT_CHARS) +
            `\n\n[... 文件过长，已截断。使用 read_file 工具读取完整内容，路径: ${att.path}]`;
        }
        lines.push(`### ${att.name} (path: ${att.path})`);
        lines.push('');
        lines.push(content);
        lines.push('');
      } catch {
        lines.push(`### ${att.name} (path: ${att.path})`);
        lines.push(`[无法直接读取文件内容，使用 read_file 工具读取，路径: ${att.path}]`);
        lines.push('');
      }
    } else {
      lines.push(`### ${att.name} (path: ${att.path}, type: ${att.mimeType})`);
      lines.push(`[非文本文件，使用 read_file 工具读取，路径: ${att.path}]`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Agent 主循环（ReAct 工具调用循环）。
 *
 * 每轮调用 LLM：若模型请求工具，则执行并把结果作为 role:'tool' 消息回灌，再次请求；
 * 直到模型给出最终答案、达到最大轮次或被取消。
 * 含防死循环（指纹去重）、重试（指数退避）、取消（AbortController）与每轮持久化。
 */
export async function runTask(task: Task): Promise<void> {
  const abortController = new AbortController();
  activeAbortControllers.set(task.id, abortController);
  const taskStartedAtMs = Date.now();
  const taskWorkspace = await resolveTaskWorkspace(task);

  const touch = () => {
    task.updatedAt = new Date().toISOString();
    taskStore.save(task);
  };

  task.plan = await buildInitialPlan(task, taskWorkspace, abortController.signal);
  let activeStepIndex = task.plan.findIndex((step) => step.status === 'running');
  if (activeStepIndex < 0) activeStepIndex = 0;
  task.plan = task.plan.map((step, index) => ({
    ...step,
    status: index === activeStepIndex ? 'running' : step.status,
  }));

  const updateStep = (description: string, status: PlanStep['status']) => {
    const index = Math.max(0, Math.min(activeStepIndex, task.plan.length - 1));
    const step = task.plan[index] ?? { id: 'exec', description, status };
    const next = { ...step, description, status };
    task.plan[index] = next;
    touch();
    taskEvents.publish({ type: 'step_update', taskId: task.id, step: { ...next } });
  };
  const completeCurrentStep = (label: string, data?: unknown) => {
    const current = task.plan[activeStepIndex];
    if (!current) return;
    if (current.status !== 'completed') {
      task.plan[activeStepIndex] = { ...current, status: 'completed' };
      taskEvents.publish({ type: 'step_update', taskId: task.id, step: task.plan[activeStepIndex] });
    }
    const checkpoint = createCheckpoint({
      label,
      stepId: current.id,
      message: `完成步骤：${current.description}`,
      data,
    });
    task.checkpoints = [...(task.checkpoints ?? []), checkpoint];
    taskEvents.publish({ type: 'checkpoint_created', taskId: task.id, checkpoint });
    if (activeStepIndex < task.plan.length - 1) {
      activeStepIndex += 1;
      task.plan[activeStepIndex] = { ...task.plan[activeStepIndex], status: 'running' };
      taskEvents.publish({ type: 'step_update', taskId: task.id, step: task.plan[activeStepIndex] });
    }
    touch();
  };
  const setRuntimePhase = (phase: TaskPhase, detail?: string, status?: TaskStatus) => {
    if (status && task.status !== status) {
      task.status = status;
      taskEvents.publish({ type: 'status', taskId: task.id, status });
    }
    task.phase = phase;
    touch();
    writeTrace(task.id, 'phase', phase, { ok: true, summary: detail });
    taskEvents.publish({ type: 'phase', taskId: task.id, phase, detail });
  };
  const handleAskUserTool = async (call: ToolCall, iteration: number): Promise<Message> => {
    const question =
      typeof call.args.question === 'string' && call.args.question.trim()
        ? call.args.question.trim()
        : '请补充完成任务所需的信息。';
    const options = Array.isArray(call.args.options)
      ? call.args.options.filter((item): item is string => typeof item === 'string')
      : undefined;
    const context = typeof call.args.context === 'string' ? call.args.context : undefined;
    const clarification = createClarification({ callId: call.id, question, options, context });
    task.clarifications = [...(task.clarifications ?? []), clarification];
    touch();
    taskEvents.publish({ type: 'clarification_request', taskId: task.id, clarification });
    writeTrace(task.id, 'tool_call', 'waiting_clarification', {
      iteration,
      callId: call.id,
      toolName: 'ask_user',
      riskLevel: 'safe',
      ok: true,
      summary: 'Agent 发起追问',
      data: { question, options, context },
    });
    updateStep('等待用户补充信息', 'paused');
    setRuntimePhase('waiting_clarification', question, 'paused');

    const answer = await waitForClarification(task.id, clarification.id, abortController.signal);
    if (abortController.signal.aborted) {
      resolveClarification(task, clarification.id, 'cancelled');
      touch();
      return makeToolResult(call.id, { error: '任务已取消，追问未完成' });
    }

    const resolved = answer == null
      ? resolveClarification(task, clarification.id, 'timeout')
      : resolveClarification(task, clarification.id, 'answered', answer);
    touch();
    if (resolved) {
      taskEvents.publish({ type: 'clarification_resolved', taskId: task.id, clarification: resolved });
    }
    const result: ToolResult =
      answer == null
        ? { callId: call.id, ok: false, error: '用户未回复追问，等待已超时' }
        : { callId: call.id, ok: true, output: { answer } };
    taskEvents.publish({ type: 'tool_result', taskId: task.id, result });
    writeTrace(task.id, 'tool_result', 'waiting_clarification', {
      iteration,
      callId: call.id,
      toolName: 'ask_user',
      riskLevel: 'safe',
      ok: result.ok,
      errorCategory: result.ok ? undefined : 'timeout',
      errorMessage: result.error,
      summary: result.ok ? '用户已回复追问' : '追问等待超时',
      data: result.ok ? { answer } : undefined,
    });
    return makeToolResult(
      call.id,
      result.ok ? result.output : { error: '用户未回复追问，不能假定答案；请降级、改问或解释无法继续。' },
    );
  };

  const messages = task.messages;
  const callFingerprints = new Map<string, number>();

  // 构建附件上下文（仅在任务首次运行时构建一次）
  const attachmentContext = await buildAttachmentSystemMessage(task);
  const attachmentSystemMessage: Message | null = attachmentContext
    ? { id: `att-${randomUUID()}`, role: 'system', content: attachmentContext, createdAt: new Date().toISOString() }
    : null;

  try {
    setRuntimePhase('initializing', '准备运行任务', 'running');
    taskEvents.publish({ type: 'plan', taskId: task.id, plan: task.plan });

    for (let iteration = 0; ; iteration++) {
      if (abortController.signal.aborted) return finishCancelled(task, updateStep, touch);
      task.budgetUsage = task.budgetUsage ?? initialBudgetUsage();
      task.budgetUsage.iterations = iteration;
      updateWallTime(task, taskStartedAtMs);
      assertBudgetWithinLimits(task);
      task.budgetUsage.iterations = iteration + 1;
      taskEvents.publish({
        type: 'budget_usage',
        taskId: task.id,
        usage: task.budgetUsage,
        budget: effectiveBudget(task),
      });
      setRuntimePhase('thinking', `第 ${iteration + 1} 轮模型思考`, 'running');

      let textBuffer = '';
      let reasoningContent = '';
      let finishReason: string | undefined;
      let tokenUsage: TokenUsage | null | undefined;
      let toolCalls: AccumulatedToolCall[] = [];
      const llmStartedAt = Date.now();

      // P4: 自动语义压缩（token 感知，LLM 摘要旧消息）
      const compactResult = await autoCompactIfNeeded(messages);
      if (compactResult.compressed) {
        writeTrace(task.id, 'phase', 'thinking', {
          iteration: iteration + 1,
          ok: true,
          summary: `自动语义压缩：${compactResult.compressedGroupCount} 组消息 → 摘要，释放 ~${compactResult.savedTokens} tokens`,
          data: {
            originalTokens: compactResult.originalTokens,
            finalTokens: compactResult.finalTokens,
            compressedGroupCount: compactResult.compressedGroupCount,
            savedTokens: compactResult.savedTokens,
            tokenBudget: config.agent.contextTokenBudget,
            threshold: config.agent.compactThreshold,
          },
        });
      }

      // 会话级短期记忆：把完整历史压缩为本轮上下文窗口（非裸拼接）
      const ctx = buildContextWindow(compactResult.messages);
      if (ctx.compressed) {
        writeTrace(task.id, 'phase', 'thinking', {
          iteration: iteration + 1,
          ok: true,
          summary: `上下文压缩：${ctx.totalMessages} 条历史，${ctx.originalChars}→${ctx.finalChars} 字符，压缩 ${ctx.compressedCount} 条`,
          data: {
            originalChars: ctx.originalChars,
            finalChars: ctx.finalChars,
            compressedCount: ctx.compressedCount,
            totalMessages: ctx.totalMessages,
            charBudget: config.agent.contextCharBudget,
          },
        });
      }

      // P5: 长期记忆——按目标相关性评分 + [[link]] 展开后注入（禁用的不注入）
      const recentTopics = messages
        .filter((m) => m.role === 'user')
        .slice(-3)
        .map((m) => m.content);
      const memoryMessage = buildMemorySystemMessage(
        memoryStore.listEnabled(),
        task.goal,
        recentTopics,
      );

      // Skill: 应用工具白名单 + 注入 skill system prompt
      const activeSkillName = task.activeSkills?.[0];
      const allowedToolNames = activeSkillName
        ? skillRegistry.getAllowedTools(activeSkillName)
        : undefined;
      const toolDescriptors = toolRegistry.list(allowedToolNames);
      const skillMessage = buildSkillSystemMessage(activeSkillName);

      const requestMessages = [
        memoryMessage,
        skillMessage,
        attachmentSystemMessage,
        ...ctx.messages,
      ].filter(Boolean) as Message[];

      // ---------- 调用 LLM（带重试） ----------
      try {
        await withRetry(
          async () => {
            // 重试时重置本轮累积
            textBuffer = '';
            reasoningContent = '';
            finishReason = undefined;
            tokenUsage = undefined;
            toolCalls = [];
            const stream = getProvider().stream(requestMessages, {
              tools: toolDescriptors.length > 0 ? toolDescriptors : undefined,
              toolChoice: 'auto',
              signal: abortController.signal,
            });
            for await (const chunk of stream) {
              if (chunk.textDelta) {
                textBuffer += chunk.textDelta;
                task.budgetUsage = task.budgetUsage ?? initialBudgetUsage();
                task.budgetUsage.outputBytes += Buffer.byteLength(chunk.textDelta);
                assertBudgetWithinLimits(task);
                taskEvents.publish({ type: 'token', taskId: task.id, delta: chunk.textDelta });
              }
              if (chunk.reasoningContentDelta) reasoningContent += chunk.reasoningContentDelta;
              if (chunk.done) {
                finishReason = chunk.finishReason;
                toolCalls = chunk.toolCallsSnapshot ?? [];
                tokenUsage = chunk.tokenUsage;
              }
            }
          },
          abortController.signal,
        );
        const aggregatedUsage = addTokenUsage(task, tokenUsage);
        taskEvents.publish({ type: 'token_usage', taskId: task.id, usage: aggregatedUsage });
        writeTrace(task.id, 'llm', 'thinking', {
          iteration: iteration + 1,
          startedAtMs: llmStartedAt,
          tokenUsage,
          ok: true,
          finishReason,
          summary: finishReason === 'tool_calls' ? '模型请求工具调用' : '模型返回回复',
          data: {
            outputChars: textBuffer.length,
            reasoningChars: reasoningContent.length,
            toolCallCount: toolCalls.length,
          },
        });
      } catch (err) {
        writeTrace(task.id, 'llm', 'thinking', {
          iteration: iteration + 1,
          startedAtMs: llmStartedAt,
          ok: false,
          errorCategory: classifyError(err),
          errorMessage: err instanceof Error ? err.message : String(err),
          summary: '模型调用失败',
        });
        throw err;
      }

      // ---------- 情况 A：输出被截断 ----------
      if (finishReason === 'length') {
        setRuntimePhase('finalizing', '模型输出达到长度上限，整理已有内容', 'running');
        const msg = makeAssistant(
          textBuffer + '\n\n[提示：回复因达到长度上限被截断，可能不完整。]',
          reasoningContent,
        );
        messages.push(msg);
        taskEvents.publish({ type: 'message', taskId: task.id, message: msg });
        return finishCompleted(task, updateStep, touch);
      }

      // ---------- 情况 B：模型直接给出最终回复 ----------
      if (finishReason !== 'tool_calls' || toolCalls.length === 0) {
        setRuntimePhase('finalizing', '模型给出最终回复', 'running');
        const msg = makeAssistant(textBuffer, reasoningContent);
        messages.push(msg);
        taskEvents.publish({ type: 'message', taskId: task.id, message: msg });
        return finishCompleted(task, updateStep, touch);
      }

      // ---------- 情况 C：模型请求调用工具 ----------
      if (toolCalls.length > MAX_TOOL_CALLS_PER_TURN) {
        toolCalls = toolCalls.slice(0, MAX_TOOL_CALLS_PER_TURN);
      }

      // 先把 assistant（含 tool_calls）加入上下文
      const assistantMsg = makeAssistantWithToolCalls(textBuffer, reasoningContent, toolCalls);
      messages.push(assistantMsg);
      taskEvents.publish({ type: 'message', taskId: task.id, message: assistantMsg });

      // P2: 并行工具执行 —— 预校验 → 分区 → 并行/并发审批
      // Step 1: 预校验所有 tool calls（指纹去重 + JSON 解析 + 风险查询）
      interface ValidatedCall {
        tc: AccumulatedToolCall;
        call: ToolCall;
        risk: ToolRiskLevel;
        skipReason?: string;
      }
      const validatedCalls: ValidatedCall[] = [];
      for (const tc of toolCalls) {
        const name = tc.function.name;
        const fingerprint = `${name}:${tc.function.arguments}`;
        const count = (callFingerprints.get(fingerprint) ?? 0) + 1;
        callFingerprints.set(fingerprint, count);

        let skipReason: string | undefined;
        if (count > DUPLICATE_CALL_LIMIT) {
          skipReason = `工具 "${name}" 已用相同参数被调用 ${count} 次。请换一种方式，或直接给出最终答案。`;
        }

        let args: Record<string, unknown> = {};
        if (!skipReason) {
          try {
            args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch {
            skipReason = `工具参数不是合法 JSON：${tc.function.arguments}`;
          }
        }

        validatedCalls.push({
          tc,
          call: { id: tc.id, toolName: name, args },
          risk: toolRegistry.riskLevelOf(name),
          skipReason,
        });
      }

      // Step 2: 发布 tool_call 事件 + 批量更新预算
      for (const v of validatedCalls) {
        if (v.skipReason) continue;
        taskEvents.publish({ type: 'tool_call', taskId: task.id, call: v.call });
        writeToolCallTrace(task.id, v.call, v.risk, iteration + 1);
      }
      task.budgetUsage = task.budgetUsage ?? initialBudgetUsage();
      task.budgetUsage.toolCalls += validatedCalls.filter((v) => !v.skipReason).length;
      updateWallTime(task, taskStartedAtMs);
      taskEvents.publish({
        type: 'budget_usage',
        taskId: task.id,
        usage: task.budgetUsage,
        budget: effectiveBudget(task),
      });
      assertBudgetWithinLimits(task);

      // Step 3: ask_user 特殊处理（阻塞等待用户输入，不能并行）
      const askUserItem = validatedCalls.find(
        (v) => v.call.toolName === 'ask_user' && !v.skipReason,
      );
      if (askUserItem) {
        setRuntimePhase('calling_tool', '等待用户补充信息', 'running');
        const toolMessage = await handleAskUserTool(askUserItem.call, iteration + 1);
        messages.push(toolMessage);
        if (abortController.signal.aborted) return finishCancelled(task, updateStep, touch);
        setRuntimePhase('thinking', '已收到追问回复，继续推理', 'running');
      }

      // Step 4: 分区 —— safe+可并行 vs 需审批/不可并行
      const toExecute = validatedCalls.filter(
        (v) => !v.skipReason && v.call.toolName !== 'ask_user',
      );
      // 自动批准：safe 风险 OR 用户在设置中开启了 auto-approve
      const approvedTools = new Set(config.sandbox.autoApprovedTools);
      const isAutoApproved = (name: string) => approvedTools.has(name);

      const isParallelSafe = (v: ValidatedCall) =>
        (v.risk === 'safe' || isAutoApproved(v.call.toolName)) &&
        toolRegistry.executionPolicyOf(v.call.toolName).parallelizable !== false;
      const safeOnes = toExecute.filter(isParallelSafe);
      const riskyOnes = toExecute.filter((v) => !isParallelSafe(v));

      // 执行单个工具的共享逻辑（不含审批门——审批在外部处理）
      const executeOne = async (
        v: ValidatedCall,
        approved = true,
      ): Promise<{ callId: string; output: unknown }> => {
        if (!approved) {
          const denied = {
            callId: v.call.id,
            ok: false,
            error: '用户拒绝了该工具调用',
          };
          taskEvents.publish({ type: 'tool_result', taskId: task.id, result: denied });
          writeTrace(task.id, 'tool_result', 'calling_tool', {
            iteration: iteration + 1,
            callId: v.call.id,
            toolName: v.call.toolName,
            riskLevel: v.risk,
            ok: false,
            errorCategory: 'permission' as TaskErrorCategory,
            errorMessage: denied.error,
            summary: `工具被拒绝：${v.call.toolName}`,
          });
          return {
            callId: v.call.id,
            output: {
              error: '用户拒绝执行该工具。请改用其他方式，或直接给出最终答案。',
            },
          };
        }

        updateStep(`调用工具：${v.call.toolName}`, 'running');
        const toolStartedAt = Date.now();

        // P6: 写入类工具执行前捕获文件快照（用于 Rewind 回滚）
        if (WRITE_TOOLS.has(v.call.toolName) && typeof v.call.args.path === 'string') {
          try {
            const absPath = resolve(taskWorkspace, v.call.args.path);
            const snapshotId = await captureFileSnapshot(absPath, task.id, taskWorkspace);
            if (snapshotId) {
              const snapshot: FileSnapshot = {
                id: snapshotId,
                path: v.call.args.path,
                callId: v.call.id,
                createdAt: new Date().toISOString(),
              };
              task.fileSnapshots = [...(task.fileSnapshots ?? []), snapshot];
            }
          } catch {
            // 快照失败不阻塞工具执行
          }
        }

        const result = await toolRegistry.invokeWithTimeout(
          v.call,
          {
            taskId: task.id,
            taskGoal: task.goal,
            task,
            abortSignal: abortController.signal,
            workspaceDir: taskWorkspace,
          },
          config.agent.toolTimeoutMs,
        );

        // P6: 失败时附加 fallback 建议
        const rawResult = !result.ok
          ? { ...result, fallback: toolRegistry.fallbackFor(v.call.toolName) }
          : result;
        const enrichedResult = handleToolSideEffects(task, v.call, rawResult);
        task.budgetUsage = task.budgetUsage ?? initialBudgetUsage();
        task.budgetUsage.outputBytes += estimatePayloadBytes(
          enrichedResult.output ?? enrichedResult.error ?? '',
        );
        assertBudgetWithinLimits(task);
        taskEvents.publish({ type: 'tool_result', taskId: task.id, result: enrichedResult });
        writeTrace(task.id, 'tool_result', 'calling_tool', {
          iteration: iteration + 1,
          startedAtMs: toolStartedAt,
          callId: v.call.id,
          toolName: v.call.toolName,
          riskLevel: v.risk,
          ok: enrichedResult.ok,
          errorCategory: enrichedResult.ok ? undefined : 'tool',
          errorMessage: enrichedResult.error,
          summary: enrichedResult.ok
            ? `工具成功：${v.call.toolName}`
            : `工具失败：${v.call.toolName}`,
          data: enrichedResult.ok
            ? { output: summarizePayload(enrichedResult.output) }
            : undefined,
        });
        if (enrichedResult.ok) {
          completeCurrentStep(`工具完成：${v.call.toolName}`, {
            toolName: v.call.toolName,
            callId: v.call.id,
            output: summarizePayload(enrichedResult.output),
          });
        }

        return {
          callId: v.call.id,
          output: enrichedResult.ok
            ? enrichedResult.output
            : { error: enrichedResult.error },
        };
      };

      // Step 5: 收集所有执行结果（按 callId 索引）
      const resultByCallId = new Map<string, { callId: string; output: unknown }>();

      // 5a: 跳过项 → 错误结果
      for (const v of validatedCalls.filter((v) => v.skipReason)) {
        resultByCallId.set(v.tc.id, {
          callId: v.tc.id,
          output: { error: v.skipReason },
        });
      }

      // 5b: safe 工具 → 全并行，各自独立超时
      if (safeOnes.length > 0) {
        setRuntimePhase(
          'calling_tool',
          `并行执行 ${safeOnes.length} 个工具`,
          'running',
        );
        const safeResults = await Promise.all(safeOnes.map((v) => executeOne(v)));
        for (const r of safeResults) resultByCallId.set(r.callId, r);
      }

      // 5c: risky 工具 → 并发发送审批请求，获批后并行执行
      if (riskyOnes.length > 0) {
        setRuntimePhase(
          'waiting_approval',
          `等待确认 ${riskyOnes.length} 个工具`,
          'paused',
        );

        // 并发发送所有审批请求
        const approvalResults = await Promise.all(
          riskyOnes.map(async (v) => {
            taskEvents.publish({
              type: 'approval_request',
              taskId: task.id,
              call: v.call,
              riskLevel: v.risk,
            });
            updateStep(`等待确认：${v.call.toolName}`, 'paused');
            const approved = await waitForApproval(
              task.id,
              v.tc.id,
              abortController.signal,
            );
            writeApprovalTrace(task.id, v.call, v.risk, approved, iteration + 1);
            return { v, approved };
          }),
        );

        if (abortController.signal.aborted)
          return finishCancelled(task, updateStep, touch);

        setRuntimePhase('calling_tool', '执行已批准的工具', 'running');

        // 并行执行所有（批准的 + 拒绝的）risky 工具
        const riskyResults = await Promise.all(
          approvalResults.map(({ v, approved }) => executeOne(v, approved)),
        );
        for (const r of riskyResults) resultByCallId.set(r.callId, r);
      }

      // Step 6: 按原始 toolCalls 顺序将结果回填到 messages
      for (const tc of toolCalls) {
        const result = resultByCallId.get(tc.id);
        if (result) {
          messages.push(makeToolResult(tc.id, result.output));
        }
        // ask_user 的结果已在 Step 3 由 handleAskUserTool 推送
      }

      // 每轮结束持久化，保证崩溃可恢复
      touch();
      if (abortController.signal.aborted) return finishCancelled(task, updateStep, touch);
    }

  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      return finishCancelled(task, updateStep, touch);
    }
    task.status = 'failed';
    task.phase = 'failed';
    updateStep('任务失败', 'failed');
    touch();
    const message = err instanceof Error ? err.message : String(err);
    writeTrace(task.id, 'error', 'failed', {
      ok: false,
      errorCategory: classifyError(err),
      errorMessage: message,
      summary: '任务失败',
    });
    taskEvents.publish({ type: 'status', taskId: task.id, status: 'failed' });
    taskEvents.publish({ type: 'phase', taskId: task.id, phase: 'failed', detail: message });
    taskEvents.publish({ type: 'error', taskId: task.id, message });
    taskEvents.publish({ type: 'done', taskId: task.id, status: 'failed' });
  } finally {
    activeAbortControllers.delete(task.id);
  }
}

// ---------------- 内部辅助 ----------------

/** 侦查阶段可用的工具（仅 safe 只读工具，不经过审批门）。 */
const SCOUT_TOOL_NAMES = new Set(['list_directory', 'read_file', 'search_files']);

/**
 * P1: 构建初始计划（异步）。
 *
 * 流程：
 * 1. 如果已有 >1 个未完成步骤（resume），直接复用
 * 2. 如果启用 LLM 规划 → 先侦查工作区，再让 LLM 生成结构化计划
 * 3. LLM 规划失败或未启用 → 回退到正则启发式计划
 */
async function buildInitialPlan(
  task: Task,
  taskWorkspace: string,
  signal: AbortSignal,
): Promise<PlanStep[]> {
  const existing = task.plan.filter((step) => step.status !== 'completed');
  if (existing.length > 1) return task.plan;

  if (config.agent.llmPlanningEnabled) {
    try {
      taskEvents.publish({ type: 'scout_started', taskId: task.id });
      writeTrace(task.id, 'phase', 'planning', {
        ok: true,
        summary: '开始侦查工作区以制定计划',
      });

      const scoutReport = await runScoutPhase(task.goal, taskWorkspace, signal);

      if (scoutReport && !signal.aborted) {
        taskEvents.publish({ type: 'scout_report', taskId: task.id, report: scoutReport });
        writeTrace(task.id, 'phase', 'planning', {
          ok: true,
          summary: `侦查完成：${scoutReport.keyFiles.length} 个关键文件，${scoutReport.rounds} 轮`,
          data: { scoutReport },
        });
      }

      if (scoutReport && !signal.aborted) {
        const generated = await generatePlanViaLLM(task.goal, scoutReport, signal);
        if (generated && generated.steps.length > 0 && !signal.aborted) {
          const plan = generated.steps.map((step, index): PlanStep => ({
            id: `step-${index + 1}`,
            description: step.description,
            status: index === 0 ? 'running' : 'pending',
            toolsExpected: step.toolsExpected,
            dependsOn: step.dependsOn,
            verifiable: step.verifiable,
            source: 'llm' as const,
          }));
          taskEvents.publish({ type: 'plan_generated', taskId: task.id, plan, source: 'llm' });
          writeTrace(task.id, 'phase', 'planning', {
            ok: true,
            summary: `LLM 生成 ${plan.length} 步计划，预估 ${generated.estimatedIterations} 轮，风险 ${generated.riskLevel}`,
            data: { generatedPlan: generated },
          });
          return plan;
        }
      }
    } catch (err) {
      writeTrace(task.id, 'error', 'planning', {
        ok: false,
        errorCategory: classifyError(err),
        errorMessage: err instanceof Error ? err.message : String(err),
        summary: 'LLM 规划失败，回退到启发式计划',
      });
    }
  }

  // 回退：正则启发式计划
  const generated = inferStructuredPlan(task.goal);
  if (generated.length === 0) {
    return [{ id: 'exec', description: '正在执行任务…', status: 'running' }];
  }
  const fallbackPlan = generated.map((description, index): PlanStep => ({
    id: `step-${index + 1}`,
    description,
    status: index === 0 ? 'running' : 'pending',
    source: 'heuristic' as const,
  }));
  taskEvents.publish({ type: 'plan_generated', taskId: task.id, plan: fallbackPlan, source: 'heuristic' });
  writeTrace(task.id, 'phase', 'planning', {
    ok: true,
    summary: `使用启发式计划（${fallbackPlan.length} 步）`,
    data: { plan: fallbackPlan },
  });
  return fallbackPlan;
}

// ---- 侦查阶段（P1）----

/**
 * 侦查工作区：用受限的 safe 工具快速了解文件结构、关键文件和约束。
 * 最多 N 轮 LLM 调用，只使用 list_directory / read_file / search_files。
 * 返回结构化侦查报告，供 plan generation 使用。
 */
async function runScoutPhase(
  goal: string,
  workspaceDir: string,
  signal: AbortSignal,
): Promise<ScoutReport | null> {
  const startedAt = Date.now();
  const maxRounds = config.agent.maxScoutRounds;
  const scoutTools = toolRegistry.list().filter((t) => SCOUT_TOOL_NAMES.has(t.name));

  const messages: Message[] = [
    {
      id: randomUUID(),
      role: 'system',
      content:
        '你是 Aurevoy 的侦查 Agent。你的任务是快速了解工作区的文件结构和关键信息，' +
        '为后续的任务规划提供依据。\n\n' +
        '约束：\n' +
        '- 只能使用 list_directory、read_file、search_files 工具\n' +
        '- 不要修改任何文件，不要执行命令\n' +
        '- 不要做深入分析——这是快速侦查，不是执行任务\n' +
        '- 当你觉得已经掌握了足够信息来制定计划时，直接输出侦查报告，不再调用工具',
      createdAt: new Date().toISOString(),
    },
    {
      id: randomUUID(),
      role: 'user',
      content: `用户目标：${goal}\n工作区路径：${workspaceDir}\n\n请快速侦查工作区，然后输出一份侦查报告。`,
      createdAt: new Date().toISOString(),
    },
  ];

  let rounds = 0;
  for (; rounds < maxRounds; rounds++) {
    if (signal.aborted) return null;

    let textBuffer = '';
    let toolCalls: AccumulatedToolCall[] = [];

    try {
      const stream = getProvider().stream(messages, {
        tools: scoutTools.length > 0 ? scoutTools : undefined,
        toolChoice: 'auto',
        signal,
      });
      for await (const chunk of stream) {
        if (chunk.textDelta) textBuffer += chunk.textDelta;
        if (chunk.done) toolCalls = chunk.toolCallsSnapshot ?? [];
      }
    } catch (err) {
      // 侦查失败不阻塞任务——回退到无侦查报告的 LLM 规划或启发式
      return null;
    }

    if (signal.aborted) return null;

    // LLM 已收集足够信息，输出最终报告
    if (toolCalls.length === 0) {
      const report = parseScoutReport(textBuffer, rounds + 1, Date.now() - startedAt);
      return report;
    }

    // 添加 assistant 消息
    const assistantMsg = makeAssistantWithToolCalls(textBuffer, '', toolCalls);
    messages.push(assistantMsg);

    // 执行工具（safe 工具，无需审批）
    for (const tc of toolCalls) {
      if (signal.aborted) return null;
      const name = tc.function.name;

      // 侦查阶段只允许 safe scout 工具
      if (!SCOUT_TOOL_NAMES.has(name)) {
        messages.push(makeToolResult(tc.id, { error: `侦查阶段不允许使用工具：${name}` }));
        continue;
      }

      let args: Record<string, unknown>;
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        messages.push(makeToolResult(tc.id, { error: `工具参数不是合法 JSON` }));
        continue;
      }

      try {
        const result = await toolRegistry.invoke(
          { id: tc.id, toolName: name, args },
          { taskId: undefined, workspaceDir, abortSignal: signal },
        );
        messages.push(
          makeToolResult(tc.id, result.ok ? result.output : { error: result.error }),
        );
      } catch (err) {
        messages.push(
          makeToolResult(tc.id, {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }

  // 达到最大轮次：用最后一轮的文本解析报告
  const report = parseScoutReport(
    messages.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n'),
    rounds,
    Date.now() - startedAt,
  );
  return report;
}

/** 从 LLM 文本输出中解析 ScoutReport。解析失败返回降级报告。 */
function parseScoutReport(text: string, rounds: number, durationMs: number): ScoutReport {
  try {
    // 尝试提取 JSON 块
    const jsonMatch = text.match(/\{[\s\S]*"keyFiles"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        keyFiles: Array.isArray(parsed.keyFiles)
          ? parsed.keyFiles.map((f: unknown) => {
              if (typeof f === 'object' && f !== null) {
                const obj = f as Record<string, unknown>;
                return {
                  path: String(obj.path ?? ''),
                  reason: String(obj.reason ?? ''),
                };
              }
              return { path: String(f), reason: '' };
            })
          : [],
        techStack: Array.isArray(parsed.techStack)
          ? (parsed.techStack as unknown[]).filter((item: unknown): item is string => typeof item === 'string')
          : undefined,
        constraints: Array.isArray(parsed.constraints)
          ? parsed.constraints.map(String)
          : [],
        summary: typeof parsed.summary === 'string' ? parsed.summary : text.slice(0, 500),
        durationMs,
        rounds,
      };
    }
  } catch {
    // JSON 解析失败，从自由文本提取
  }

  // 降级：从自由文本里提取关键信息
  const lines = text.split('\n').filter(Boolean);
  const keyFiles: Array<{ path: string; reason: string }> = [];
  const constraints: string[] = [];
  for (const line of lines) {
    const trimmed = line.replace(/^[-*#\s]+/, '').trim();
    if (/\.(ts|js|json|md|py|yaml|yml|toml|cfg|ini|env|css|html)$/i.test(trimmed)) {
      keyFiles.push({ path: trimmed.split(/\s+/)[0], reason: '' });
    }
    if (/(需要|注意|约束|限制|边界|小心|不能|禁止|必须)/.test(trimmed)) {
      constraints.push(trimmed.slice(0, 200));
    }
  }

  return {
    keyFiles: keyFiles.slice(0, 20),
    constraints: constraints.slice(0, 10),
    summary: text.slice(0, 500),
    durationMs,
    rounds,
  };
}

// ---- LLM 规划生成（P1）----

/**
 * 用 LLM 根据侦查报告生成结构化执行计划。
 * 要求 LLM 输出 JSON 格式的 GeneratedPlan。
 * 失败返回 null → 调用方回退到启发式计划。
 */
async function generatePlanViaLLM(
  goal: string,
  scoutReport: ScoutReport,
  signal: AbortSignal,
): Promise<GeneratedPlan | null> {
  const keyFilesStr = scoutReport.keyFiles
    .map((f) => `- ${f.path}${f.reason ? ` (${f.reason})` : ''}`)
    .join('\n');
  const constraintsStr = scoutReport.constraints.length > 0
    ? scoutReport.constraints.map((c) => `- ${c}`).join('\n')
    : '（无特殊约束）';

  const planMessages: Message[] = [
    {
      id: randomUUID(),
      role: 'system',
      content:
        '你是 Aurevoy 的任务规划器。根据用户目标和侦查报告，将任务分解为 2-8 个有序执行步骤。\n\n' +
        '输出要求：\n' +
        '- 严格输出 JSON，不要加任何前缀或后缀文字\n' +
        '- 每个步骤描述清晰、可独立验证\n' +
        '- 如果步骤之间有依赖关系，在 dependsOn 中注明前置步骤序号（1-based）\n' +
        '- 如果步骤预期产生可预览产物，标记 verifiable=true\n\n' +
        'JSON 格式：\n' +
        '{\n' +
        '  "steps": [\n' +
        '    {\n' +
        '      "description": "步骤描述",\n' +
        '      "toolsExpected": ["tool_name"],\n' +
        '      "verifiable": true,\n' +
        '      "dependsOn": []\n' +
        '    }\n' +
        '  ],\n' +
        '  "estimatedIterations": 5,\n' +
        '  "riskLevel": "low"\n' +
        '}',
      createdAt: new Date().toISOString(),
    },
    {
      id: randomUUID(),
      role: 'user',
      content:
        `用户目标：${goal}\n\n` +
        `侦查报告：\n${scoutReport.summary}\n\n` +
        `关键文件：\n${keyFilesStr}\n\n` +
        `约束条件：\n${constraintsStr}\n\n` +
        `技术栈：${scoutReport.techStack?.join(', ') ?? '未识别'}\n\n` +
        `请输出 JSON 格式的执行计划。`,
      createdAt: new Date().toISOString(),
    },
  ];

  try {
    let textBuffer = '';
    const stream = getProvider().stream(planMessages, {
      toolChoice: 'none',
      signal,
      temperature: 0.3, // 规划用低温度，追求一致
    });
    for await (const chunk of stream) {
      if (chunk.textDelta) textBuffer += chunk.textDelta;
    }

    if (signal.aborted || !textBuffer.trim()) return null;

    // 从 LLM 输出中提取 JSON
    const jsonMatch = textBuffer.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.steps || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      return null;
    }

    const steps = parsed.steps.slice(0, 8).map((step: unknown) => {
      if (typeof step !== 'object' || step === null) return null;
      const s = step as Record<string, unknown>;
      return {
        description: typeof s.description === 'string' ? s.description : String(s.description ?? ''),
        toolsExpected: Array.isArray(s.toolsExpected)
          ? s.toolsExpected.filter((item): item is string => typeof item === 'string')
          : undefined,
        verifiable: typeof s.verifiable === 'boolean' ? s.verifiable : undefined,
        dependsOn: Array.isArray(s.dependsOn)
          ? s.dependsOn.map(String)
          : undefined,
      };
    }).filter(Boolean) as GeneratedPlan['steps'];

    if (steps.length === 0) return null;

    return {
      steps,
      estimatedIterations:
        typeof parsed.estimatedIterations === 'number' && parsed.estimatedIterations > 0
          ? Math.min(parsed.estimatedIterations, 50)
          : steps.length * 3,
      riskLevel:
        parsed.riskLevel === 'low' || parsed.riskLevel === 'medium' || parsed.riskLevel === 'high'
          ? parsed.riskLevel
          : 'medium',
    };
  } catch {
    return null;
  }
}

/** P1 保留：正则启发式计划作为 LLM 规划失败时的兜底。 */
function inferStructuredPlan(goal: string): string[] {
  const text = goal.toLowerCase();
  const steps: string[] = [];
  if (/(整理|总结|summary|report|材料|资料|文件|docs?|markdown|md|todo|搜索|search)/i.test(goal)) {
    steps.push('扫描工作区材料');
    steps.push('阅读与提取关键信息');
  }
  if (/(网页|url|http|fetch|抓取|网站|页面)/i.test(goal)) {
    steps.push('抓取并清洗网页来源');
    steps.push('提取网页正文与链接');
  }
  if (/(运行|执行|命令|typecheck|build|test|npm|脚本|command)/i.test(goal)) {
    steps.push('确认命令执行边界');
    steps.push('运行命令并收集输出');
  }
  if (/(生成|写入|保存|artifact|报告|summary|markdown|md|翻译|输出)/i.test(goal)) {
    steps.push('生成可预览产物');
    steps.push('确认后保存结果');
  }
  const unique = [...new Set(steps)];
  if (unique.length < 2 || !text.trim()) return [];
  unique.push('汇总结果并说明后续建议');
  return unique.slice(0, 6);
}

function resumePlanFromCheckpoint(plan: PlanStep[], checkpointStepId?: string): PlanStep[] {
  if (plan.length === 0) return plan;
  if (!checkpointStepId) {
    return plan.map((step, index) => ({
      ...step,
      status: step.status === 'completed' ? 'completed' : index === 0 ? 'running' : 'pending',
    }));
  }
  const checkpointIndex = plan.findIndex((step) => step.id === checkpointStepId);
  return plan.map((step, index) => {
    if (index <= checkpointIndex) return { ...step, status: 'completed' };
    return { ...step, status: index === checkpointIndex + 1 ? 'running' : 'pending' };
  });
}

function finishCompleted(
  task: Task,
  updateStep: (d: string, s: PlanStep['status']) => void,
  touch: () => void,
): void {
  task.status = 'completed';
  task.phase = 'finalizing';
  task.plan = task.plan.map((step) =>
    step.status === 'completed' ? step : { ...step, status: 'completed' },
  );
  updateStep('任务完成', 'completed');
  touch();
  writeTrace(task.id, 'done', 'finalizing', { ok: true, summary: '任务完成' });
  taskEvents.publish({ type: 'status', taskId: task.id, status: 'completed' });
  taskEvents.publish({ type: 'phase', taskId: task.id, phase: 'finalizing', detail: '任务完成' });
  taskEvents.publish({ type: 'done', taskId: task.id, status: 'completed' });
}

function finishCancelled(
  task: Task,
  updateStep: (d: string, s: PlanStep['status']) => void,
  touch: () => void,
): void {
  task.status = 'cancelled';
  task.phase = 'cancelled';
  task.plan = task.plan.map((step) =>
    step.status === 'completed' ? step : { ...step, status: 'cancelled' },
  );
  updateStep('任务已取消', 'cancelled');
  touch();
  writeTrace(task.id, 'done', 'cancelled', {
    ok: false,
    errorCategory: 'cancelled',
    summary: '任务已取消',
  });
  taskEvents.publish({ type: 'status', taskId: task.id, status: 'cancelled' });
  taskEvents.publish({ type: 'phase', taskId: task.id, phase: 'cancelled', detail: '用户取消任务' });
  taskEvents.publish({ type: 'done', taskId: task.id, status: 'cancelled' });
}

type TracePatch = Partial<
  Pick<
    TaskTraceEntry,
    | 'iteration'
    | 'callId'
    | 'toolName'
    | 'riskLevel'
    | 'finishReason'
    | 'ok'
    | 'errorCategory'
    | 'errorMessage'
    | 'summary'
    | 'data'
    | 'tokenUsage'
  >
> & {
  startedAtMs?: number;
};

function writeTrace(
  taskId: string,
  kind: TaskTraceEntry['kind'],
  phase: TaskPhase | null,
  patch: TracePatch = {},
): void {
  const taskLog = createTaskLogger(taskId);
  const endedAtMs = Date.now();
  const startedAtMs = patch.startedAtMs ?? endedAtMs;
  taskLog.trace(kind, phase, {
    iteration: patch.iteration,
    callId: patch.callId,
    toolName: patch.toolName,
    riskLevel: patch.riskLevel,
    finishReason: patch.finishReason,
    tokenUsage: patch.tokenUsage ?? null,
    startedAtMs,
    ok: patch.ok,
    errorCategory: patch.errorCategory,
    errorMessage: patch.errorMessage,
    summary: patch.summary,
    data: patch.data,
  });
}

function handleToolSideEffects(task: Task, call: ToolCall, result: ToolResult): ToolResult {
  if (!result.ok) return result;
  if (call.toolName === 'create_artifact') {
    const draft = extractArtifactDraft(result.output);
    if (!draft) {
      return { callId: call.id, ok: false, error: 'create_artifact 返回格式非法' };
    }
    const artifact = createArtifact({
      ...draft,
      sourceCallId: call.id,
    });
    task.artifacts = [...(task.artifacts ?? []), artifact];
    taskEvents.publish({ type: 'artifact_created', taskId: task.id, artifact });
    return { callId: call.id, ok: true, output: { artifact } };
  }
  if (call.toolName === 'apply_artifact') {
    const output = result.output as { artifactId?: unknown; path?: unknown } | undefined;
    const artifactId = typeof output?.artifactId === 'string' ? output.artifactId : undefined;
    const path = typeof output?.path === 'string' ? output.path : undefined;
    if (artifactId && path) {
      const artifact = markArtifactApplied(task, artifactId, path);
      if (artifact) taskEvents.publish({ type: 'artifact_updated', taskId: task.id, artifact });
    }
  }
  return result;
}

function extractArtifactDraft(output: unknown):
  | { name: string; content: string; type?: TaskArtifact['type']; mimeType?: string }
  | null {
  if (!output || typeof output !== 'object') return null;
  const draft = (output as { artifactDraft?: unknown }).artifactDraft;
  if (!draft || typeof draft !== 'object') return null;
  const record = draft as Record<string, unknown>;
  if (typeof record.name !== 'string' || typeof record.content !== 'string') return null;
  const type =
    record.type === 'file' || record.type === 'diff' || record.type === 'url' || record.type === 'text'
      ? record.type
      : undefined;
  return {
    name: record.name,
    content: record.content,
    type,
    mimeType: typeof record.mimeType === 'string' ? record.mimeType : undefined,
  };
}

function writeToolCallTrace(
  taskId: string,
  call: ToolCall,
  riskLevel: ToolRiskLevel,
  iteration: number,
): void {
  writeTrace(taskId, 'tool_call', 'calling_tool', {
    iteration,
    callId: call.id,
    toolName: call.toolName,
    riskLevel,
    ok: true,
    summary: `请求工具：${call.toolName}`,
    data: { args: summarizePayload(call.args) },
  });
}

function writeApprovalTrace(
  taskId: string,
  call: ToolCall,
  riskLevel: ToolRiskLevel,
  approved: boolean,
  iteration: number,
): void {
  writeTrace(taskId, 'approval', 'waiting_approval', {
    iteration,
    callId: call.id,
    toolName: call.toolName,
    riskLevel,
    ok: approved,
    errorCategory: approved ? undefined : 'permission',
    errorMessage: approved ? undefined : '用户拒绝或审批超时',
    summary: approved ? `审批通过：${call.toolName}` : `审批未通过：${call.toolName}`,
  });
}

function classifyError(err: unknown): TaskErrorCategory {
  if (err instanceof BudgetExceededError) return 'timeout';
  const name = (err as { name?: string })?.name;
  const status = (err as { status?: number })?.status;
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'AbortError') return 'cancelled';
  if (name === 'TimeoutError' || /timeout|timed out|超时/i.test(message)) return 'timeout';
  if (/未配置|Provider|API Key|配置/i.test(message)) return 'configuration';
  if (/JSON|parse|解析/i.test(message)) return 'parse';
  if (typeof status === 'number') return status >= 400 && status < 500 ? 'configuration' : 'model';
  if (/工具|tool/i.test(message)) return 'tool';
  return 'unknown';
}

function summarizePayload(value: unknown): unknown {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text || text.length <= 1200) return value;
  return {
    truncated: true,
    chars: text.length,
    preview: text.slice(0, 1200),
  };
}

function estimatePayloadBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value);
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null));
  } catch {
    return Buffer.byteLength(String(value));
  }
}

function makeAssistant(content: string, reasoningContent: string): Message {
  const msg: Message = {
    id: randomUUID(),
    role: 'assistant',
    content,
    createdAt: new Date().toISOString(),
  };
  if (reasoningContent) msg.reasoningContent = reasoningContent;
  return msg;
}

function makeAssistantWithToolCalls(
  content: string,
  reasoningContent: string,
  toolCalls: AccumulatedToolCall[],
): Message {
  const msg = makeAssistant(content, reasoningContent);
  msg.toolCalls = toolCalls.map(
    (tc): MessageToolCall => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }),
  );
  return msg;
}

function makeToolResult(toolCallId: string, payload: unknown): Message {
  return {
    id: randomUUID(),
    role: 'tool',
    content: JSON.stringify(payload ?? null),
    toolCallId,
    createdAt: new Date().toISOString(),
  };
}

function patchDanglingToolResults(messages: Message[]): number {
  let patched = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue;

    const existing = new Set<string>();
    let insertAt = i + 1;
    while (insertAt < messages.length && messages[insertAt].role === 'tool') {
      const toolCallId = messages[insertAt].toolCallId;
      if (toolCallId) existing.add(toolCallId);
      insertAt += 1;
    }

    const missing = message.toolCalls.filter((toolCall) => !existing.has(toolCall.id));
    if (missing.length === 0) continue;

    const results = missing.map((toolCall) =>
      makeToolResult(toolCall.id, {
        error: '上次执行在该工具返回前中断；恢复任务时已关闭这次悬空工具调用，请重新规划或改用其他方式。',
      }),
    );
    messages.splice(insertAt, 0, ...results);
    patched += results.length;
    i = insertAt + results.length - 1;
  }
  return patched;
}
