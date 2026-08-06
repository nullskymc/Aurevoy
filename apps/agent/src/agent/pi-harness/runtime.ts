import { promises as fs } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AgentHarness,
  type AgentEvent as PiAgentEvent,
  type AgentHarnessOwnEvent,
  type AgentMessage,
  type AgentTool,
  type Skill as PiHarnessSkill,
} from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import {
  type AssistantMessageEvent as PiAssistantMessageEvent,
  type AssistantMessage as PiAssistantMessage,
  type ImageContent as PiImageContent,
  type Message as PiMessage,
  type Model as PiModel,
  type TextContent as PiTextContent,
  type ToolResultMessage as PiToolResultMessage,
  type Usage as PiUsage,
} from '@earendil-works/pi-ai/compat';
import type {
  AgentEvent,
  AggregatedTokenUsage,
  BudgetExceededInfo,
  ContentBlock,
  Message,
  MessageAttachment,
  MessageToolCall,
  Task,
  TaskErrorCategory,
  TaskPhase,
  TaskFileChange,
  TaskFileChangeOperation,
  TaskStatus,
  TaskTraceKind,
  ToolCall,
  ToolResult,
  AgentCacheRetention,
  AgentThinkingLevel,
  AgentToolExecutionMode,
  PendingQueueItem,
  TaskModelSnapshot,
  TaskRecallSummary,
  RecallSourceStatus,
} from '@aurevoy/shared';
import { classifyTaskError } from '../task-error-category.js';
import { config } from '../../config.js';
import { taskEvents } from '../events.js';
import { createTaskLogger } from '../../logging/trace.js';
import { taskStore, projectStore, memoryStore } from '../../store/db.js';
import { unifiedToolRegistry, validateToolInputSchema } from '../../tool/unified-registry.js';
import { initializeUnifiedToolFramework, getAgentToolsForPi, createToolContext } from '../../tool/index.js';
import { artifactTargetExists, writeArtifactToWorkspace } from '../../tool/tools/artifact/index.js';
import {
  buildMemorySystemMessage,
  buildStableSystemPromptParts,
  buildVolatileTimeContextMessage,
  joinSystemPromptParts,
  totalTokens,
} from '../context.js';
import { buildImplicitRecallPrompt as composeImplicitRecallPrompt } from './implicit-recall.js';
import { createInlineAutoCompactor, summarizePiMessages } from './auto-compaction.js';
import { ActivePiTaskController } from './active-controller.js';
import { createAurevoyPiModels } from './models.js';
import { buildScoutReport } from './scout.js';
import {
  openPiSessionTree,
  type PiSessionSeedMessage,
  type PiSessionTreeHandle,
} from './session-tree.js';
import { planModeToolBlockReason } from './tool-policy.js';
import { mergeDurableTaskMessages } from './durable-message-merge.js';
export { mergeDurableTaskMessages } from './durable-message-merge.js';
import {
  createProviderHostedCallMessage,
  createProviderHostedResultMessage,
} from './provider-hosted-messages.js';
import { buildToolCallSummary } from '../tool-call-summary.js';
import { materializeMcpBrowserContentBlocks } from './mcp-browser-artifacts.js';
import {
  beginRunBudget,
  createArtifact,
  createCheckpoint,
  createClarification,
  effectiveBudget,
  effectiveLifetimeBudget,
  evaluateBudgetStop,
  finalizeRunWallTime,
  initialBudgetUsage,
  markArtifactApplied,
  recordIteration,
  recordOutputBytes,
  recordToolCall,
  resolveClarification,
  updateWallTime,
} from '../m6-state.js';
import { waitForPiApproval } from '../pi-approval.js';
import {
  advancePlanAfterFinalAnswer,
  advancePlanAfterTool,
  completePlanOnSuccess,
  failOpenPlanSteps,
} from '../plan-progress.js';
import {
  buildCompletionGatePrompt,
  buildMaxStepsPrompt,
  buildMaxStepsWrapUpMessage,
  buildResumeProgressInjection,
  decideMaxStepsAfterTurn,
  extractCompletionGateVerdict,
  maxStepsToolsDisabledReason,
  shouldStartCompletionGate,
  stripCompletionGateMarker,
  type CompletionGateVerdict,
} from '../control-policy.js';
import { assertPiLLMConfigured, createPiModel } from '../../llm/pi-provider.js';
import { approvalConfigFromTask, decideToolPermission } from '../approval.js';
import { skillRegistry } from '../../skills/registry.js';
import { scheduleTaskTitleRefine } from '../task-title.js';

interface PiHarnessOptions {
  workspaceDir: string;
  signal: AbortSignal;
  taskStartedAtMs: number;
}

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
]);
const MAX_ATTACHMENT_CONTENT_CHARS = 30_000;
const MAX_ARTIFACT_CONTENT_CHARS = 1_000_000;
const activePiControllers = new Map<string, ActivePiTaskController>();
/** 单任务 provider 请求起点；Pi 主循环同一任务内串行请求。 */
const providerRequestStartedAtByTask = new Map<string, number>();
const pendingClarificationResolvers = new Map<string, Map<string, (answer: string) => void>>();
/** 本 run 因预算触顶而中止时暂存详情；harness.prompt 返回后转 waiting_budget。 */
const budgetStopByTask = new Map<string, BudgetExceededInfo>();
/**
 * OpenCode-style max-steps wrap-up:
 * - pending: tools disabled; follow-up max-steps prompt in flight
 * - done: wrap-up turn finished; safe to pause budget
 */
const maxStepsWrapUpPending = new Set<string>();
const maxStepsWrapUpDone = new Set<string>();
/** 本 run 已追加过一次完成审计；禁止递归验收。 */
const completionGateRequested = new Set<string>();
/** 当前 provider turn 是否实际执行过工具，用于识别候选终稿。 */
const completionGateTurnHadToolCall = new Set<string>();
/** 从内部完成标记解析出的审计结论；结束 run 前消费。 */
const completionGateVerdictByTask = new Map<string, CompletionGateVerdict>();
/** 本 run 开始时已累计的寿命墙钟，用于叠加上本 run 墙钟。 */
const lifetimeWallAtRunStartByTask = new Map<string, number>();
const invalidPiToolCallErrors = new Map<string, Map<string, string>>();

/**
 * 每个任务 run 内冻结的完整 system prompt（稳定前缀 + 一次时间）。
 * 本 run 内字节不变，避免分钟跳动/附件重读冲掉整段对话 prompt cache。
 * 文本附件改挂到对应 user 消息，不再进 system。
 */
const pinnedSystemPromptByTask = new Map<string, string>();
/** toolcall 流式准备阶段 phase 节流（taskId → 上次推送时刻 / 文案） */
const lastPrepPhaseAtByTask = new Map<string, number>();
const lastPrepPhaseDetailByTask = new Map<string, string>();
const hostedToolStartedAtByCall = new Map<string, {
  taskId: string;
  startedAtMs: number;
  toolName: string;
}>();
const SEARCH_FILES_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '要搜索的关键词或 grep 正则表达式' },
    glob: { type: 'string', description: '文件名 glob 过滤，例如 **/*.md' },
    path: { type: 'string', description: '搜索起始目录（相对工作区根），缺省为工作区根目录' },
    maxResults: { type: 'integer', description: '最多返回结果数，默认 50，上限 100' },
  },
  required: ['query'],
  additionalProperties: false,
} as const;

export function steerPiHarnessTask(taskId: string, message: Message): Promise<boolean> {
  const controller = activePiControllers.get(taskId);
  if (!controller) return Promise.resolve(false);
  return controller.enqueueSteering(message);
}

/** 取运行中任务的内存控制器（用于即时换模型/推理档）；无运行中 run 返回 undefined。 */
export function getActivePiTaskController(taskId: string): ActivePiTaskController | undefined {
  return activePiControllers.get(taskId);
}

/** 撤回仍在 Pi 注入队列中的消息；已进入模型上下文的消息不会被改写。 */
export async function clearPiHarnessTaskQueue(
  taskId: string,
  kind: 'steering' | 'follow_up' | 'all',
): Promise<boolean> {
  return await activePiControllers.get(taskId)?.clearQueue(kind) ?? false;
}

export function followUpPiHarnessTask(taskId: string, message: Message): Promise<boolean> {
  const controller = activePiControllers.get(taskId);
  if (!controller) return Promise.resolve(false);
  return controller.enqueueFollowUp(message);
}

export function resolvePiHarnessClarificationAnswer(taskId: string, clarificationId: string, answer: string): boolean {
  const byTask = pendingClarificationResolvers.get(taskId);
  const resolve = byTask?.get(clarificationId);
  if (!resolve) return false;
  byTask!.delete(clarificationId);
  if (byTask!.size === 0) pendingClarificationResolvers.delete(taskId);
  resolve(answer);
  return true;
}

/**
 * 手动 /compact 的 LLM 摘要：把本地消息映射为 Pi 消息后走与自动压缩同一
 * generateSummary。返回 null 表示摘要失败，调用方须显式降级（不可用截断冒充摘要）。
 */
export async function summarizeTaskMessagesWithPi(
  task: Task,
  messages: Message[],
  instructions?: string,
): Promise<string | null> {
  if (messages.length === 0) return null;
  assertPiLLMConfigured();
  const model = selectPiModelForTask(task);
  const toolNamesByCallId = buildToolNamesByCallId(messages);
  const piMessages: AgentMessage[] = [];
  for (const message of messages) {
    const converted = await toPiMessage(message, toolNamesByCallId, model);
    piMessages.push(...(converted as AgentMessage[]));
  }
  if (piMessages.length === 0) return null;
  return await summarizePiMessages(piMessages, createAurevoyPiModels(model), model, undefined, instructions);
}

export async function runPiHarnessTask(task: Task, options: PiHarnessOptions): Promise<void> {
  task.pendingApprovals = [];
  const { lifetimeWallAtRunStart } = beginRunBudget(task);
  lifetimeWallAtRunStartByTask.set(task.id, lifetimeWallAtRunStart);
  budgetStopByTask.delete(task.id);
  maxStepsWrapUpPending.delete(task.id);
  maxStepsWrapUpDone.delete(task.id);
  completionGateRequested.delete(task.id);
  completionGateTurnHadToolCall.delete(task.id);
  completionGateVerdictByTask.delete(task.id);
  setTaskState(task, 'running', 'initializing');
  updateContextSnapshot(task);
  saveTask(task);
  publish({ type: 'status', taskId: task.id, status: 'running' });
  publish({ type: 'phase', taskId: task.id, phase: 'initializing', detail: '准备 Pi harness' });
  publishBudgetUsage(task);
  publish({ type: 'context_snapshot', taskId: task.id, tokens: task.contextTokens ?? 0 });
  await publishScoutReport(task, options.workspaceDir);

  try {
    assertPiLLMConfigured();
    stickTaskModelSnapshot(task);
    const selectedModel = selectPiModelForTask(task);
    assertPiModelSupportsAttachments(task, selectedModel);
    const controller = new ActivePiTaskController(
      async (message) => await toHarnessPromptInput(message, selectPiModelForTask(task)),
    );
    const { harness, sessionTree } = await createPiHarness(task, options, selectedModel, controller);

    publish({ type: 'phase', taskId: task.id, phase: 'thinking', detail: 'Agent 正在思考' });
    activePiControllers.set(task.id, controller);
    const onAbort = () => controller.abort();
    options.signal.addEventListener('abort', onAbort, { once: true });
    let completionGateWasRequested = false;
    let completionGateVerdict: CompletionGateVerdict | undefined;
    try {
      if (options.signal.aborted) throw new Error('cancelled');
      const promptInput = await buildHarnessRunInput(task, selectedModel, sessionTree);
      await harness.prompt(
        promptInput.text,
        promptInput.images.length > 0 ? { images: promptInput.images } : undefined,
      );
    } finally {
      await persistPiSessionTreeSafe(task, sessionTree);
      options.signal.removeEventListener('abort', onAbort);
      activePiControllers.delete(task.id);
      providerRequestStartedAtByTask.delete(task.id);
      invalidPiToolCallErrors.delete(task.id);
      pinnedSystemPromptByTask.delete(task.id);
      lastPrepPhaseAtByTask.delete(task.id);
      lastPrepPhaseDetailByTask.delete(task.id);
      for (const [key, hosted] of hostedToolStartedAtByCall) {
        if (hosted.taskId === task.id) hostedToolStartedAtByCall.delete(key);
      }
      maxStepsWrapUpPending.delete(task.id);
      maxStepsWrapUpDone.delete(task.id);
      completionGateWasRequested = completionGateRequested.has(task.id);
      completionGateVerdict = completionGateVerdictByTask.get(task.id);
      completionGateRequested.delete(task.id);
      completionGateTurnHadToolCall.delete(task.id);
      completionGateVerdictByTask.delete(task.id);
      const wallStart = lifetimeWallAtRunStartByTask.get(task.id) ?? 0;
      finalizeRunWallTime(task, wallStart, options.taskStartedAtMs);
      lifetimeWallAtRunStartByTask.delete(task.id);
    }

    if (options.signal.aborted) {
      finishCancelled(task);
      return;
    }
    const budgetStop = budgetStopByTask.get(task.id);
    if (budgetStop) {
      budgetStopByTask.delete(task.id);
      finishBudgetPaused(task, budgetStop);
      return;
    }
    const terminalModelFailure = [...task.messages]
      .reverse()
      .find((message) => message.role === 'assistant')?.failure;
    if (terminalModelFailure) {
      finishFailed(
        task,
        new Error(terminalModelFailure.message),
        terminalModelFailure.category,
        true,
      );
      return;
    }
    if (completionGateWasRequested && completionGateVerdict !== 'complete') {
      finishCompletionPaused(task, completionGateVerdict ?? null);
      return;
    }
    finishCompleted(task);
  } catch (err) {
    if (options.signal.aborted) {
      finishCancelled(task);
      return;
    }
    const budgetStop = budgetStopByTask.get(task.id);
    if (budgetStop) {
      budgetStopByTask.delete(task.id);
      finishBudgetPaused(task, budgetStop);
      return;
    }
    finishFailed(task, err, classifyTaskError(err));
  }
}

async function createPiHarness(
  task: Task,
  options: PiHarnessOptions,
  selectedModel: PiModel<any>,
  controller: ActivePiTaskController,
): Promise<{ harness: AgentHarness; sessionTree: PiSessionTreeHandle }> {
  const seedMessages = await buildHarnessSeedMessages(task, selectedModel);
  const sessionTree = openPiSessionTree(task, seedMessages);
  const session = sessionTree.session;

  const piModels = createAurevoyPiModels(selectedModel);
  const harness = new AgentHarness({
    session,
    models: piModels,
    tools: createPiTools(task, options),
    resources: { skills: createHarnessSkills() },
    systemPrompt: async () => await buildPiSystemPrompt(task, options.workspaceDir),
    model: selectedModel,
    thinkingLevel: taskThinkingLevel(task),
    steeringMode: 'one-at-a-time',
    followUpMode: 'one-at-a-time',
    streamOptions: {
      maxRetries: 2,
      maxRetryDelayMs: 60_000,
      cacheRetention: runtimeCacheRetention(),
    },
  });

  controller.attach(harness);
  harness.subscribe(async (event) => {
    if (event.type === 'save_point' || event.type === 'settled') {
      await persistPiSessionTreeSafe(task, sessionTree);
    }
    if (isPiAgentEvent(event)) {
      await handlePiEvent(task, event, options.signal, options.taskStartedAtMs, options.workspaceDir, controller);
      return;
    }
    await handlePiOwnEvent(task, event, options);
  });
  // 阈值触发的内联 LLM 自动压缩：会话存原文，只在发给 provider 的上下文里折叠较早历史。
  // 压缩失败自动退回确定性 Snip+Microcompact（auto-compaction.ts 内部收尾），绝不注入错误摘要。
  const compactor = createInlineAutoCompactor({
    models: piModels,
    model: selectedModel,
    signal: options.signal,
    onCompacted: (info) => {
      writePiTrace(task, 'phase', {
        ok: true,
        phase: task.phase,
        summary: `上下文自动压缩：折叠较早 ${info.summarizedCount} 条消息，${info.tokensBefore}→${info.tokensAfter} tokens`,
      });
      publish({
        type: 'compacted',
        taskId: task.id,
        originalCount: info.summarizedCount,
        summaryLength: info.summary.length,
        summary: info.summary,
        tokensBefore: info.tokensBefore,
        tokensAfter: info.tokensAfter,
        automatic: true,
      });
    },
    trace: (summary, data) =>
      writePiTrace(task, 'error', {
        ok: false,
        phase: task.phase,
        errorCategory: 'model',
        errorMessage: summary,
        summary,
        data,
      }),
  });
  harness.on('context', async (event) => {
    const filtered = event.messages.filter((message): message is PiMessage =>
      message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult',
    );
    const messages = await compactor.apply(filtered as AgentMessage[]);
    return { messages };
  });
  harness.on('tool_call', async (event) => {
    const call = toAurevoyToolCall(task, event.toolCallId, event.toolName, event.input);
    return await gatePiToolCall(task, call, options.signal);
  });
  return { harness, sessionTree };
}

/** 会话树是增强恢复能力；快照写入失败不能覆盖主 Task/消息的既有持久化语义。 */
async function persistPiSessionTreeSafe(
  task: Task,
  sessionTree: PiSessionTreeHandle,
): Promise<void> {
  try {
    await sessionTree.persist(task);
  } catch (error) {
    writePiTrace(task, 'error', {
      ok: false,
      phase: task.phase,
      errorCategory: 'unknown',
      errorMessage: error instanceof Error ? error.message : String(error),
      summary: 'Pi 会话树快照写入失败，任务消息仍按原持久化链路保存',
    });
  }
}

function isPiAgentEvent(event: { type: string }): event is PiAgentEvent {
  return (
    event.type === 'agent_start' ||
    event.type === 'agent_end' ||
    event.type === 'turn_start' ||
    event.type === 'turn_end' ||
    event.type === 'message_start' ||
    event.type === 'message_update' ||
    event.type === 'message_end' ||
    event.type === 'tool_execution_start' ||
    event.type === 'tool_execution_update' ||
    event.type === 'tool_execution_end'
  );
}

async function buildHarnessSeedMessages(task: Task, model: PiModel<any>): Promise<PiSessionSeedMessage[]> {
  const promptIndex = findHarnessPromptMessageIndex(task.messages);
  const seedSource = promptIndex >= 0 ? task.messages.slice(0, promptIndex) : task.messages;
  const toolNamesByCallId = buildToolNamesByCallId(seedSource);
  const seedMessages: PiSessionSeedMessage[] = [];
  for (const message of seedSource) {
    const converted = await toPiMessage(message, toolNamesByCallId, model);
    for (const piMessage of converted) {
      seedMessages.push({
        sourceMessageId: message.id,
        message: piMessage,
      });
    }
  }
  return seedMessages;
}

async function buildHarnessRunInput(
  task: Task,
  model: PiModel<any>,
  sessionTree: PiSessionTreeHandle,
): Promise<{ text: string; images: PiImageContent[] }> {
  const promptIndex = findHarnessPromptMessageIndex(task.messages);
  const promptMessage = promptIndex >= 0 ? task.messages[promptIndex] : undefined;
  const progress = buildResumeProgressInjection(task);
  const hasNewMessageAfterSnapshot =
    !sessionTree.reusedSnapshot ||
    task.messages.length > sessionTree.persistedMessageCount;
  if (sessionTree.reusedSnapshot && !hasNewMessageAfterSnapshot) {
    const base = 'Continue the task from the current session-tree leaf without repeating completed work.';
    return { text: progress ? `${progress}\n\n${base}` : base, images: [] };
  }
  if (!promptMessage || promptMessage.role !== 'user') {
    const base = 'Continue the task from the existing conversation state.';
    return { text: progress ? `${progress}\n\n${base}` : base, images: [] };
  }
  const input = await toHarnessPromptInput(promptMessage, model);
  if (!progress) return input;
  // Volatile injection on the user turn only — does not rewrite stable system prefix (prompt cache).
  return { text: `${progress}\n\n${input.text}`, images: input.images };
}

function findHarnessPromptMessageIndex(messages: Message[]): number {
  // 只有尾部 user 才是本轮新输入。恢复任务通常以悬空 assistant/tool 结尾，
  // 此时完整历史都应进入 seed，并用 continuation prompt 续跑。
  return messages.at(-1)?.role === 'user' ? messages.length - 1 : -1;
}

async function toHarnessPromptInput(message: Message, model: PiModel<any>): Promise<{ text: string; images: PiImageContent[] }> {
  const images: PiImageContent[] = [];
  for (const image of message.imageParts ?? []) {
    if (!model.input?.includes('image')) {
      throw new Error(`模型 ${model.provider}:${model.id} 不支持图片消息：${image.name}`);
    }
    images.push(imagePartToPiContent(image));
  }
  return { text: await buildUserMessageTextWithAttachments(message), images };
}

function createHarnessSkills(): PiHarnessSkill[] {
  return skillRegistry.listAll()
    .filter((skill) => skill.enabled)
    .flatMap((descriptor): PiHarnessSkill[] => {
      const entry = skillRegistry.get(descriptor.name);
      const content = skillRegistry.getContent(descriptor.name);
      if (!entry || !content) return [];
      return [{
        name: descriptor.name,
        description: descriptor.description,
        content: content.body,
        filePath: entry.location,
      }];
    });
}

/**
 * After a turn, evaluate budget. OpenCode max-steps path:
 * 1) First hit → tools disabled + enqueue text-only wrap-up follow-up (do not abort yet)
 * 2) After wrap-up turn → abort and pause on waiting_budget
 */
function shouldStopAfterTurn(
  task: Task,
  taskStartedAtMs: number,
  controller: ActivePiTaskController,
): boolean {
  const lifetimeWallAtRunStart = lifetimeWallAtRunStartByTask.get(task.id) ?? 0;
  const info = evaluateBudgetStop(task, taskStartedAtMs, lifetimeWallAtRunStart);
  const decision = decideMaxStepsAfterTurn({
    budgetInfo: info,
    wrapUpPending: maxStepsWrapUpPending.has(task.id),
    wrapUpDone: maxStepsWrapUpDone.has(task.id),
  });

  if (decision.action === 'continue') {
    const shouldAudit = shouldStartCompletionGate({
      executionMode: task.executionMode,
      toolCallsThisRun: task.budgetUsage?.toolCalls ?? 0,
      currentTurnHadToolCall: completionGateTurnHadToolCall.has(task.id),
      alreadyRequested: completionGateRequested.has(task.id),
    });
    if (shouldAudit) {
      completionGateRequested.add(task.id);
      const auditMessage: Message = {
        id: randomUUID(),
        role: 'user',
        content: buildCompletionGatePrompt(),
        createdAt: new Date().toISOString(),
        delivery: 'follow_up',
      };
      writePiTrace(task, 'phase', {
        ok: true,
        phase: task.phase,
        summary: '候选终稿进入一次性完成门禁',
        data: {
          cacheStrategy: 'stable_system_prefix_plus_short_follow_up',
          toolCallsThisRun: task.budgetUsage?.toolCalls ?? 0,
        },
      });
      void controller.enqueueFollowUp(auditMessage);
    }
    return false;
  }

  if (decision.action === 'finish_after_wrap_up') {
    maxStepsWrapUpPending.delete(task.id);
    maxStepsWrapUpDone.add(task.id);
    const stopInfo = decision.info ?? budgetStopByTask.get(task.id) ?? info;
    if (stopInfo) {
      budgetStopByTask.set(task.id, stopInfo);
      task.budgetExceeded = stopInfo;
      saveTask(task);
      publishBudgetUsage(task);
    }
    writePiTrace(task, 'phase', {
      ok: true,
      phase: task.phase,
      errorCategory: 'budget',
      summary: `max-steps wrap-up 完成，准备预算暂停：${stopInfo?.reason ?? 'step limit'}`,
      data: stopInfo ?? { wrapUp: true },
    });
    return true;
  }

  if (decision.action === 'start_wrap_up') {
    const stopInfo = decision.info;
    budgetStopByTask.set(task.id, stopInfo);
    task.budgetExceeded = stopInfo;
    maxStepsWrapUpPending.add(task.id);
    saveTask(task);
    publishBudgetUsage(task);
    writePiTrace(task, 'phase', {
      ok: true,
      phase: task.phase,
      errorCategory: 'budget',
      summary: `步数/预算触顶，进入 text-only wrap-up：${stopInfo.reason}`,
      data: {
        scope: stopInfo.scope,
        limitName: stopInfo.limitName,
        used: stopInfo.used,
        limit: stopInfo.limit,
        wrapUp: true,
      },
    });
    const wrapUpMsg: Message = {
      id: randomUUID(),
      role: 'user',
      content: buildMaxStepsPrompt(task, stopInfo),
      createdAt: new Date().toISOString(),
      delivery: 'follow_up',
    };
    try {
      void controller.enqueueFollowUp(wrapUpMsg);
    } catch {
      maxStepsWrapUpPending.delete(task.id);
      maxStepsWrapUpDone.add(task.id);
      return true;
    }
    return false;
  }

  // stop
  const stopInfo = decision.info;
  budgetStopByTask.set(task.id, stopInfo);
  task.budgetExceeded = stopInfo;
  saveTask(task);
  publishBudgetUsage(task);
  writePiTrace(task, 'phase', {
    ok: true,
    phase: task.phase,
    errorCategory: 'budget',
    summary: `本轮结束后主动停步：${stopInfo.reason}`,
    data: {
      scope: stopInfo.scope,
      limitName: stopInfo.limitName,
      used: stopInfo.used,
      limit: stopInfo.limit,
      runUsage: stopInfo.runUsage,
      lifetimeUsage: stopInfo.lifetimeUsage,
      runBudget: stopInfo.runBudget,
      lifetimeBudget: stopInfo.lifetimeBudget,
    },
  });
  return true;
}

function publishBudgetUsage(task: Task): void {
  publish({
    type: 'budget_usage',
    taskId: task.id,
    usage: task.budgetUsage ?? initialBudgetUsage(),
    budget: effectiveBudget(task),
    lifetimeUsage: task.lifetimeUsage ?? initialBudgetUsage(),
    lifetimeBudget: effectiveLifetimeBudget(task),
  });
}

async function publishScoutReport(task: Task, workspaceDir: string): Promise<void> {
  publish({ type: 'scout_started', taskId: task.id });
  const report = await buildScoutReport(workspaceDir);
  publish({ type: 'scout_report', taskId: task.id, report });
}

async function buildPiSystemPrompt(task: Task, workspaceDir: string): Promise<string> {
  const pinned = pinnedSystemPromptByTask.get(task.id);
  if (pinned) return pinned;

  const projectInfo = task.projectId ? projectStore.get(task.projectId) : undefined;
  const recallPrompt = await buildImplicitRecallPrompt(task);
  // 整段 system 在 run 开始时只拼一次：稳定部件 + 冻结墙钟；后续轮次原样返回。
  const full = joinSystemPromptParts(
    buildStableSystemPromptParts({
      workspaceDir,
      projectInfo: projectInfo ? { name: projectInfo.name, path: projectInfo.path } : undefined,
    }),
    [
      task.executionMode === 'plan'
        ? [
            '## Plan mode',
            'You are the same conversational agent operating with read-only permissions. Answer informational questions normally; Plan mode does not force every answer to become an execution plan.',
            'You may investigate with read/search tools, ask clarifying questions, and discuss or revise a proposal over multiple turns. If a user-requested local-folder scan requires bash, use a strictly read-only command; the system will ask the user to confirm it. Do not modify the workspace or execute side-effecting commands.',
            'Use update_plan only when remaining steps require later side-effecting Agent execution. Do not create a plan card for travel advice, explanations, research answers, or any work fully delivered by your current response.',
            'When a future execution plan is warranted, call update_plan with concrete proposed steps, then explain the proposal. The user can switch the input mode to Agent and ask you to execute it; never tell them to approve a separate plan gate.',
          ].join('\n')
        : [
            '## Agent mode',
            'For genuinely multi-step actionable work, use update_plan to create or refresh the visible plan and keep its statuses aligned with actual progress.',
            'Do not create a plan for simple questions or tasks completed in the current answer.',
          ].join('\n'),
      recallPrompt,
      buildVolatileTimeContextMessage().content,
    ].filter(Boolean),
  );
  pinnedSystemPromptByTask.set(task.id, full);
  return full;
}

/**
 * 在任务 run 起点隐式召回长期记忆与本地知识库。
 * 编排细节由独立模块负责；这里仅把产品配置与轨迹写入适配进去。
 */
async function buildImplicitRecallPrompt(task: Task): Promise<string> {
  const summary: TaskRecallSummary = {
    memory: createRecallSourceSummary(config.agent.memoryRecallEnabled),
    knowledgeBase: createRecallSourceSummary(config.agent.kbRecallEnabled),
    updatedAt: new Date().toISOString(),
  };
  task.recallSummary = summary;
  taskStore.patch(task.id, { recallSummary: summary });
  publish({ type: 'recall_summary', taskId: task.id, summary });

  return composeImplicitRecallPrompt(task, {
    memoryEnabled: config.agent.memoryRecallEnabled,
    kbEnabled: config.agent.kbRecallEnabled,
    memoryRecall: (query) => buildMemorySystemMessage(memoryStore.list(), query),
    kbRecall: async (query, topK) => {
      const { recallKb } = await import('../../knowledge-base/index.js');
      return recallKb(query, topK);
    },
    onSource: ({ source, count, citationCount }) => {
      const nextSummary = updateRecallSourceSummary(
        task,
        source,
        count > 0 || citationCount > 0 ? 'used' : 'empty',
        count,
        citationCount,
      );
      publish({ type: 'recall_summary', taskId: task.id, summary: nextSummary });
      const label = source === 'memory' ? '长期记忆' : '知识库片段';
      writePiTrace(task, 'phase', {
        ok: true,
        phase: task.phase,
        summary: `隐式召回 ${count} 条${label}`,
        data: { source, citationCount },
      });
    },
    onError: ({ source, error }) => {
      const nextSummary = updateRecallSourceSummary(task, source, 'failed', 0, 0);
      publish({ type: 'recall_summary', taskId: task.id, summary: nextSummary });
      const label = source === 'memory' ? '记忆' : '知识库';
      const message = error instanceof Error ? error.message : String(error);
      writePiTrace(task, 'error', {
        ok: false,
        phase: task.phase,
        errorCategory: 'unknown',
        errorMessage: message,
        summary: `隐式${label}召回失败，已跳过该来源继续运行`,
        data: { source },
      });
    },
  });
}

function createRecallSourceSummary(enabled: boolean): TaskRecallSummary['memory'] {
  return {
    enabled,
    status: enabled ? 'empty' : 'disabled',
    count: 0,
    citationCount: 0,
  };
}

function updateRecallSourceSummary(
  task: Task,
  source: 'memory' | 'knowledge_base',
  status: RecallSourceStatus,
  count: number,
  citationCount: number,
): TaskRecallSummary {
  const current = task.recallSummary ?? {
    memory: createRecallSourceSummary(config.agent.memoryRecallEnabled),
    knowledgeBase: createRecallSourceSummary(config.agent.kbRecallEnabled),
    updatedAt: new Date().toISOString(),
  };
  const next: TaskRecallSummary = {
    ...current,
    [source === 'memory' ? 'memory' : 'knowledgeBase']: {
      ...current[source === 'memory' ? 'memory' : 'knowledgeBase'],
      status,
      count,
      citationCount,
    },
    updatedAt: new Date().toISOString(),
  };
  task.recallSummary = next;
  taskStore.patch(task.id, { recallSummary: next });
  return next;
}

/** 首个 run 固化任务级模型快照；之后全局设置变更不影响本对话 resume 的模型（P1-2）。 */
function stickTaskModelSnapshot(task: Task): void {
  if (task.modelSnapshot?.model?.trim()) return;
  const model = createPiModel();
  task.modelSnapshot = {
    provider: model.provider,
    model: model.id,
    thinkingLevel: taskThinkingLevel(task),
  };
}

function selectPiModelForTask(task: Task): PiModel<any> {
  // 任务级模型粘性（P1-2）：已固化快照则恢复该模型，避免全局设置变更静默替换既有对话的模型。
  const snapshot = task.modelSnapshot;
  if (snapshot?.model?.trim()) {
    return createPiModel(snapshot.model, snapshot.provider);
  }
  // 首个 run 之前未固化：跟随全局当前模型；图片只是该模型的输入能力，不触发隐式换模型。
  return createPiModel();
}

function assertPiModelSupportsAttachments(task: Task, model: PiModel<any>): void {
  const hasImageAttachment = task.messages.some((message) => (message.imageParts?.length ?? 0) > 0);
  if (!hasImageAttachment) return;
  if (!model.input?.includes('image')) {
    throw new Error(
      `当前模型 ${model.provider}:${model.id} 不支持图片输入。请在设置中配置支持视觉的模型，或移除图片附件后重试。`,
    );
  }
}

async function userMessageContentToPi(message: Message, model: PiModel<any>): Promise<string | Array<PiTextContent | PiImageContent>> {
  const imageAttachments = message.imageParts ?? [];
  const text = await buildUserMessageTextWithAttachments(message);
  if (imageAttachments.length === 0) return text;

  const content: Array<PiTextContent | PiImageContent> = [{ type: 'text', text }];
  for (const attachment of imageAttachments) {
    if (!model.input?.includes('image')) {
      throw new Error(`模型 ${model.provider}:${model.id} 不支持图片消息：${attachment.name}`);
    }
    content.push({
      type: 'text',
      text: `[Attached image: ${attachment.name}, mime: ${attachment.mimeType}]`,
    });
    content.push(imagePartToPiContent(attachment));
  }
  return content;
}

/**
 * 用户消息正文：目标文本 + 可选图片说明 + 文本附件正文。
 * 附件只挂在发出该消息的一轮，不再每轮重写进 system（避免冲 prompt cache）。
 */
async function buildUserMessageTextWithAttachments(message: Message): Promise<string> {
  let text = message.content;
  const imageAttachments = message.imageParts ?? [];
  if (imageAttachments.length > 0) {
    const names = imageAttachments.map((a) => a.name).join(', ');
    text =
      `${message.content}\n\n[System: ${imageAttachments.length} image(s) attached inline: ${names}. ` +
      'Vision input is already provided — do not call read on image message content.]';
  }
  const fileAttachments = message.attachments ?? [];
  if (fileAttachments.length === 0) return text;

  const lines = ['', '[Attached Files]', ''];
  for (const attachment of fileAttachments) {
    lines.push(await formatAttachment(attachment));
  }
  return `${text}\n${lines.join('\n')}`;
}

function imagePartToPiContent(image: NonNullable<Message['imageParts']>[number]): PiImageContent {
  return {
    type: 'image',
    data: image.dataUrl.slice(image.dataUrl.indexOf(',') + 1),
    mimeType: image.mimeType,
  };
}

function createPiTools(task: Task, options: PiHarnessOptions): AgentTool[] {
  // 初始化统一工具框架（如果尚未初始化）
  initializeUnifiedToolFramework();

  // 获取所有可用工具，并注入带任务上下文的执行器
  const tools: AgentTool[] = withPiCompatibilityAliases(getAgentToolsForPi()).map((agentTool): AgentTool => {
    const executionToolName = executionToolNameForPiTool(agentTool.name);
    const def = unifiedToolRegistry.get(executionToolName)!;
    return {
      ...agentTool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        if (maxStepsWrapUpPending.has(task.id)) {
          throw new Error(maxStepsToolsDisabledReason());
        }
        const rawValidationError = consumeInvalidPiToolCallError(task.id, toolCallId);
        if (rawValidationError) {
          throw new Error(rawValidationError);
        }
        if (agentTool.name === 'ask_user') {
          const result = await executeAskUserTool(task, toolCallId, params, signal ?? options.signal);
          return {
            content: [{ type: 'text' as const, text: formatUnknown(result) }],
            details: result,
          };
        }
        if (agentTool.name === 'create_artifact') {
          const result = await executeCreateArtifactTool(task, toolCallId, params, options.workspaceDir);
          return {
            content: [{ type: 'text' as const, text: formatUnknown(result) }],
            details: result,
          };
        }
        if (agentTool.name === 'apply_artifact') {
          const validationError = validateToolInputSchema(inputSchemaForPiTool(agentTool.name, def.inputSchema), params);
          if (validationError) throw new Error(`schema_validation_failed: ${validationError}`);
          const result = await executeApplyArtifactTool(task, params, options.workspaceDir);
          return {
            content: [{ type: 'text' as const, text: formatUnknown(result) }],
            details: result,
          };
        }
        const validationError = validateToolInputSchema(inputSchemaForPiTool(agentTool.name, def.inputSchema), params);
        if (validationError) {
          throw new Error(`schema_validation_failed: ${validationError}`);
        }
        const executionParams = paramsForPiTool(agentTool.name, params);
        const context = createToolContext(task.id, options.workspaceDir, {
          taskGoal: task.goal,
          externalPaths: collectExternalPaths(task),
          abortSignal: signal ?? options.signal,
          callId: toolCallId,
          task,
          publishEvent: (event) => {
            if (event.type === 'tool_progress') {
              publish(event as AgentEvent);
              const message = typeof event.message === 'string' ? event.message : '';
              if (message) {
                onUpdate?.({
                  content: [{ type: 'text' as const, text: message }],
                  details: event,
                });
              }
            }
          },
        });

        try {
          const result = await def.execute(executionParams as Record<string, unknown>, context);
          return {
            content: [{ type: 'text' as const, text: formatUnknown(result) }],
            details: result,
            terminate: isRecord(result) && result.terminate === true ? true : undefined,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(message);
        }
      },
    };
  });
  if (runtimeToolExecution() !== 'sequential') return tools;
  return tools.map((tool) => ({ ...tool, executionMode: 'sequential' }));
}

function withPiCompatibilityAliases(tools: AgentTool[]): AgentTool[] {
  const result = [...tools];
  if (tools.some((tool) => tool.name === 'web_fetch') && !tools.some((tool) => tool.name === 'http_fetch')) {
    const webFetch = tools.find((tool) => tool.name === 'web_fetch')!;
    result.push({
      ...webFetch,
      name: 'http_fetch',
      label: 'http_fetch',
      description: `${webFetch.description}\nCompatibility alias for web_fetch.`,
    });
  }
  const read = tools.find((tool) => tool.name === 'read');
  if (read) {
    for (const alias of ['open_file', 'read_file']) {
      if (tools.some((tool) => tool.name === alias)) continue;
      result.push({
        ...read,
        name: alias,
        label: alias,
        description: `${read.description}\nCompatibility alias for read.`,
      });
    }
  }
  const grep = tools.find((tool) => tool.name === 'grep');
  if (grep && !tools.some((tool) => tool.name === 'search_files')) {
    result.push({
      ...grep,
      name: 'search_files',
      label: 'search_files',
      description: `${grep.description}\nCompatibility alias for grep.`,
      parameters: Type.Object({
        query: Type.String({ description: '要搜索的关键词或 grep 正则表达式' }),
        glob: Type.Optional(Type.String({ description: '文件名 glob 过滤，例如 **/*.md' })),
        path: Type.Optional(Type.String({ description: '搜索起始目录（相对工作区根）' })),
        maxResults: Type.Optional(Type.Integer({ description: '最多返回结果数，默认 50，上限 100' })),
      }, { additionalProperties: false }),
    });
  }
  return result;
}

function executionToolNameForPiTool(toolName: string): string {
  if (toolName === 'http_fetch') return 'web_fetch';
  if (toolName === 'open_file' || toolName === 'read_file') return 'read';
  if (toolName === 'search_files') return 'grep';
  return toolName;
}

function inputSchemaForPiTool(toolName: string, schema: unknown): unknown {
  if (toolName === 'search_files') return SEARCH_FILES_INPUT_SCHEMA;
  return schema;
}

function paramsForPiTool(toolName: string, params: unknown): unknown {
  if (toolName !== 'search_files' || !isRecord(params)) return params;
  const { query, glob, maxResults, ...rest } = params;
  return {
    ...rest,
    pattern: query,
    ...(typeof glob === 'string' ? { include: glob } : {}),
    ...(typeof maxResults === 'number' ? { limit: maxResults } : {}),
  };
}

async function executeCreateArtifactTool(
  task: Task,
  callId: string,
  params: unknown,
  workspaceDir: string,
): Promise<unknown> {
  const args = isRecord(params) ? params : {};
  const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'artifact.txt';
  const content = typeof args.content === 'string' ? args.content : '';
  if (content.length > MAX_ARTIFACT_CONTENT_CHARS) {
    throw new Error(`create_artifact 内容超过 ${MAX_ARTIFACT_CONTENT_CHARS.toLocaleString()} 字符上限，请改用工作区文件交付`);
  }
  const mimeType = typeof args.mimeType === 'string' ? args.mimeType : undefined;
  const type =
    args.type === 'text' || args.type === 'file' || args.type === 'diff' || args.type === 'url'
      ? args.type
      : 'file';
  const applyPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined;

  const artifact = createArtifact({
    name,
    content,
    type,
    mimeType,
    sourceCallId: callId,
    sourceTaskId: task.id,
  });
  task.artifacts = [...(task.artifacts ?? []), artifact];
  saveTask(task);
  publish({ type: 'artifact_created', taskId: task.id, artifact });

  if (applyPath) {
    const overwritesExisting = await artifactTargetExists(workspaceDir, applyPath);
    await writeArtifactToWorkspace(workspaceDir, applyPath, content);
    const applied = markArtifactApplied(task, artifact.id, applyPath);
    if (applied) {
      saveTask(task);
      publish({ type: 'artifact_updated', taskId: task.id, artifact: applied });
      return {
        artifactId: applied.id,
        path: applyPath,
        status: applied.status,
        appliedPath: applyPath,
        overwritesExisting,
      };
    }
  }

  return {
    artifactId: artifact.id,
    path: applyPath ?? name,
    status: artifact.status,
  };
}

/** 将已创建的任务产物安全写入工作区；实际写入仍复用统一 artifact path helper。 */
async function executeApplyArtifactTool(
  task: Task,
  params: unknown,
  workspaceDir: string,
): Promise<unknown> {
  const args = isRecord(params) ? params : {};
  const artifactId = typeof args.artifactId === 'string' ? args.artifactId.trim() : '';
  const path = typeof args.path === 'string' ? args.path.trim() : '';
  if (!artifactId || !path) throw new Error('artifactId 与 path 必须是非空字符串');
  const artifact = task.artifacts?.find((item) => item.id === artifactId);
  if (!artifact) throw new Error(`找不到产物：${artifactId}`);
  if (artifact.status === 'rejected') throw new Error(`产物已被拒绝，不能应用：${artifact.name}`);
  const overwritesExisting = await artifactTargetExists(workspaceDir, path);
  await writeArtifactToWorkspace(workspaceDir, path, artifact.content);
  const applied = markArtifactApplied(task, artifact.id, path);
  if (!applied) throw new Error(`应用产物状态更新失败：${artifactId}`);
  saveTask(task);
  publish({ type: 'artifact_updated', taskId: task.id, artifact: applied });
  return {
    applied: true,
    artifactId: applied.id,
    path,
    status: applied.status,
    overwritesExisting,
  };
}

async function executeAskUserTool(
  task: Task,
  callId: string,
  params: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const args = isRecord(params) ? params : {};
  const question =
    (typeof args.message === 'string' && args.message.trim()) ||
    (typeof args.question === 'string' && args.question.trim()) ||
    '请补充完成任务所需的信息。';
  const options = Array.isArray(args.options) ? args.options.filter((item): item is string => typeof item === 'string') : undefined;
  const context = typeof args.context === 'string' ? args.context : undefined;
  const clarification = createClarification({ callId, question, options, context });

  task.clarifications = [...(task.clarifications ?? []), clarification];
  setTaskState(task, 'paused', 'waiting_clarification');
  saveTask(task);
  publish({ type: 'status', taskId: task.id, status: 'paused' });
  publish({ type: 'phase', taskId: task.id, phase: 'waiting_clarification', detail: '等待用户补充信息' });
  publish({ type: 'clarification_request', taskId: task.id, clarification });

  const answer = await waitForClarificationAnswer(task.id, clarification.id, signal, config.agent.approvalTimeoutMs);
  const resolved = resolveClarification(
    task,
    clarification.id,
    answer === undefined ? 'timeout' : 'answered',
    answer,
  );
  setTaskState(task, 'running', 'calling_tool');
  saveTask(task);
  if (resolved) {
    publish({ type: 'clarification_resolved', taskId: task.id, clarification: resolved });
  }
  publish({ type: 'status', taskId: task.id, status: 'running' });
  publish({ type: 'phase', taskId: task.id, phase: 'calling_tool', detail: '继续执行用户追问结果' });

  return answer === undefined
    ? { status: 'timeout', answer: null, message: '用户超时未回复，请基于已有信息继续或说明限制。' }
    : { status: 'answered', answer };
}

function waitForClarificationAnswer(
  taskId: string,
  clarificationId: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      const byTask = pendingClarificationResolvers.get(taskId);
      byTask?.delete(clarificationId);
      if (byTask && byTask.size === 0) pendingClarificationResolvers.delete(taskId);
    };
    const finish = (answer: string | undefined) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(answer);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('cancelled'));
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    let byTask = pendingClarificationResolvers.get(taskId);
    if (!byTask) {
      byTask = new Map();
      pendingClarificationResolvers.set(taskId, byTask);
    }
    byTask.set(clarificationId, (answer) => finish(answer));
  });
}

async function gatePiToolCall(
  task: Task,
  call: ToolCall,
  signal: AbortSignal,
): Promise<{ block?: boolean; reason?: string } | undefined> {
  const planMode = task.executionMode === 'plan';
  if (planMode) {
    const planModeReason = planModeToolBlockReason(call);
    if (planModeReason) return { block: true, reason: planModeReason };
  }

  // OpenCode max-steps: disable all tools during wrap-up turn
  if (maxStepsWrapUpPending.has(task.id)) {
    return { block: true, reason: maxStepsToolsDisabledReason() };
  }

  const validationError = validatePiToolCallInput(call);
  if (validationError) {
    const message = `schema_validation_failed: ${validationError}`;
    return { block: true, reason: message };
  }

  const riskLevel = unifiedToolRegistry.riskLevelOf(call.toolName);
  const requiresExplicitApproval = unifiedToolRegistry.executionPolicyOf(call.toolName).requiresExplicitApproval === true;
  // shell、Skill 安装和 MCP 即使处于 auto 模式也必须停在用户审批处；计划模式另外保留 shell 的只读侦查入口。
  const permission = (planMode && call.toolName === 'bash') || requiresExplicitApproval
    ? { allowed: false }
    : decideToolPermission(
        approvalConfigFromTask(task, 'auto'),
        call.toolName,
        riskLevel,
      );
  if (permission.allowed) {
    if (permission.autoApproved && task.autoModeState) {
      task.autoModeState.autoApprovedCalls = (task.autoModeState.autoApprovedCalls ?? 0) + 1;
      saveTask(task);
      publish({ type: 'auto_mode_state', taskId: task.id, state: { ...task.autoModeState } });
    }
    return undefined;
  }

  // 仅 paused 等少数情况会走到单次工具审批
  const autoModeReason = requiresExplicitApproval
    ? ('not_covered' as const)
    : task.autoModeState?.paused
      ? ('paused' as const)
      : undefined;

  task.pendingApprovals = [
    ...(task.pendingApprovals ?? []),
    { call, riskLevel, createdAt: new Date().toISOString(), autoModeReason },
  ];
  setTaskState(task, 'paused', 'waiting_approval');
  saveTask(task);
  publish({ type: 'phase', taskId: task.id, phase: 'waiting_approval', detail: `等待审批工具 ${call.toolName}` });
  publish({ type: 'approval_request', taskId: task.id, call, riskLevel, autoModeReason });

  const decision = await waitForPiApproval(task.id, call.id, signal, config.agent.approvalTimeoutMs);
  task.pendingApprovals = (task.pendingApprovals ?? []).filter((item) => item.call.id !== call.id);
  setTaskState(task, 'running', 'calling_tool');
  saveTask(task);

  writePiTrace(task, 'approval', {
    ok: decision.approved,
    callId: call.id,
    toolName: call.toolName,
    riskLevel,
    errorCategory: decision.approved ? undefined : 'permission',
    summary: decision.approved ? `已批准工具 ${call.toolName}` : `拒绝/超时工具 ${call.toolName}`,
    data: { approved: decision.approved, autoModeReason },
  });

  if (!decision.approved) {
    return { block: true, reason: '用户拒绝或超时未批准该工具调用。请停止假设工具已执行，并向用户说明无法继续。' };
  }
  return undefined;
}

function validatePiToolCallInput(call: ToolCall): string | null {
  const executionToolName = executionToolNameForPiTool(call.toolName);
  const def = unifiedToolRegistry.get(executionToolName);
  if (!def) return null;
  // tool_execution_start keeps the raw model arguments, before Pi's execute-time coercion.
  return validateToolInputSchema(inputSchemaForPiTool(call.toolName, def.inputSchema), call.args);
}

function rememberInvalidPiToolCall(taskId: string, callId: string, message: string): void {
  let byTask = invalidPiToolCallErrors.get(taskId);
  if (!byTask) {
    byTask = new Map();
    invalidPiToolCallErrors.set(taskId, byTask);
  }
  byTask.set(callId, message);
}

function consumeInvalidPiToolCallError(taskId: string, callId: string): string | undefined {
  const byTask = invalidPiToolCallErrors.get(taskId);
  const message = byTask?.get(callId);
  if (!message) return undefined;
  byTask!.delete(callId);
  if (byTask!.size === 0) invalidPiToolCallErrors.delete(taskId);
  return message;
}

async function handlePiEvent(
  task: Task,
  event: PiAgentEvent,
  signal: AbortSignal,
  taskStartedAtMs: number,
  workspaceDir: string,
  controller: ActivePiTaskController,
): Promise<void> {
  if (signal.aborted) return;
  switch (event.type) {
    case 'agent_start':
      publish({
        type: 'agent_start',
        taskId: task.id,
        thinkingLevel: runtimeThinkingLevel(),
        toolExecution: runtimeToolExecution(),
      });
      break;
    case 'turn_start':
      completionGateTurnHadToolCall.delete(task.id);
      setTaskState(task, 'running', 'thinking');
      updateContextSnapshot(task);
      saveRuntimeState(task);
      publish({ type: 'phase', taskId: task.id, phase: 'thinking', detail: 'Agent 正在思考' });
      publish({ type: 'context_snapshot', taskId: task.id, tokens: task.contextTokens ?? 0 });
      break;
    case 'message_start':
      publish({ type: 'message_start', taskId: task.id, role: toAurevoyMessageStartRole(event.message.role) });
      break;
    case 'message_update':
      publishPiMessageDelta(task, event.assistantMessageEvent);
      break;
    case 'message_end':
      appendPiMessage(task, event.message);
      break;
    case 'tool_execution_start':
      completionGateTurnHadToolCall.add(task.id);
      setTaskState(task, 'running', 'calling_tool');
      recordToolCall(task);
      saveRuntimeState(task);
      {
        const rawCall = toAurevoyToolCall(task, event.toolCallId, event.toolName, event.args);
        const validationError = validatePiToolCallInput(rawCall);
        if (validationError) {
          rememberInvalidPiToolCall(task.id, event.toolCallId, `schema_validation_failed: ${validationError}`);
        }
      }
      {
        // delegate 对用户是「子智能体」，不要露出裸工具名
        const phaseDetail =
          event.toolName === 'delegate'
            ? (() => {
                const args = event.args && typeof event.args === 'object' && !Array.isArray(event.args)
                  ? (event.args as Record<string, unknown>)
                  : {};
                const role = typeof args.role === 'string' ? args.role : '';
                const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
                const roleLabel =
                  role === 'explore' ? '探索'
                  : role === 'research' ? '调研'
                  : role === 'coder' ? '编码'
                  : role === 'shell' ? '验证'
                  : role === 'writer' ? '写作'
                  : role ? role : '';
                if (goal && roleLabel) return `创建子智能体 · ${roleLabel}：${goal.slice(0, 48)}${goal.length > 48 ? '…' : ''}`;
                if (goal) return `创建子智能体：${goal.slice(0, 56)}${goal.length > 56 ? '…' : ''}`;
                if (roleLabel) return `创建子智能体 · ${roleLabel}`;
                return '创建子智能体';
              })()
            : `调用工具 ${event.toolName}`;
        publish({ type: 'phase', taskId: task.id, phase: 'calling_tool', detail: phaseDetail });
        publish({ type: 'tool_call', taskId: task.id, call: toAurevoyToolCall(task, event.toolCallId, event.toolName, event.args) });
        writePiTrace(task, 'tool_call', {
          ok: true,
          callId: event.toolCallId,
          toolName: event.toolName,
          riskLevel: unifiedToolRegistry.riskLevelOf(event.toolName),
          summary: event.toolName === 'delegate' ? '创建子智能体' : `调用工具 ${event.toolName}`,
          data: { args: event.args },
        });
      }
      break;
    case 'tool_execution_update':
      publish({
        type: 'tool_progress',
        taskId: task.id,
        callId: event.toolCallId,
        message: piContentToText(event.partialResult?.content) || `工具 ${event.toolName} 正在执行`,
      });
      break;
    case 'tool_execution_end':
      await appendToolResult(task, event.toolCallId, event.toolName, event.result, event.isError, workspaceDir);
      break;
    case 'turn_end':
      recordIteration(task);
      updateWallTime(task, taskStartedAtMs);
      updateContextSnapshot(task);
      saveRuntimeState(task);
      publishBudgetUsage(task);
      publish({ type: 'context_snapshot', taskId: task.id, tokens: task.contextTokens ?? 0 });
      if (shouldStopAfterTurn(task, taskStartedAtMs, controller)) {
        controller.abort();
      }
      break;
    case 'agent_end':
      // 对齐 Pi #2090：首轮成功后 fire-and-forget 精炼侧栏标题，不阻塞主循环
      scheduleTaskTitleRefine(task);
      break;
  }
}

function runtimeThinkingLevel(): AgentThinkingLevel {
  return config.agent.thinkingLevel;
}

/**
 * 任务级推理档：固化在 modelSnapshot 上则沿用（P1-2），否则跟随全局设置。
 */
function taskThinkingLevel(task: Task): AgentThinkingLevel {
  return task.modelSnapshot?.thinkingLevel ?? runtimeThinkingLevel();
}

/**
 * harness own-events（非 AgentEvent 的 22 类钩子）桥接层。
 * 仅挑选对产品有可见性价值的事件转发成 SSE；不处理的不影响主循环。
 */
function handlePiOwnEvent(task: Task, event: AgentHarnessOwnEvent, options: PiHarnessOptions): void {
  if (options.signal.aborted) return;
  switch (event.type) {
    case 'retry_scheduled':
      publishRetryStatus(task, true, {
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        reason: event.errorMessage,
      });
      break;
    case 'retry_attempt_start':
      // retry_scheduled 已给出 attempt/delay；attempt_start 只需维持“重试中”。
      publishRetryStatus(task, true);
      break;
    case 'retry_finished':
      publishRetryStatus(task, false);
      break;
    case 'before_provider_request':
      providerRequestStartedAtByTask.set(task.id, Date.now());
      writePiTrace(task, 'llm', {
        ok: true,
        phase: task.phase,
        summary: `开始请求模型 ${event.model.provider}:${event.model.id}`,
        data: {
          stage: 'request_started',
          provider: event.model.provider,
          model: event.model.id,
          sessionId: event.sessionId,
        },
      });
      break;
    case 'after_provider_response': {
      const startedAtMs = providerRequestStartedAtByTask.get(task.id);
      providerRequestStartedAtByTask.delete(task.id);
      createTaskLogger(task.id).trace('llm', task.phase, {
        ok: event.status >= 200 && event.status < 400,
        startedAtMs,
        summary: `模型请求响应 HTTP ${event.status}`,
        data: {
          stage: 'response_received',
          status: event.status,
          requestId: event.headers['x-request-id'] ?? event.headers['request-id'],
        },
      });
      break;
    }
    case 'queue_update': {
      const pending: PendingQueueItem[] = [];
      for (const message of event.steer) pending.push({ kind: 'steering', preview: queueMessagePreview(message) });
      for (const message of event.followUp) pending.push({ kind: 'follow_up', preview: queueMessagePreview(message) });
      publish({ type: 'queue_update', taskId: task.id, pending });
      break;
    }
    case 'session_compact':
      // harness.compact()（run 起点或未来 SDK 自动触发）产生的真 LLM 摘要；
      // 与内联 context 压缩共用同一 compacted SSE 语义。
      publish({
        type: 'compacted',
        taskId: task.id,
        originalCount: 0,
        summaryLength: event.compactionEntry.summary.length,
        summary: event.compactionEntry.summary,
        tokensBefore: event.compactionEntry.tokensBefore,
        automatic: true,
      });
      break;
    case 'model_update':
      applyTaskModelSnapshot(task, event.model, taskThinkingLevel(task));
      break;
    case 'thinking_level_update':
      applyTaskModelSnapshot(task, undefined, event.level as AgentThinkingLevel);
      break;
    default:
      break;
  }
}

function publishRetryStatus(
  task: Task,
  active: boolean,
  detail?: { attempt?: number; maxAttempts?: number; delayMs?: number; reason?: string },
): void {
  publish({
    type: 'retry_status',
    taskId: task.id,
    active,
    attempt: detail?.attempt,
    maxAttempts: detail?.maxAttempts,
    delayMs: detail?.delayMs,
    reason: detail?.reason,
  });
  if (!active) return;
  writePiTrace(task, 'phase', {
    ok: true,
    phase: task.phase,
    summary: `LLM 后台操作重试 ${detail?.attempt ?? '?'}/${detail?.maxAttempts ?? '?'}`,
    data: detail,
  });
}

/** 更新任务级模型快照并广播 model_updated；运行中 harness 模型变化时由 own-event 触发。 */
function applyTaskModelSnapshot(task: Task, model: PiModel<any> | undefined, thinkingLevel: AgentThinkingLevel): void {
  const snapshot = resolveTaskModelFromPi(task, model, thinkingLevel);
  task.modelSnapshot = snapshot;
  saveTask(task);
  publish({
    type: 'model_updated',
    taskId: task.id,
    provider: snapshot.provider,
    model: snapshot.model,
    thinkingLevel: snapshot.thinkingLevel,
  });
}

/** 由可选 Pi 模型 + 推理档解析任务级模型快照，缺省回落既有快照再到全局配置。 */
function resolveTaskModelFromPi(
  task: Task,
  model: PiModel<any> | undefined,
  thinkingLevel: AgentThinkingLevel,
): TaskModelSnapshot {
  return {
    provider: model?.provider ?? task.modelSnapshot?.provider ?? config.llm.provider,
    model: model?.id ?? task.modelSnapshot?.model ?? config.llm.model,
    thinkingLevel,
  };
}

function queueMessagePreview(message: AgentMessage): string {
  const text = piContentToText('content' in message ? message.content : '').replace(/\s+/g, ' ').trim();
  if (!text) return '（待注入消息）';
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function runtimeToolExecution(): AgentToolExecutionMode {
  return config.agent.toolExecution;
}

function runtimeCacheRetention(): AgentCacheRetention {
  return config.agent.cacheRetention === 'short' ? 'short' : 'long';
}

function toAurevoyMessageStartRole(role: AgentMessage['role']): 'user' | 'assistant' | 'toolResult' {
  if (role === 'assistant' || role === 'user' || role === 'toolResult') return role;
  return 'user';
}

function updateContextSnapshot(task: Task): void {
  task.contextTokens = totalTokens(task.messages);
}

function publishPiMessageDelta(task: Task, event: PiAssistantMessageEvent): void {
  if (event.type === 'text_delta') {
    addOutputBytes(task, event.delta);
    publish({ type: 'token', taskId: task.id, delta: event.delta });
    return;
  }

  // 深度推理流：避免长时间只显示「正在思考」且无任何过程提示
  if (event.type === 'thinking_start' || event.type === 'thinking_delta') {
    publishThrottledPrepPhase(task, '正在深度推理…', event.type === 'thinking_start');
    return;
  }

  if (event.type === 'hosted_tool_start') {
    const key = `${task.id}:${event.call.id}`;
    if (hostedToolStartedAtByCall.has(key)) return;
    const startedAtMs = Date.now();
    const call: ToolCall = {
      id: event.call.id,
      toolName: event.call.name,
      args: event.call.arguments,
      providerExecuted: true,
      planStepId: currentPlanStepId(task),
      summary: event.call.name === 'web_search' ? '搜索网页' : `调用工具 ${event.call.name}`,
    };
    hostedToolStartedAtByCall.set(key, {
      taskId: task.id,
      startedAtMs,
      toolName: event.call.name,
    });
    setTaskState(task, 'running', 'calling_tool');
    recordToolCall(task);
    saveRuntimeState(task);
    const message = createProviderHostedCallMessage(call);
    task.messages.push(message);
    taskStore.appendMessage(task, message);
    publish({ type: 'message', taskId: task.id, message });
    publish({ type: 'phase', taskId: task.id, phase: 'calling_tool', detail: '正在搜索网页' });
    publish({ type: 'tool_call', taskId: task.id, call });
    writePiTrace(task, 'tool_call', {
      ok: true,
      phase: task.phase,
      callId: event.call.id,
      toolName: event.call.name,
      summary: call.summary,
      data: { providerExecuted: true },
    });
    return;
  }

  if (event.type === 'hosted_tool_end') {
    const key = `${task.id}:${event.result.callId}`;
    if (task.messages.some((message) =>
      message.role === 'tool'
      && message.toolCallId === event.result.callId
      && message.providerExecuted,
    )) {
      return;
    }
    let hosted = hostedToolStartedAtByCall.get(key);
    // 部分兼容端只发送完成项；补出同一标准调用消息，保证持久化始终成对。
    if (!hosted) {
      const call: ToolCall = {
        id: event.result.callId,
        toolName: 'web_search',
        args: {},
        providerExecuted: true,
        planStepId: currentPlanStepId(task),
        summary: '搜索网页',
      };
      hosted = { taskId: task.id, startedAtMs: Date.now(), toolName: call.toolName };
      hostedToolStartedAtByCall.set(key, hosted);
      recordToolCall(task);
      saveRuntimeState(task);
      const callMessage = createProviderHostedCallMessage(call);
      task.messages.push(callMessage);
      taskStore.appendMessage(task, callMessage);
      publish({ type: 'message', taskId: task.id, message: callMessage });
      publish({ type: 'tool_call', taskId: task.id, call });
      writePiTrace(task, 'tool_call', {
        ok: true,
        phase: task.phase,
        callId: call.id,
        toolName: call.toolName,
        summary: call.summary,
        data: { providerExecuted: true },
      });
    }
    const result: ToolResult = event.result.ok
      ? { callId: event.result.callId, ok: true, providerExecuted: true }
      : {
          callId: event.result.callId,
          ok: false,
          providerExecuted: true,
          error: event.result.error ?? '网页搜索失败',
          errorCode: 'execution_failed',
        };
    const message = createProviderHostedResultMessage(result);
    task.messages.push(message);
    taskStore.appendMessage(task, message);
    publish({ type: 'tool_result', taskId: task.id, result });
    publish({ type: 'message', taskId: task.id, message });
    hostedToolStartedAtByCall.delete(key);
    writePiTrace(task, 'tool_result', {
      ok: event.result.ok,
      phase: task.phase,
      callId: event.result.callId,
      toolName: hosted?.toolName ?? 'web_search',
      startedAtMs: hosted?.startedAtMs,
      errorCategory: event.result.ok ? undefined : 'tool',
      errorMessage: event.result.error,
      summary: event.result.ok ? '网页搜索完成' : '网页搜索失败',
      data: { providerExecuted: true },
    });
    return;
  }

  // 工具参数流式生成（尤其 write 大段正文）在 tool_execution_start 之前可能持续很久
  if (event.type === 'toolcall_start' || event.type === 'toolcall_delta') {
    const block = event.partial?.content?.[event.contentIndex];
    if (!isRecord(block) || block.type !== 'toolCall') return;
    const name = typeof block.name === 'string' && block.name.trim() ? block.name.trim() : 'tool';
    const args = normalizePartialToolArgs(block.arguments);
    const detail = describePreparingToolCall(name, args);
    publishThrottledPrepPhase(task, detail, event.type === 'toolcall_start');
  }
}

/** 准备阶段 phase 节流：start 立即推；delta 约 300ms 或文案实质变化时推。 */
function publishThrottledPrepPhase(task: Task, detail: string, force: boolean): void {
  const now = Date.now();
  const lastAt = lastPrepPhaseAtByTask.get(task.id) ?? 0;
  const lastDetail = lastPrepPhaseDetailByTask.get(task.id) ?? '';
  const meaningfulChange =
    detail !== lastDetail &&
    // 路径/字数从无到有、或字数档位变化时立刻刷新
    (detail.length > lastDetail.length + 24 ||
      /（/.test(detail) !== /（/.test(lastDetail) ||
      extractPrepPathHint(detail) !== extractPrepPathHint(lastDetail));
  if (!force && !meaningfulChange && now - lastAt < 300) return;
  lastPrepPhaseAtByTask.set(task.id, now);
  lastPrepPhaseDetailByTask.set(task.id, detail);
  publish({ type: 'phase', taskId: task.id, phase: 'thinking', detail });
}

function extractPrepPathHint(detail: string): string {
  const m = /(?:撰写|写入|编辑|准备写入)\s+(\S+)/.exec(detail);
  return m?.[1] ?? '';
}

function normalizePartialToolArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 流式 JSON 未闭合：尝试从残片里抠 path / content 预览
      return extractArgsFromPartialJson(raw);
    }
  }
  return {};
}

/** 从不完整 JSON 字符串里尽量抽出 path/content/query 等字段（best-effort）。 */
function extractArgsFromPartialJson(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const path = /"(?:path|file|file_path|htmlPath)"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(raw);
  if (path) out.path = path[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
  const query = /"(?:query|q|pattern)"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(raw);
  if (query) out.query = query[1].replace(/\\"/g, '"');
  const contentKey = /"(content|contents|text|html|body|markdown)"\s*:\s*"/.exec(raw);
  if (contentKey) {
    // 粗算已流出的 content 长度（不含完整反序列化）
    const from = contentKey.index + contentKey[0].length;
    out.content = raw.slice(from).replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
  const command = /"(?:command|cmd)"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(raw);
  if (command) out.command = command[1].replace(/\\"/g, '"');
  const url = /"url"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(raw);
  if (url) out.url = url[1].replace(/\\"/g, '"');
  const goal = /"goal"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(raw);
  if (goal) out.goal = goal[1].replace(/\\"/g, '"');
  const role = /"role"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(raw);
  if (role) out.role = role[1].replace(/\\"/g, '"');
  return out;
}

function partialArgString(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

function formatDraftChars(n: number): string {
  if (n < 1000) return `${n} 字`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k 字`;
  return `${Math.round(n / 1000)}k 字`;
}

/**
 * 工具参数仍在流式生成时的用户可见行为文案。
 * 目标：长 write/正文阶段不再长时间只显示「正在思考」。
 */
function describePreparingToolCall(name: string, args: Record<string, unknown>): string {
  const path = partialArgString(args, ['path', 'file', 'file_path', 'filename', 'htmlPath']);
  const base = path.split(/[/\\]/).filter(Boolean).pop() || path;
  const content = partialArgString(args, ['content', 'contents', 'text', 'html', 'body', 'markdown']);
  const query = partialArgString(args, ['query', 'q', 'pattern']);
  const command = partialArgString(args, ['command', 'cmd']);
  const url = partialArgString(args, ['url']);
  const goal = partialArgString(args, ['goal']);
  const role = partialArgString(args, ['role']);

  if (/^(write|write_file|create_file|append_file|session_write)$/.test(name)) {
    if (base && content.length > 0) return `正在撰写 ${base}（${formatDraftChars(content.length)}）`;
    if (base) return `正在准备写入 ${base}`;
    if (content.length > 0) return `正在撰写文件内容（${formatDraftChars(content.length)}）`;
    return '正在撰写文件内容…';
  }
  if (/^(edit|edit_lines|replace_lines|apply_diff)$/.test(name)) {
    return base ? `正在准备编辑 ${base}` : '正在准备编辑文件…';
  }
  if (name === 'web_search' || name === 'search_grep' || name === 'grep' || name === 'glob') {
    return query
      ? `正在准备搜索 · ${query.slice(0, 48)}${query.length > 48 ? '…' : ''}`
      : '正在准备搜索…';
  }
  if (name === 'web_fetch' || name === 'http_fetch') {
    return url
      ? `正在准备抓取 · ${url.slice(0, 56)}${url.length > 56 ? '…' : ''}`
      : '正在准备抓取网页…';
  }
  if (name === 'bash' || name === 'execute_command') {
    return command
      ? `正在准备命令 · ${command.slice(0, 40)}${command.length > 40 ? '…' : ''}`
      : '正在准备运行命令…';
  }
  if (name === 'delegate') {
    if (goal) {
      const roleBit = role ? ` · ${role}` : '';
      return `正在准备子智能体${roleBit}：${goal.slice(0, 40)}${goal.length > 40 ? '…' : ''}`;
    }
    return '正在准备创建子智能体…';
  }
  if (name === 'bundle_report') {
    return base ? `正在准备打包报告 · ${base}` : '正在准备打包报告…';
  }
  if (name === 'attach_content') return '正在准备附加内容…';
  if (name === 'load_skill') return '正在准备加载技能…';
  return `正在准备 · ${name}`;
}

function addOutputBytes(task: Task, delta: string): void {
  recordOutputBytes(task, delta);
}

function writePiTrace(
  task: Task,
  kind: TaskTraceKind,
  entry?: {
    ok?: boolean;
    phase?: TaskPhase | null;
    callId?: string;
    toolName?: string;
    riskLevel?: import('@aurevoy/shared').ToolRiskLevel;
    finishReason?: string;
    errorCategory?: TaskErrorCategory;
    errorMessage?: string;
    summary?: string;
    tokenUsage?: AggregatedTokenUsage | null;
    startedAtMs?: number;
    data?: unknown;
  },
): void {
  createTaskLogger(task.id).trace(kind, entry?.phase ?? null, {
    ok: entry?.ok,
    callId: entry?.callId,
    toolName: entry?.toolName,
    riskLevel: entry?.riskLevel,
    finishReason: entry?.finishReason,
    errorCategory: entry?.errorCategory,
    errorMessage: entry?.errorMessage,
    summary: entry?.summary,
    tokenUsage: entry?.tokenUsage,
    startedAtMs: entry?.startedAtMs,
    data: entry?.data,
  });
}

function appendPiMessage(task: Task, message: AgentMessage): void {
  if (message.role !== 'assistant') return;
  const mapped = assistantMessageToAurevoy(task, message);
  const completionVerdict = extractCompletionGateVerdict(mapped.content);
  if (completionVerdict) {
    completionGateVerdictByTask.set(task.id, completionVerdict);
    mapped.content = stripCompletionGateMarker(mapped.content);
  }
  task.tokenUsage = aggregatePiUsage(task.tokenUsage, message.usage, message.provider, message.model);
  const hasToolCalls = (mapped.toolCalls?.length ?? 0) > 0;
  // COMPLETE 审计通常只返回内部标记；剥离后不制造一条空白助手消息。
  const shouldPersistMessage = mapped.content.length > 0 || hasToolCalls || !!mapped.failure;
  if (shouldPersistMessage) {
    task.messages.push(mapped);
  }
  // 无工具的助手回复视为终稿推进：跳过未完成中间步，进入 deliver
  if (task.executionMode !== 'plan' && !hasToolCalls && !mapped.failure) {
    advancePlanAfterFinalAnswer(task);
  }
  if (shouldPersistMessage) {
    taskStore.appendMessage(task, mapped);
  } else {
    // 内部完成门禁可能只更新计划/用量而不产生用户可见消息。
    taskStore.saveMessages(task);
  }
  if (shouldPersistMessage) {
    publish({ type: 'message', taskId: task.id, message: mapped });
  }
  publish({ type: 'token_usage', taskId: task.id, usage: task.tokenUsage });

  writePiTrace(task, 'llm', {
    ok: !mapped.failure,
    finishReason: hasToolCalls ? 'tool_use' : mapped.failure ? 'error' : 'stop',
    tokenUsage: task.tokenUsage,
    summary: hasToolCalls
      ? `LLM 请求 ${mapped.toolCalls!.length} 个工具`
      : completionVerdict === 'complete' && mapped.content.length === 0
        ? '完成门禁确认原始目标已满足'
        : `LLM 生成 ${mapped.content.length} 字符回复`,
    data: {
      contentLength: mapped.content.length,
      toolCallCount: mapped.toolCalls?.length ?? 0,
      completionVerdict,
    },
  });
}

async function appendToolResult(task: Task, callId: string, toolName: string, result: unknown, isError: boolean, workspaceDir: string): Promise<void> {
  const details = isRecord(result) && 'details' in result ? result.details : result;
  const errorMessage = isError ? extractToolErrorMessage(result, details) : undefined;
  const errorCode = isError ? classifyToolError(errorMessage) : undefined;
  const toolResult: ToolResult = isError
    ? { callId, ok: false, error: errorMessage, errorCode }
    : { callId, ok: true, output: details };
  const message: Message = {
    id: randomUUID(),
    role: 'tool',
    content: isError
      ? JSON.stringify({ error: toolResult.error || '工具执行失败', errorCode: toolResult.errorCode })
      : formatUnknown(toolResult.output),
    toolCallId: callId,
    createdAt: new Date().toISOString(),
  };
  task.messages.push(message);
  if (!isError) {
    maybeCreateToolCheckpoint(task, callId, toolName);
    advancePlanAfterTool(task, toolName, true);
  }
  taskStore.appendMessage(task, message);
  if (!isError) recordTaskFileChange(task, callId, toolName, toolResult.output);
  publish({ type: 'tool_result', taskId: task.id, result: toolResult });
  publish({ type: 'message', taskId: task.id, message });
  writePiTrace(task, 'tool_result', {
    ok: !isError,
    callId,
    toolName,
    errorMessage: isError ? toolResult.error : undefined,
    summary: isError ? `工具 ${toolName} 执行失败` : `工具 ${toolName} 执行成功`,
    data: {
      output: toolResult.output,
      untrusted: isUntrustedToolOutput(toolResult.output),
    },
  });
  if (!isError && hasPromptInjectionSignal(toolResult.output)) {
    // 只记录检测结果和工具关联，不把可疑外部正文再次写入专门的安全轨迹。
    writePiTrace(task, 'tool_result', {
      ok: true,
      callId,
      toolName,
      summary: '检测到疑似 prompt injection，已按不可信输入继续处理',
      data: { untrusted: true, promptInjectionDetected: true },
    });
  }

  const contentBlocks: ContentBlock[] = [];

  // attach_content / present_ui：提取 contentBlock 并挂到对应的 assistant 消息。
  // 禁止回退挂到 tool 消息 id——前端交付面只渲染 assistant，挂错会导致文件卡丢归属/反复出现在 live tail。
  if (!isError && (toolName === 'attach_content' || toolName === 'present_ui')) {
    const raw = extractAttachContentBlock(result, details);
    if (isRecord(raw) && typeof raw.type === 'string') {
      const block = buildContentBlockFromTool(raw, workspaceDir);
      if (block) contentBlocks.push(block);
    }
  }

  if (!isError) {
    try {
      contentBlocks.push(...await materializeMcpBrowserContentBlocks({
        taskId: task.id,
        callId,
        result,
        workspaceDir,
      }));
    } catch (error) {
      // 产物写入失败不能把已经成功的浏览器调用改判为工具失败，只记录可诊断的短错误。
      writePiTrace(task, 'tool_result', {
        ok: false,
        callId,
        toolName,
        summary: '浏览器结果无法写入工作台产物',
        errorMessage: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      });
    }
  }
  for (const block of contentBlocks) attachContentBlock(task, callId, block);
}

/** 将工具交付块挂到发起调用的 assistant 消息，统一处理历史 upsert 与实时广播。 */
function attachContentBlock(task: Task, callId: string, block: ContentBlock): void {
  let assistantMessageId: string | undefined;
  if (block.type === 'ui') {
    for (const msg of task.messages) {
      if (msg.role !== 'assistant' || !msg.contentBlocks?.some((item) => item.id === block.id)) continue;
      msg.contentBlocks = upsertContentBlock(msg.contentBlocks, block);
      assistantMessageId = msg.id;
      break;
    }
  }
  if (!assistantMessageId) {
    for (let i = task.messages.length - 1; i >= 0; i--) {
      const msg = task.messages[i];
      if (msg.role === 'assistant' && msg.toolCalls?.some((tc) => tc.id === callId)) {
        msg.contentBlocks = upsertContentBlock(msg.contentBlocks, block);
        assistantMessageId = msg.id;
        break;
      }
    }
  }
  if (assistantMessageId) {
    saveTask(task);
    publish({ type: 'content_blocks_added', taskId: task.id, messageId: assistantMessageId, blocks: [block] });
  }
}

/** 将文件工具的结构化结果汇总到任务级摘要，供工作台展示且不复制文件正文。 */
function recordTaskFileChange(task: Task, callId: string, toolName: string, output: unknown): void {
  if (!isRecord(output)) return;
  // create_artifact 的 draft/confirmed 只存在于任务 JSON；只有 apply_artifact 或
  // 已明确返回 applied 的结果才代表工作区真实发生了文件变更。
  if (toolName === 'create_artifact' && output.status !== 'applied') return;
  const path = typeof output.resource === 'string'
    ? output.resource
    : typeof output.file === 'string'
      ? output.file
      : typeof output.appliedPath === 'string'
        ? output.appliedPath
        : typeof output.targetPath === 'string'
          ? output.targetPath
          : typeof output.path === 'string'
            ? output.path
            : undefined;
  if (!path || !['write', 'edit', 'copy_file', 'move_file', 'rename_file', 'delete_file', 'create_artifact', 'apply_artifact'].includes(toolName)) return;

  const operation: TaskFileChangeOperation = toolName === 'edit'
    ? 'modified'
    : toolName === 'copy_file'
      ? 'copied'
      : toolName === 'move_file' || toolName === 'rename_file'
        ? 'moved'
        : toolName === 'delete_file'
          ? 'deleted'
          : toolName === 'create_artifact' || toolName === 'apply_artifact'
            ? 'artifact_applied'
            : output.operation === 'appended' ? 'appended' : output.existed === true ? 'modified' : 'created';
  const change: TaskFileChange = {
    id: randomUUID(),
    path,
    operation,
    additions: numberOrUndefined(output.additions),
    deletions: numberOrUndefined(output.deletions),
    bytesBefore: numberOrUndefined(output.bytesBefore),
    bytesAfter: numberOrUndefined(output.bytesAfter ?? output.bytes),
    baselineAvailable: toolName === 'edit'
      || (toolName === 'write' && output.existed === true)
      || toolName === 'copy_file'
      || toolName === 'move_file'
      || toolName === 'rename_file',
    sourceCallId: callId,
    updatedAt: new Date().toISOString(),
  };
  const changes = [...(task.fileChanges ?? []), change].slice(-100);
  task.fileChanges = changes;
  taskStore.patch(task.id, { fileChanges: changes });
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isUntrustedToolOutput(value: unknown): boolean {
  return isRecord(value) && value.untrusted === true;
}

function hasPromptInjectionSignal(value: unknown): boolean {
  if (!isUntrustedToolOutput(value)) return false;
  const text = JSON.stringify(value).slice(0, 120_000);
  return /ignore\s+(all\s+)?(previous|prior)\s+instructions|system\s+prompt|developer\s+message|reveal\s+(secrets|credentials|api\s+keys?)|bypass\s+(approval|security|policy)|do\s+not\s+tell/i.test(text);
}

function maybeCreateToolCheckpoint(task: Task, callId: string, toolName: string): void {
  if (task.plan.length < 2) return;
  if ((task.checkpoints ?? []).some((checkpoint) => isRecord(checkpoint.data) && checkpoint.data.callId === callId)) return;
  const checkpoint = createCheckpoint({
    label: `工具 ${toolName} 已完成`,
    stepId: currentPlanStepId(task),
    message: `已完成工具调用 ${toolName}`,
    data: { callId, toolName },
  });
  task.checkpoints = [...(task.checkpoints ?? []), checkpoint];
  publish({ type: 'checkpoint_created', taskId: task.id, checkpoint });
}

function classifyToolError(message: string | undefined): ToolResult['errorCode'] {
  const text = message ?? '';
  if (text.includes('schema_validation_failed') || text.includes('schema') || text.includes('参数')) {
    return 'schema_validation_failed';
  }
  if (text.includes('用户拒绝') || text.includes('超时未批准') || text.includes('not approved')) {
    return 'approval_denied';
  }
  return 'execution_failed';
}

function extractAttachContentBlock(result: unknown, details: unknown): unknown {
  if (isRecord(details) && 'contentBlock' in details) return details.contentBlock;
  if (isRecord(result) && 'contentBlock' in result) return result.contentBlock;
  return undefined;
}

function buildContentBlockFromTool(
  raw: Record<string, unknown>,
  workspaceDir: string,
): ContentBlock | null {
  const type = String(raw.type);
  if (type === 'ui') {
    if (raw.kind !== 'canvas' || !isRecord(raw.props) || typeof raw.props.html !== 'string') return null;
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : randomUUID(),
      type: 'ui',
      content: typeof raw.content === 'string' ? raw.content : '',
      kind: 'canvas',
      props: {
        title: typeof raw.props.title === 'string' ? raw.props.title : undefined,
        description: typeof raw.props.description === 'string' ? raw.props.description : undefined,
        state: toUiCanvasState(raw.props.state),
        html: raw.props.html,
        css: typeof raw.props.css === 'string' ? raw.props.css : undefined,
        script: typeof raw.props.script === 'string' ? raw.props.script : undefined,
      },
      fallbackText: typeof raw.fallbackText === 'string' ? raw.fallbackText : undefined,
    };
  }

  if (typeof raw.content !== 'string') return null;
  if (type !== 'file_reference' && type !== 'image' && type !== 'link') return null;
  let resolvedContent = String(raw.content);
  const isFile = type === 'file_reference' || type === 'image';
  if (isFile && resolvedContent.length > 0 && !resolvedContent.startsWith('/') && !resolvedContent.startsWith('~')) {
    resolvedContent = join(workspaceDir, resolvedContent);
  }
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : randomUUID(),
    type: type as ContentBlock['type'],
    content: resolvedContent,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : undefined,
    size: typeof raw.size === 'number' ? raw.size : undefined,
    source: type === 'link' ? 'external_untrusted' : 'tool',
    untrusted: type === 'link',
  };
}

/** 按稳定 ID 合并内容块；同 ID 的后到版本覆盖旧版本。 */
function upsertContentBlock(existing: ContentBlock[] | undefined, next: ContentBlock): ContentBlock[] {
  const blocks = [...(existing ?? [])];
  const index = blocks.findIndex((block) => block.id === next.id);
  if (index >= 0) blocks[index] = next;
  else blocks.push(next);
  return blocks;
}

/** 只让跨进程 UI 状态携带 JSON primitive，丢弃嵌套对象与不可序列化值。 */
function toUiCanvasState(value: unknown): Record<string, string | number | boolean | null> | undefined {
  if (!isRecord(value)) return undefined;
  const state: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') state[key] = item;
    else if (typeof item === 'number' && Number.isFinite(item)) state[key] = item;
  }
  return state;
}

function assistantMessageToAurevoy(task: Task, message: PiAssistantMessage): Message {
  const toolCalls: MessageToolCall[] = message.content
    .filter((block) => block.type === 'toolCall')
    .map((block) => ({
      id: block.id,
      type: 'function',
      function: {
        name: block.name,
        arguments: JSON.stringify(block.arguments ?? {}),
        planStepId: currentPlanStepId(task),
        summary: buildToolCallSummary(block.name, block.arguments),
      },
    }));
  return {
    id: randomUUID(),
    role: 'assistant',
    content: piContentToText(message.content.filter((block) => block.type === 'text')),
    createdAt: new Date(message.timestamp).toISOString(),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    failure: message.errorMessage
      ? {
          message: message.errorMessage,
          category: message.stopReason === 'aborted'
            ? 'cancelled'
            : classifyTaskError(message.errorMessage, 'model'),
        }
      : undefined,
  };
}

function buildToolNamesByCallId(messages: Message[]): Map<string, string> {
  const toolNamesByCallId = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      toolNamesByCallId.set(call.id, call.function.name);
    }
  }
  return toolNamesByCallId;
}

export async function toPiMessage(
  message: Message,
  toolNamesByCallId: Map<string, string>,
  model: PiModel<any>,
): Promise<PiMessage[]> {
  const timestamp = new Date(message.createdAt).getTime();
  if (message.role === 'user') {
    return [{
      role: 'user',
      content: await userMessageContentToPi(message, model),
      timestamp,
    }];
  }
  if (message.role === 'assistant') {
    const localToolCalls = (message.toolCalls ?? []).filter((call) => !call.providerExecuted);
    const content = [
      ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
      ...localToolCalls.map((call) => ({
        type: 'toolCall' as const,
        id: call.id,
        name: call.function.name,
        arguments: parseToolArguments(call.function.arguments),
      })),
    ];
    // Provider 已完成的工具记录只用于产品历史；空壳消息不能回放成本地函数调用。
    if (content.length === 0) return [];
    return [{
      role: 'assistant',
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyPiUsage(),
      stopReason: message.failure ? 'error' : (localToolCalls.length ? 'toolUse' : 'stop'),
      errorMessage: message.failure?.message,
      timestamp,
    }];
  }
  if (message.role === 'tool' && message.toolCallId) {
    if (message.providerExecuted) return [];
    return [{
      role: 'toolResult',
      toolCallId: message.toolCallId,
      toolName: toolNamesByCallId.get(message.toolCallId) ?? 'unknown',
      content: [{ type: 'text', text: message.content }],
      isError: !!message.failure,
      timestamp,
    } satisfies PiToolResultMessage];
  }
  return [];
}

function toAurevoyToolCall(task: Task, id: string, toolName: string, args: unknown): ToolCall {
  return {
    id,
    toolName,
    args: isRecord(args) ? args : {},
    summary: buildToolCallSummary(toolName, args),
    planStepId: currentPlanStepId(task),
  };
}

function currentPlanStepId(task: Task): string | undefined {
  return task.plan.find((step) => step.status === 'running')?.id ?? task.plan[0]?.id;
}

function aggregatePiUsage(
  current: AggregatedTokenUsage | undefined,
  usage: PiUsage | null | undefined | Record<string, unknown>,
  provider: string,
  model: string,
): AggregatedTokenUsage {
  const normalized = normalizePiUsage(usage);
  const resolvedProvider = provider?.trim() || current?.provider || config.llm.provider;
  const resolvedModel = model?.trim() || current?.model || config.llm.model;
  if (!normalized) {
    return {
      ...(current ?? {}),
      available: current?.available ?? false,
      provider: resolvedProvider,
      model: resolvedModel,
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    available: true,
    provider: resolvedProvider,
    model: resolvedModel,
    promptTokens: (current?.promptTokens ?? 0) + normalized.promptTokens,
    completionTokens: (current?.completionTokens ?? 0) + normalized.completionTokens,
    totalTokens: (current?.totalTokens ?? 0) + normalized.totalTokens,
    reasoningTokens: (current?.reasoningTokens ?? 0) + normalized.reasoningTokens,
    cacheReadTokens: (current?.cacheReadTokens ?? 0) + normalized.cacheReadTokens,
    cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + normalized.cacheWriteTokens,
    estimatedCostUsd: (current?.estimatedCostUsd ?? 0) + normalized.estimatedCostUsd,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 归一化多种 usage 形态：
 * - Pi Usage：{ input, output, cacheRead, cacheWrite, totalTokens, cost }
 * - OpenAI raw：{ prompt_tokens, completion_tokens, total_tokens }
 * - 字符串数字（部分网关）
 */
function normalizePiUsage(usage: PiUsage | null | undefined | Record<string, unknown>): Required<Pick<
  AggregatedTokenUsage,
  'promptTokens' | 'completionTokens' | 'totalTokens' | 'reasoningTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'estimatedCostUsd'
>> | null {
  if (!usage || typeof usage !== 'object') return null;
  const raw = usage as Record<string, unknown>;
  const costObj = isRecord(raw.cost) ? raw.cost : undefined;

  const cacheRead = firstUsageNumber(
    raw.cacheRead,
    isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details.cached_tokens : undefined,
    raw.prompt_cache_hit_tokens,
  );
  const cacheWrite = firstUsageNumber(
    raw.cacheWrite,
    isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details.cache_write_tokens : undefined,
  );
  // Pi: input 不含 cache；OpenAI prompt_tokens 通常含 cache hit
  const promptRaw = firstUsageNumber(raw.input, raw.prompt_tokens, raw.promptTokens);
  const input = raw.input !== undefined && raw.input !== null
    ? firstUsageNumber(raw.input)
    : Math.max(0, promptRaw - cacheRead - cacheWrite);
  const output = firstUsageNumber(
    raw.output,
    raw.completion_tokens,
    raw.completionTokens,
  );
  const reasoning = firstUsageNumber(
    raw.reasoning,
    isRecord(raw.completion_tokens_details) ? raw.completion_tokens_details.reasoning_tokens : undefined,
    raw.reasoningTokens,
  );
  const total = firstUsageNumber(raw.totalTokens, raw.total_tokens)
    || (input + output + cacheRead + cacheWrite);
  const cost = firstUsageNumber(costObj?.total, raw.estimatedCostUsd);

  if (total <= 0 && input <= 0 && output <= 0 && cacheRead <= 0 && cacheWrite <= 0 && reasoning <= 0 && cost <= 0) {
    return null;
  }
  return {
    // 与既有口径一致：promptTokens = 非 cache 输入 + cache 读写
    promptTokens: input + cacheRead + cacheWrite,
    completionTokens: output,
    totalTokens: total,
    reasoningTokens: reasoning,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    estimatedCostUsd: cost,
  };
}

function firstUsageNumber(...values: unknown[]): number {
  for (const value of values) {
    const n = coerceUsageNumber(value);
    if (n > 0) return n;
  }
  return 0;
}

function coerceUsageNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

async function formatAttachment(attachment: MessageAttachment): Promise<string> {
  if (!isTextFile(attachment)) {
    return `### ${attachment.name} (path: ${attachment.path}, type: ${attachment.mimeType})\n[非文本文件，使用 read_file 工具读取，路径: ${attachment.path}]\n`;
  }
  try {
    let content = await fs.readFile(attachment.path, 'utf8');
    if (content.length > MAX_ATTACHMENT_CONTENT_CHARS) {
      content = `${content.slice(0, MAX_ATTACHMENT_CONTENT_CHARS)}\n\n[... 文件过长，已截断。使用 read_file 工具读取完整内容，路径: ${attachment.path}]`;
    }
    return `### ${attachment.name} (path: ${attachment.path})\n\n${content}\n`;
  } catch {
    return `### ${attachment.name} (path: ${attachment.path})\n[无法直接读取文件内容，使用 read_file 工具读取，路径: ${attachment.path}]\n`;
  }
}

function extractToolErrorMessage(result: unknown, details: unknown): string {
  if (result instanceof Error) return result.message;
  // Pi harness 可能把错误包装成 AgentToolResult，错误文本在 content 数组里
  if (isRecord(result) && Array.isArray(result.content)) {
    const texts = result.content
      .filter((block: unknown) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
      .map((block: unknown) => (block as Record<string, unknown>).text as string);
    if (texts.length > 0) return texts.join('\n');
  }
  if (isRecord(result) && typeof result.message === 'string') return result.message;
  if (isRecord(result) && typeof result.error === 'string') return result.error;
  const formatted = formatUnknown(details);
  if (formatted !== '{}' && formatted !== '') return formatted;
  return '工具执行失败';
}

function isTextFile(attachment: MessageAttachment): boolean {
  if (attachment.mimeType.startsWith('text/')) return true;
  return TEXT_EXTENSIONS.has(extname(attachment.name).toLowerCase());
}

function collectExternalPaths(task: Task): string[] {
  const paths = task.messages.flatMap((message) => message.attachments?.map((attachment) => attachment.path) ?? []);
  return [...new Set(paths.filter((p) => p && !p.startsWith('memory://')))];
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function piContentToText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') return block.text;
    if (isRecord(block) && block.type === 'image' && typeof block.mimeType === 'string') return `[image:${block.mimeType}]`;
    return '';
  }).join('');
}

function setTaskState(task: Task, status: TaskStatus, phase: TaskPhase): void {
  task.status = status;
  task.phase = phase;
  task.updatedAt = new Date().toISOString();
}

function finishCompleted(task: Task): void {
  task.budgetExceeded = undefined;
  // Plan 结束只是完成本轮只读讨论，不能把尚未执行的 proposed 步骤标为完成。
  if (task.executionMode !== 'plan') completePlanOnSuccess(task);
  setTaskState(task, 'completed', 'finalizing');
  saveTask(task);
  publishBudgetUsage(task);
  publish({ type: 'status', taskId: task.id, status: 'completed' });
  publish({ type: 'phase', taskId: task.id, phase: 'finalizing', detail: '任务完成' });
  // done 是 SSE 的终止帧；先落齐审计轨迹，避免客户端收到 done 后立即查询时读到半成品。
  writePiTrace(task, 'done', { ok: true, summary: '任务完成' });
  publish({ type: 'done', taskId: task.id, status: 'completed' });
}

/**
 * 模型在一次性完成审计后仍未确认目标满足。
 * 保留 paused + 可续跑语义，避免把 provider 停止错误翻译成产品级 completed。
 */
function finishCompletionPaused(
  task: Task,
  verdict: CompletionGateVerdict | null,
): void {
  task.budgetExceeded = undefined;
  if (verdict === null) {
    const message: Message = {
      id: randomUUID(),
      role: 'assistant',
      content: 'Agent 已停止，但完成门禁没有确认原始目标已经满足。任务保持为可继续执行状态。',
      createdAt: new Date().toISOString(),
    };
    task.messages.push(message);
    publish({ type: 'message', taskId: task.id, message });
  }
  setTaskState(task, 'paused', 'waiting_completion');
  saveTask(task);
  publishBudgetUsage(task);
  publish({ type: 'status', taskId: task.id, status: 'paused' });
  publish({
    type: 'phase',
    taskId: task.id,
    phase: 'waiting_completion',
    detail: verdict === 'needs_attention'
      ? '原始目标尚未完成，需要处理阻塞项'
      : '完成门禁未获得明确结论，可继续执行',
  });
  writePiTrace(task, 'done', {
    ok: false,
    phase: 'waiting_completion',
    summary: verdict === 'needs_attention'
      ? '完成门禁判定需要用户处理'
      : '完成门禁缺少明确结论',
    data: { completionVerdict: verdict },
  });
  publish({ type: 'done', taskId: task.id, status: 'paused' });
}

/**
 * 预算触顶：本 run 结束，任务进入可续跑暂停态。
 * 发出 done(status=paused) 以便 SSE / 前端结束 busy，用户可 resume 或 budget/continue。
 */
function finishBudgetPaused(task: Task, info: BudgetExceededInfo): void {
  task.budgetExceeded = info;
  // Prefer a durable OpenCode-style wrap-up that includes plan progress; if the model already
  // wrote a long assistant summary after the max-steps follow-up, still append a short continue hint.
  const lastAssistant = [...task.messages].reverse().find((m) => m.role === 'assistant');
  const alreadySummarized =
    typeof lastAssistant?.content === 'string' &&
    lastAssistant.content.length > 80 &&
    /(已完成|未完成|阻塞|建议|summary|blocker|remaining|next)/i.test(lastAssistant.content);
  const wrapUpBody = alreadySummarized
    ? `${info.reason}。可点击「继续执行」在完整上下文上续跑（本轮用量已清零；寿命预算不足时会自动扩容）。`
    : buildMaxStepsWrapUpMessage(task, info);
  const message: Message = {
    id: randomUUID(),
    role: 'assistant',
    content: wrapUpBody,
    createdAt: new Date().toISOString(),
  };
  task.messages.push(message);
  setTaskState(task, 'paused', 'waiting_budget');
  saveTask(task);
  publishBudgetUsage(task);
  publish({ type: 'budget_exceeded', taskId: task.id, info });
  publish({ type: 'message', taskId: task.id, message });
  publish({ type: 'status', taskId: task.id, status: 'paused' });
  publish({ type: 'phase', taskId: task.id, phase: 'waiting_budget', detail: info.reason });
  writePiTrace(task, 'phase', {
    ok: true,
    phase: 'waiting_budget',
    errorCategory: 'budget',
    summary: info.reason,
    data: info,
  });
  writePiTrace(task, 'done', {
    ok: true,
    phase: 'waiting_budget',
    errorCategory: 'budget',
    summary: `预算暂停：${info.reason}`,
  });
  publish({ type: 'done', taskId: task.id, status: 'paused' });
}

function finishCancelled(task: Task): void {
  failOpenPlanSteps(task);
  setTaskState(task, 'cancelled', 'cancelled');
  saveTask(task);
  publish({ type: 'status', taskId: task.id, status: 'cancelled' });
  publish({ type: 'phase', taskId: task.id, phase: 'cancelled', detail: '用户取消任务' });
  writePiTrace(task, 'done', { ok: false, summary: '任务被取消' });
  publish({ type: 'done', taskId: task.id, status: 'cancelled' });
}

function finishFailed(
  task: Task,
  err: unknown,
  errorCategory: TaskErrorCategory = 'unknown',
  reuseExistingFailureMessage = false,
): void {
  const message = err instanceof Error ? err.message : String(err);
  const existingFailureMessage = reuseExistingFailureMessage
    ? [...task.messages].reverse().find(
        (candidate) => candidate.role === 'assistant' && candidate.failure?.message === message,
      )
    : undefined;
  const failureMessage: Message = existingFailureMessage ?? {
    id: randomUUID(),
    role: 'assistant',
    content: `任务失败：${message}`,
    failure: { message, category: errorCategory },
    createdAt: new Date().toISOString(),
  };
  failOpenPlanSteps(task);
  setTaskState(task, 'failed', 'failed');
  if (!existingFailureMessage) task.messages.push(failureMessage);
  saveTask(task);
  publish({ type: 'status', taskId: task.id, status: 'failed' });
  publish({ type: 'phase', taskId: task.id, phase: 'failed', detail: message });
  writePiTrace(task, 'error', {
    ok: false,
    errorCategory,
    errorMessage: message,
    summary: `任务失败：${message}`,
  });
  writePiTrace(task, 'done', { ok: false, summary: `任务失败：${message}` });
  if (!existingFailureMessage) {
    publish({ type: 'message', taskId: task.id, message: failureMessage });
  }
  publish({ type: 'error', taskId: task.id, message });
  publish({ type: 'done', taskId: task.id, status: 'failed' });
}

function saveTask(task: Task): void {
  // 运行中 steering/follow-up 由 HTTP 请求持有的另一份 Task 实例先落库。
  // runtime 结束时若直接全量保存旧实例，会把刚追加的产品用户消息覆盖掉。
  // 因此以 SQLite 的耐久顺序为基线，仅补入尚未增量落库的内存消息。
  const durable = taskStore.get(task.id);
  if (durable) {
    task.messages = mergeDurableTaskMessages(durable.messages, task.messages);
  }
  taskStore.save(task);
}

/** 以已经追加到 SQLite 的顺序为准，补入仅存在于 runtime 内存中的尾部消息。 */

/** 高频轮次/工具状态只更新运行时列，避免反复序列化完整消息与产物。 */
function saveRuntimeState(task: Task): void {
  taskStore.patch(task.id, {
    status: task.status,
    phase: task.phase,
    budgetUsage: task.budgetUsage,
    lifetimeUsage: task.lifetimeUsage,
    tokenUsage: task.tokenUsage,
    contextTokens: task.contextTokens,
    pendingApprovals: task.pendingApprovals ?? [],
  });
}

function publish(event: AgentEvent): void {
  taskEvents.publish(event);
}

function emptyPiUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
