import { promises as fs } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AgentHarness,
  InMemorySessionRepo,
  type AgentEvent as PiAgentEvent,
  type AgentMessage,
  type AgentTool,
  type Skill as PiHarnessSkill,
} from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { Type } from 'typebox';
import {
  anthropicMessagesApi,
  azureOpenAIResponsesApi,
  bedrockConverseStreamApi,
  googleGenerativeAIApi,
  googleVertexApi,
  mistralConversationsApi,
  openAICodexResponsesApi,
  openAICompletionsApi,
  openAIResponsesApi,
  type AssistantMessageEvent as PiAssistantMessageEvent,
  type AssistantMessage as PiAssistantMessage,
  type ImageContent as PiImageContent,
  type Message as PiMessage,
  type Model as PiModel,
  type Models as PiModels,
  type TextContent as PiTextContent,
  type ToolResultMessage as PiToolResultMessage,
  type Usage as PiUsage,
} from '@earendil-works/pi-ai/compat';
import { createModels, createProvider } from '@earendil-works/pi-ai';
import type { ProviderAuth } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { aurevoyCredentialStore } from '../llm/credential-store.js';
import { readLlmCredential } from '../llm/llm-store.js';
import { xaiGrokOauth } from '../llm/xai-oauth.js';
import type {
  AgentEvent,
  AggregatedTokenUsage,
  BudgetExceededInfo,
  ContentBlock,
  Message,
  MessageAttachment,
  MessageToolCall,
  ScoutReport,
  Task,
  TaskErrorCategory,
  TaskPhase,
  TaskStatus,
  TaskTraceKind,
  ToolCall,
  ToolResult,
  AgentCacheRetention,
  AgentThinkingLevel,
  AgentToolExecutionMode,
} from '@aurevoy/shared';
import { config } from '../config.js';
import { taskEvents } from './events.js';
import { createTaskLogger } from '../logging/trace.js';
import { taskStore, projectStore } from '../store/db.js';
import { unifiedToolRegistry, validateToolInputSchema } from '../tool/unified-registry.js';
import { initializeUnifiedToolFramework, getAgentToolsForPi, createToolContext } from '../tool/index.js';
import {
  buildStableSystemPromptParts,
  buildVolatileTimeContextMessage,
  joinSystemPromptParts,
  totalTokens,
  TOOLS_WITH_LARGE_OUTPUT,
  TOOLS_KEEP_VERBATIM,
  compactToolResult,
} from './context.js';
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
} from './m6-state.js';
import { waitForPiApproval } from './pi-approval.js';
import {
  advancePlanAfterFinalAnswer,
  advancePlanAfterTool,
  completePlanOnSuccess,
  failOpenPlanSteps,
} from './plan-progress.js';
import {
  buildMaxStepsPrompt,
  buildMaxStepsWrapUpMessage,
  buildResumeProgressInjection,
  decideMaxStepsAfterTurn,
  maxStepsToolsDisabledReason,
} from './control-policy.js';
import { assertPiLLMConfigured, createPiModel, resolveModelApi, resolveModelBaseUrl } from '../llm/pi-provider.js';
import { approvalConfigFromTask, decideToolPermission } from './approval.js';
import { skillRegistry } from '../skills/registry.js';
import { scheduleTaskTitleRefine } from './task-title.js';

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
const activePiControllers = new Map<string, ActivePiTaskController>();
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

class ActivePiTaskController {
  private harness?: AgentHarness;
  private pendingSteering: Message[] = [];
  private pendingFollowUp: Message[] = [];

  constructor(
    private readonly modelForNextTurn: () => PiModel<any>,
  ) {}

  attach(harness: AgentHarness): void {
    this.harness = harness;
    const steering = this.pendingSteering.splice(0);
    const followUps = this.pendingFollowUp.splice(0);
    for (const message of steering) this.enqueueSteering(message);
    for (const message of followUps) this.enqueueFollowUp(message);
  }

  abort(): void {
    void this.harness?.abort();
  }

  enqueueSteering(message: Message): void {
    if (!this.harness) {
      this.pendingSteering.push(message);
      return;
    }
    void this.deliverQueuedMessage('steer', message);
  }

  enqueueFollowUp(message: Message): void {
    if (!this.harness) {
      this.pendingFollowUp.push(message);
      return;
    }
    void this.deliverQueuedMessage('followUp', message);
  }

  private async deliverQueuedMessage(kind: 'steer' | 'followUp', message: Message): Promise<void> {
    if (!this.harness) return;
    const input = await toHarnessPromptInput(message, this.modelForNextTurn());
    try {
      if (kind === 'steer') {
        await this.harness.steer(input.text, input.images.length > 0 ? { images: input.images } : undefined);
      } else {
        await this.harness.followUp(input.text, input.images.length > 0 ? { images: input.images } : undefined);
      }
    } catch {
      // 运行已结束或正在收敛时，队列投递失败不应打断 HTTP 请求线程。
    }
  }
}

export function steerPiHarnessTask(taskId: string, message: Message): boolean {
  const controller = activePiControllers.get(taskId);
  if (!controller) return false;
  controller.enqueueSteering(message);
  return true;
}

export function followUpPiHarnessTask(taskId: string, message: Message): boolean {
  const controller = activePiControllers.get(taskId);
  if (!controller) return false;
  controller.enqueueFollowUp(message);
  return true;
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

export async function runPiHarnessTask(task: Task, options: PiHarnessOptions): Promise<void> {
  task.pendingApprovals = [];
  const { lifetimeWallAtRunStart } = beginRunBudget(task);
  lifetimeWallAtRunStartByTask.set(task.id, lifetimeWallAtRunStart);
  budgetStopByTask.delete(task.id);
  maxStepsWrapUpPending.delete(task.id);
  maxStepsWrapUpDone.delete(task.id);
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
    const selectedModel = selectPiModelForTask();
    assertPiModelSupportsAttachments(task, selectedModel);
    const controller = new ActivePiTaskController(() => selectPiModelForTask());
    const harness = await createPiHarness(task, options, selectedModel, controller);

    publish({ type: 'phase', taskId: task.id, phase: 'thinking', detail: 'Agent 正在思考' });
    activePiControllers.set(task.id, controller);
    const onAbort = () => controller.abort();
    options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (options.signal.aborted) throw new Error('cancelled');
      const promptInput = await buildHarnessRunInput(task, selectedModel);
      await harness.prompt(
        promptInput.text,
        promptInput.images.length > 0 ? { images: promptInput.images } : undefined,
      );
    } finally {
      options.signal.removeEventListener('abort', onAbort);
      activePiControllers.delete(task.id);
      invalidPiToolCallErrors.delete(task.id);
      pinnedSystemPromptByTask.delete(task.id);
      lastPrepPhaseAtByTask.delete(task.id);
      lastPrepPhaseDetailByTask.delete(task.id);
      maxStepsWrapUpPending.delete(task.id);
      maxStepsWrapUpDone.delete(task.id);
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
    const message = err instanceof Error ? err.message : String(err);
    const isConfigError =
      message.includes('未配置 LLM') ||
      message.includes('未选择模型') ||
      message.includes('未支持的 Provider');
    finishFailed(task, err, isConfigError ? 'configuration' : 'unknown');
  }
}

async function createPiHarness(
  task: Task,
  options: PiHarnessOptions,
  selectedModel: PiModel<any>,
  controller: ActivePiTaskController,
): Promise<AgentHarness> {
  const env = new NodeExecutionEnv({ cwd: options.workspaceDir, shellEnv: process.env });
  const session = await new InMemorySessionRepo().create({ id: task.id });
  const seedMessages = await buildHarnessSeedMessages(task, selectedModel);
  for (const message of seedMessages) {
    await session.appendMessage(message);
  }

  const harness = new AgentHarness({
    env,
    session,
    models: createAurevoyPiModels(selectedModel),
    tools: createPiTools(task, options),
    resources: { skills: createHarnessSkills() },
    systemPrompt: async () => await buildPiSystemPrompt(task, options.workspaceDir),
    model: selectedModel,
    thinkingLevel: runtimeThinkingLevel() === 'off' ? 'off' : runtimeThinkingLevel(),
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
    if (!isPiAgentEvent(event)) return;
    await handlePiEvent(task, event, options.signal, options.taskStartedAtMs, options.workspaceDir, controller);
  });
  harness.on('context', (event) => {
    const filtered = event.messages.filter((message): message is PiMessage =>
      message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult',
    );
    // 整表确定性 Snip+Microcompact：会话存原文，重放保证已发送前缀字节稳定
    const compacted = compactPiMessagesCacheAware(filtered);
    return { messages: compacted as AgentMessage[] };
  });
  harness.on('tool_call', async (event) => {
    const call = toAurevoyToolCall(task, event.toolCallId, event.toolName, event.input);
    return await gatePiToolCall(task, call, options.signal);
  });
  return harness;
}

export function createAurevoyPiModels(selectedModel: PiModel<any>): PiModels {
  // 端点已由 createPiModel → resolveModelBaseUrl 按 provider 槽解析；
  // 禁止再拿扁平 config.llm.baseUrl 压过，否则会把 openai-compatible 的网关串到 opencode-go 等槽。
  const requestBaseUrl = resolveModelBaseUrl(selectedModel.baseUrl, selectedModel.provider);
  const requestApi = resolveModelApi(selectedModel.api, requestBaseUrl, selectedModel.provider);
  const modelForRequest = {
    ...selectedModel,
    baseUrl: requestBaseUrl || selectedModel.baseUrl,
    api: requestApi as typeof selectedModel.api,
  };

  // 内置 provider：使用 Pi 原生 auth（API Key env + OAuth + CredentialStore 自动 refresh）
  const builtin = findBuiltinProvider(modelForRequest.provider);
  const models = createModels({ credentials: aurevoyCredentialStore });

  if (builtin) {
    const provider = createProvider({
      id: builtin.id,
      name: builtin.name || builtin.id,
      baseUrl: modelForRequest.baseUrl || builtin.baseUrl,
      headers: builtin.headers,
      auth: wrapBuiltinAuth(
        augmentProviderAuth(builtin.id, builtin.auth),
        modelForRequest.baseUrl,
        builtin.id,
      ),
      models: [modelForRequest],
      api: getApiForApiName(modelForRequest.api),
    });
    models.setProvider(provider);
    return models;
  }

  // 自定义 / 未知 provider：仅 API Key
  const provider = createProvider({
    id: modelForRequest.provider,
    name: modelForRequest.provider,
    baseUrl: modelForRequest.baseUrl,
    auth: {
      apiKey: {
        name: 'Aurevoy API Key',
        resolve: async () => {
          if (!config.llm.apiKey?.trim()) return undefined;
          return {
            auth: {
              apiKey: config.llm.apiKey,
              baseUrl: modelForRequest.baseUrl,
            },
            source: 'settings',
          };
        },
      },
    },
    models: [modelForRequest],
    api: getApiForApiName(modelForRequest.api),
  });
  models.setProvider(provider);
  return models;
}

function findBuiltinProvider(providerId: string) {
  return builtinProviders().find((p) => p.id === providerId);
}

/** Pi 未声明 oauth 时，Aurevoy 可叠加扩展（如 xAI SuperGrok）。 */
function augmentProviderAuth(providerId: string, auth: ProviderAuth): ProviderAuth {
  if (auth.oauth) return auth;
  if (providerId === 'xai') {
    return { ...auth, oauth: xaiGrokOauth };
  }
  return auth;
}

/**
 * 保留 Pi 原生 apiKey/oauth；叠加 baseUrl，并按 **model.provider** 取本槽凭证。
 * 禁止回退到「当前激活槽」的 config.llm.apiKey（跨 provider 串钥根因）。
 *
 * openai-codex 等「仅 OAuth」provider：不要注入 sk- API Key 回退。
 */
function wrapBuiltinAuth(
  auth: ProviderAuth,
  requestBaseUrl: string,
  providerId: string,
): ProviderAuth {
  const base = requestBaseUrl.replace(/\/+$/, '');
  const oauthOnly = Boolean(auth.oauth) && !auth.apiKey;

  const resolveSlotApiKey = (): string | undefined => {
    const cred = readLlmCredential(providerId);
    if (cred?.type === 'api_key') {
      const key = String((cred as { key?: string }).key ?? '').trim();
      if (key) return key;
    }
    // 仅当本 provider 恰好是激活槽时，才用内存 key
    if (providerId === config.llm.provider && config.llm.apiKey?.trim()) {
      return config.llm.apiKey.trim();
    }
    return undefined;
  };

  return {
    apiKey: auth.apiKey
      ? {
          ...auth.apiKey,
          resolve: async (input) => {
            const result = await auth.apiKey!.resolve(input);
            if (result) {
              return {
                ...result,
                auth: {
                  ...result.auth,
                  baseUrl: base || result.auth.baseUrl,
                },
              };
            }
            const slotKey = resolveSlotApiKey();
            if (slotKey) {
              return {
                auth: {
                  apiKey: slotKey,
                  baseUrl: base || undefined,
                },
                source: 'settings',
              };
            }
            return undefined;
          },
        }
      : oauthOnly
        ? undefined
        : {
            name: 'Aurevoy API Key',
            resolve: async () => {
              const slotKey = resolveSlotApiKey();
              if (!slotKey) return undefined;
              return {
                auth: { apiKey: slotKey, baseUrl: base || undefined },
                source: 'settings',
              };
            },
          },
    oauth: auth.oauth,
  };
}

function getApiForApiName(api: string) {
  switch (api) {
    case 'anthropic-messages': return anthropicMessagesApi();
    case 'azure-openai-responses': return azureOpenAIResponsesApi();
    case 'bedrock-converse-stream': return bedrockConverseStreamApi();
    case 'google-generative-ai': return googleGenerativeAIApi();
    case 'google-vertex': return googleVertexApi();
    case 'mistral-conversations': return mistralConversationsApi();
    case 'openai-codex-responses': return openAICodexResponsesApi();
    case 'openai-responses': return openAIResponsesApi();
    default: return openAICompletionsApi();
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

async function buildHarnessSeedMessages(task: Task, model: PiModel<any>): Promise<AgentMessage[]> {
  const promptIndex = findHarnessPromptMessageIndex(task.messages);
  const seedSource = promptIndex >= 0 ? task.messages.slice(0, promptIndex) : task.messages;
  return await toPiMessages(seedSource, model);
}

async function buildHarnessRunInput(task: Task, model: PiModel<any>): Promise<{ text: string; images: PiImageContent[] }> {
  const promptIndex = findHarnessPromptMessageIndex(task.messages);
  const promptMessage = promptIndex >= 0 ? task.messages[promptIndex] : undefined;
  const progress = buildResumeProgressInjection(task);
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
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user') return index;
  }
  return -1;
}

async function toHarnessPromptInput(message: Message, model: PiModel<any>): Promise<{ text: string; images: PiImageContent[] }> {
  const imageAttachments = (message.attachments ?? []).filter((attachment) => attachment.type === 'image');
  const images: PiImageContent[] = [];
  for (const attachment of imageAttachments) {
    if (!model.input?.includes('image')) {
      throw new Error(`模型 ${model.provider}:${model.id} 不支持图片附件：${attachment.name}`);
    }
    images.push(await imageAttachmentToPiContent(attachment));
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
      controller.enqueueFollowUp(wrapUpMsg);
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
  const startedAt = Date.now();
  publish({ type: 'scout_started', taskId: task.id });
  const keyFiles = await findScoutKeyFiles(workspaceDir);
  const techStack = await inferScoutTechStack(workspaceDir);
  const report: ScoutReport = {
    keyFiles,
    techStack,
    // Generic product constraints only — never monorepo- or product-specific recipes.
    constraints: [
      'Prefer verified tool results; do not invent success when external capabilities fail.',
      'Stay within the task workspace unless the user granted broader access.',
    ],
    summary: keyFiles.length > 0
      ? `已识别 ${keyFiles.length} 个工作区关键文件，Agent 将优先结合这些上下文执行。`
      : '未识别到常见项目入口文件，Agent 将通过工具按需侦查工作区。',
    durationMs: Date.now() - startedAt,
    rounds: 1,
  };
  publish({ type: 'scout_report', taskId: task.id, report });
}

async function findScoutKeyFiles(workspaceDir: string): Promise<Array<{ path: string; reason: string }>> {
  // Generic entry files common across many repos; missing paths are skipped.
  const candidates = [
    ['AGENTS.md', 'Agent / project collaboration instructions'],
    ['CLAUDE.md', 'Project agent instructions'],
    ['README.md', 'Project overview and local setup'],
    ['package.json', 'Node package scripts and dependencies'],
    ['pyproject.toml', 'Python project metadata'],
    ['Cargo.toml', 'Rust project metadata'],
    ['go.mod', 'Go module definition'],
    ['docs/ARCHITECTURE.md', 'Architecture documentation'],
    ['docs/API.md', 'API documentation'],
  ] as const;
  const result: Array<{ path: string; reason: string }> = [];
  for (const [relativePath, reason] of candidates) {
    try {
      await fs.access(join(workspaceDir, relativePath));
      result.push({ path: relativePath, reason });
    } catch {
      // 候选文件不存在时跳过，侦查事件应保持非阻塞。
    }
  }
  return result;
}

async function inferScoutTechStack(workspaceDir: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(join(workspaceDir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = new Set([
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
    ]);
    return [
      deps.has('react') ? 'React' : null,
      deps.has('typescript') ? 'TypeScript' : null,
      deps.has('vite') ? 'Vite' : null,
      deps.has('@tauri-apps/api') || deps.has('@tauri-apps/cli') ? 'Tauri' : null,
      deps.has('fastify') ? 'Fastify' : null,
    ].filter((item): item is string => !!item);
  } catch {
    return [];
  }
}

async function buildPiSystemPrompt(task: Task, workspaceDir: string): Promise<string> {
  const pinned = pinnedSystemPromptByTask.get(task.id);
  if (pinned) return pinned;

  const projectInfo = task.projectId ? projectStore.get(task.projectId) : undefined;
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
      buildVolatileTimeContextMessage().content,
    ].filter(Boolean),
  );
  pinnedSystemPromptByTask.set(task.id, full);
  return full;
}

function selectPiModelForTask(): PiModel<any> {
  // 一个任务只使用用户当前选择的主模型；图片只是该模型的输入能力，不触发隐式换模型。
  return createPiModel();
}

function assertPiModelSupportsAttachments(task: Task, model: PiModel<any>): void {
  const hasImageAttachment = task.messages.some((message) =>
    message.attachments?.some((attachment) => attachment.type === 'image'),
  );
  if (!hasImageAttachment) return;
  if (!model.input?.includes('image')) {
    throw new Error(
      `当前模型 ${model.provider}:${model.id} 不支持图片输入。请在设置中配置支持视觉的模型，或移除图片附件后重试。`,
    );
  }
}

async function userMessageContentToPi(message: Message, model: PiModel<any>): Promise<string | Array<PiTextContent | PiImageContent>> {
  const imageAttachments = (message.attachments ?? []).filter((attachment) => attachment.type === 'image');
  const text = await buildUserMessageTextWithAttachments(message);
  if (imageAttachments.length === 0) return text;

  const content: Array<PiTextContent | PiImageContent> = [{ type: 'text', text }];
  for (const attachment of imageAttachments) {
    if (!model.input?.includes('image')) {
      throw new Error(`模型 ${model.provider}:${model.id} 不支持图片附件：${attachment.name}`);
    }
    content.push({
      type: 'text',
      text: `[Attached image: ${attachment.name}, mime: ${attachment.mimeType}]`,
    });
    content.push(await imageAttachmentToPiContent(attachment));
  }
  return content;
}

/**
 * 用户消息正文：目标文本 + 可选图片说明 + 文本附件正文。
 * 附件只挂在发出该消息的一轮，不再每轮重写进 system（避免冲 prompt cache）。
 */
async function buildUserMessageTextWithAttachments(message: Message): Promise<string> {
  let text = message.content;
  const imageAttachments = (message.attachments ?? []).filter((attachment) => attachment.type === 'image');
  if (imageAttachments.length > 0) {
    const names = imageAttachments.map((a) => a.name).join(', ');
    text =
      `${message.content}\n\n[System: ${imageAttachments.length} image(s) attached inline: ${names}. ` +
      'Vision input is already provided — do not call read on memory:// or attachment paths.]';
  }
  const fileAttachments = (message.attachments ?? []).filter((attachment) => attachment.type !== 'image');
  if (fileAttachments.length === 0) return text;

  const lines = ['', '[Attached Files]', ''];
  for (const attachment of fileAttachments) {
    lines.push(await formatAttachment(attachment));
  }
  return `${text}\n${lines.join('\n')}`;
}

async function imageAttachmentToPiContent(attachment: MessageAttachment): Promise<PiImageContent> {
  try {
    const raw = await fs.readFile(attachment.path);
    return {
      type: 'image',
      data: raw.toString('base64'),
      mimeType: attachment.mimeType,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`无法读取图片附件 ${attachment.name} (${attachment.path})：${message}`);
  }
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
  if (tools.some((tool) => tool.name === 'open_file') && !tools.some((tool) => tool.name === 'read_file')) {
    const openFile = tools.find((tool) => tool.name === 'open_file')!;
    result.push({
      ...openFile,
      name: 'read_file',
      label: 'read_file',
      description: `${openFile.description}\nCompatibility alias for open_file.`,
    });
  }
  if (tools.some((tool) => tool.name === 'search_grep') && !tools.some((tool) => tool.name === 'search_files')) {
    const searchGrep = tools.find((tool) => tool.name === 'search_grep')!;
    result.push({
      ...searchGrep,
      name: 'search_files',
      label: 'search_files',
      description: `${searchGrep.description}\nCompatibility alias for search_grep.`,
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
  if (toolName === 'read_file') return 'open_file';
  if (toolName === 'search_files') return 'search_grep';
  return toolName;
}

function inputSchemaForPiTool(toolName: string, schema: unknown): unknown {
  if (toolName === 'search_files') return SEARCH_FILES_INPUT_SCHEMA;
  return schema;
}

function paramsForPiTool(toolName: string, params: unknown): unknown {
  if (toolName !== 'search_files' || !isRecord(params)) return params;
  const { query, ...rest } = params;
  return { ...rest, pattern: query };
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
  });
  task.artifacts = [...(task.artifacts ?? []), artifact];
  saveTask(task);
  publish({ type: 'artifact_created', taskId: task.id, artifact });

  if (applyPath) {
    const abs = join(workspaceDir, applyPath);
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    const applied = markArtifactApplied(task, artifact.id, applyPath);
    if (applied) {
      saveTask(task);
      publish({ type: 'artifact_updated', taskId: task.id, artifact: applied });
      return {
        artifactId: applied.id,
        path: applyPath,
        status: applied.status,
        appliedPath: applyPath,
      };
    }
  }

  return {
    artifactId: artifact.id,
    path: applyPath ?? name,
    status: artifact.status,
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
  // Plan 下的 shell 不自动放行：它可能需要读取工作区外的用户目录。
  // 保留工具调用，由用户在现有审批界面明确确认，而不是把探索直接判死。
  const permission = planMode && call.toolName === 'bash'
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
  const autoModeReason = task.autoModeState?.paused ? ('paused' as const) : undefined;

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

/** 计划阶段必须由运行时硬门禁保证只读，而非仅依赖模型提示。 */
export function planModeToolBlockReason(call: ToolCall): string | undefined {
  const readOnlyTools = new Set([
    'read', 'open_file', 'read_file', 'list_directory', 'list_dir', 'glob', 'grep',
    'search_grep', 'search_files', 'web_search', 'web_fetch', 'http_fetch', 'recall',
    'get_current_time', 'load_skill', 'ask_user', 'update_plan',
  ]);
  if (readOnlyTools.has(call.toolName)) return undefined;
  // Shell 的安全性无法靠名称判断；Plan 不直接执行，而是转入用户审批。
  if (call.toolName === 'bash') return undefined;
  if (call.toolName !== 'delegate') {
    return `计划模式仅允许只读侦查、检索、澄清和维护计划；请切换到 Agent 模式后再调用该工具。`;
  }

  const args = call.args;
  const role = typeof args.role === 'string' ? args.role : 'general';
  const tools = Array.isArray(args.tools) ? args.tools.filter((item): item is string => typeof item === 'string') : [];
  if (role !== 'explore' && role !== 'research') {
    return `计划模式仅允许 explore 或 research 子代理，当前角色为 ${role}。`;
  }
  const unsafeTool = tools.find((tool) => !readOnlyTools.has(tool));
  if (unsafeTool) {
    return `计划模式不允许子代理使用 ${unsafeTool}；请仅委托只读侦查或调研。`;
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
      setTaskState(task, 'running', 'thinking');
      updateContextSnapshot(task);
      saveTask(task);
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
      setTaskState(task, 'running', 'calling_tool');
      recordToolCall(task);
      saveTask(task);
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
      appendToolResult(task, event.toolCallId, event.toolName, event.result, event.isError, workspaceDir);
      break;
    case 'turn_end':
      recordIteration(task);
      updateWallTime(task, taskStartedAtMs);
      updateContextSnapshot(task);
      saveTask(task);
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
    data: entry?.data,
  });
}

function appendPiMessage(task: Task, message: AgentMessage): void {
  if (message.role !== 'assistant') return;
  const mapped = assistantMessageToAurevoy(task, message);
  task.messages.push(mapped);
  task.tokenUsage = aggregatePiUsage(task.tokenUsage, message.usage, message.provider, message.model);
  const hasToolCalls = (mapped.toolCalls?.length ?? 0) > 0;
  // 无工具的助手回复视为终稿推进：跳过未完成中间步，进入 deliver
  if (task.executionMode !== 'plan' && !hasToolCalls && !mapped.failure) {
    advancePlanAfterFinalAnswer(task);
  }
  saveTask(task);
  publish({ type: 'message', taskId: task.id, message: mapped });
  publish({ type: 'token_usage', taskId: task.id, usage: task.tokenUsage });

  writePiTrace(task, 'llm', {
    ok: !mapped.failure,
    finishReason: hasToolCalls ? 'tool_use' : mapped.failure ? 'error' : 'stop',
    tokenUsage: task.tokenUsage,
    summary: hasToolCalls
      ? `LLM 请求 ${mapped.toolCalls!.length} 个工具`
      : `LLM 生成 ${mapped.content.length} 字符回复`,
    data: { contentLength: mapped.content.length, toolCallCount: mapped.toolCalls?.length ?? 0 },
  });
}

function appendToolResult(task: Task, callId: string, toolName: string, result: unknown, isError: boolean, workspaceDir: string): void {
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
  saveTask(task);
  publish({ type: 'tool_result', taskId: task.id, result: toolResult });
  publish({ type: 'message', taskId: task.id, message });
  writePiTrace(task, 'tool_result', {
    ok: !isError,
    callId,
    toolName,
    errorMessage: isError ? toolResult.error : undefined,
    summary: isError ? `工具 ${toolName} 执行失败` : `工具 ${toolName} 执行成功`,
    data: { output: toolResult.output },
  });

  // attach_content：提取 contentBlock 并挂到「发起该 tool_call 的 assistant」消息。
  // 禁止回退挂到 tool 消息 id——前端交付面只渲染 assistant，挂错会导致文件卡丢归属/反复出现在 live tail。
  if (!isError && toolName === 'attach_content') {
    const raw = extractAttachContentBlock(result, details);
    if (isRecord(raw) && typeof raw.type === 'string') {
      const block = buildContentBlockFromTool(raw, workspaceDir);
      if (block) {
        let assistantMessageId: string | undefined;
        for (let i = task.messages.length - 1; i >= 0; i--) {
          const msg = task.messages[i];
          if (msg.role === 'assistant' && msg.toolCalls?.some((tc) => tc.id === callId)) {
            msg.contentBlocks = [...(msg.contentBlocks ?? []), block];
            assistantMessageId = msg.id;
            break;
          }
        }
        if (assistantMessageId) {
          saveTask(task);
          publish({ type: 'content_blocks_added', taskId: task.id, messageId: assistantMessageId, blocks: [block] });
        }
      }
    }
  }
}

function maybeCreateToolCheckpoint(task: Task, callId: string, toolName: string): void {
  if (task.plan.length < 2) return;
  if ((task.checkpoints ?? []).some((checkpoint) => isRecord(checkpoint.data) && checkpoint.data.callId === callId)) return;
  const checkpoint = createCheckpoint({
    label: `工具 ${toolName} 已完成`,
    stepId: planStepIdForToolCall(task, callId) ?? currentPlanStepId(task),
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
  if (typeof raw.content !== 'string') return null;
  if (type !== 'file_reference' && type !== 'image' && type !== 'link') return null;

  let resolvedContent = String(raw.content);
  const isFile = type === 'file_reference' || type === 'image';
  if (isFile && resolvedContent.length > 0 && !resolvedContent.startsWith('/') && !resolvedContent.startsWith('~')) {
    resolvedContent = join(workspaceDir, resolvedContent);
  }
  return {
    id: randomUUID(),
    type: type as ContentBlock['type'],
    content: resolvedContent,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : undefined,
    size: typeof raw.size === 'number' ? raw.size : undefined,
  };
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
        planStepId: planStepIdForToolCall(task, block.id),
      },
    }));
  return {
    id: randomUUID(),
    role: 'assistant',
    content: piContentToText(message.content.filter((block) => block.type === 'text')),
    createdAt: new Date(message.timestamp).toISOString(),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    failure: message.errorMessage
      ? { message: message.errorMessage, category: message.stopReason === 'aborted' ? 'cancelled' : 'model' }
      : undefined,
  };
}

async function toPiMessages(messages: Message[], model: PiModel<any>): Promise<PiMessage[]> {
  const toolNamesByCallId = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      toolNamesByCallId.set(call.id, call.function.name);
    }
  }
  const converted: PiMessage[] = [];
  for (const message of messages) {
    converted.push(...await toPiMessage(message, toolNamesByCallId, model));
  }
  return converted;
}

async function toPiMessage(message: Message, toolNamesByCallId: Map<string, string>, model: PiModel<any>): Promise<PiMessage[]> {
  const timestamp = new Date(message.createdAt).getTime();
  if (message.role === 'user') {
    return [{
      role: 'user',
      content: await userMessageContentToPi(message, model),
      timestamp,
    }];
  }
  if (message.role === 'assistant') {
    return [{
      role: 'assistant',
      content: [
        ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
        ...(message.toolCalls ?? []).map((call) => ({
          type: 'toolCall' as const,
          id: call.id,
          name: call.function.name,
          arguments: parseToolArguments(call.function.arguments),
        })),
      ],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyPiUsage(),
      stopReason: message.failure ? 'error' : (message.toolCalls?.length ? 'toolUse' : 'stop'),
      errorMessage: message.failure?.message,
      timestamp,
    }];
  }
  if (message.role === 'tool' && message.toolCallId) {
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
    planStepId: currentPlanStepId(task),
  };
}

function currentPlanStepId(task: Task): string | undefined {
  return task.plan.find((step) => step.status === 'running')?.id ?? task.plan[0]?.id;
}

function planStepIdForToolCall(task: Task, callId: string): string | undefined {
  void callId;
  return currentPlanStepId(task);
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
  // 引擎上传目录：落盘后的图片附件可读（read 工具 externalPaths）
  const uploadDir = join(config.workspaceDir, '.aurevoy-uploads');
  return [...new Set([...paths, uploadDir].filter((p) => p && !p.startsWith('memory://')))];
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
  publish({ type: 'done', taskId: task.id, status: 'completed' });
  writePiTrace(task, 'done', { ok: true, summary: '任务完成' });
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
  publish({ type: 'done', taskId: task.id, status: 'paused' });
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
}

function finishCancelled(task: Task): void {
  failOpenPlanSteps(task);
  setTaskState(task, 'cancelled', 'cancelled');
  saveTask(task);
  publish({ type: 'status', taskId: task.id, status: 'cancelled' });
  publish({ type: 'phase', taskId: task.id, phase: 'cancelled', detail: '用户取消任务' });
  publish({ type: 'done', taskId: task.id, status: 'cancelled' });
  writePiTrace(task, 'done', { ok: false, summary: '任务被取消' });
}

function finishFailed(task: Task, err: unknown, errorCategory: TaskErrorCategory = 'unknown'): void {
  const message = err instanceof Error ? err.message : String(err);
  const failureMessage: Message = {
    id: randomUUID(),
    role: 'assistant',
    content: `任务失败：${message}`,
    failure: { message, category: errorCategory },
    createdAt: new Date().toISOString(),
  };
  failOpenPlanSteps(task);
  setTaskState(task, 'failed', 'failed');
  task.messages.push(failureMessage);
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
  publish({ type: 'message', taskId: task.id, message: failureMessage });
  publish({ type: 'error', taskId: task.id, message });
  publish({ type: 'done', taskId: task.id, status: 'failed' });
}

function saveTask(task: Task): void {
  taskStore.save(task);
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

// ---- Cache-aware Pi 消息压缩（零成本 Snip + Microcompact） ----

/**
 * 从 PiMessage[] 中提取 toolCallId → toolName 映射。
 */
function buildPiToolNameMap(messages: PiMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (isRecord(block) && block.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string') {
          map.set(block.id, block.name);
        }
      }
    }
  }
  return map;
}

/**
 * 从 PiMessage 的 content 数组中提取纯文本。
 */
function piMessageText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') return block.text;
    return '';
  }).join('');
}

/**
 * Snip：移除空/无意义的 toolResult 消息及其配对的 assistant。
 * 整表确定性重放，保证多轮 append 时前缀字节稳定。
 */
function snipPiToolResults(messages: PiMessage[]): PiMessage[] {
  const toolNameMap = buildPiToolNameMap(messages);

  const snipToolResultIndices = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'toolResult') continue;
    const toolName = msg.toolName ?? toolNameMap.get(msg.toolCallId ?? '');
    if (toolName && TOOLS_KEEP_VERBATIM.has(toolName)) continue;

    const text = piMessageText(msg.content).trim();
    if (!text || text === '{}' || text === '{"ok":true}' || text === 'null' || text === 'undefined') {
      snipToolResultIndices.add(i);
    }
  }

  if (snipToolResultIndices.size === 0) return messages;

  // 如果某 assistant 的所有 toolCall 结果都被 snip，也移除该 assistant
  const snipAssistantIndices = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    const callIds: string[] = [];
    for (const block of msg.content) {
      if (isRecord(block) && block.type === 'toolCall' && typeof block.id === 'string') {
        callIds.push(block.id);
      }
    }
    if (callIds.length === 0) continue;

    const callIdSet = new Set(callIds);
    let allSnipped = true;
    let anyFound = false;
    for (let j = i + 1; j < messages.length; j++) {
      const tr = messages[j];
      if (tr.role !== 'toolResult') break;
      if (tr.toolCallId && callIdSet.has(tr.toolCallId)) {
        anyFound = true;
        if (!snipToolResultIndices.has(j)) {
          allSnipped = false;
          break;
        }
      }
    }
    if (anyFound && allSnipped) {
      snipAssistantIndices.add(i);
    }
  }

  const remove = new Set([...snipToolResultIndices, ...snipAssistantIndices]);
  return messages.filter((_, i) => !remove.has(i));
}

/**
 * Microcompact：对大输出工具的 toolResult 做结构化压缩（整表确定性重放）。
 */
function microcompactPiToolResults(messages: PiMessage[]): PiMessage[] {
  let changed = false;
  const result = messages.map((msg) => {
    if (msg.role !== 'toolResult') return msg;
    const toolName = msg.toolName ?? '';
    if (!TOOLS_WITH_LARGE_OUTPUT.has(toolName)) return msg;

    const text = piMessageText(msg.content);
    if (!text || text.includes('"_compacted":true') || text.includes('"_compacted": true')) return msg;

    const compacted = compactToolResult(toolName, text);
    if (compacted === null || compacted === text) return msg;

    changed = true;
    return {
      ...msg,
      content: [{ type: 'text' as const, text: compacted }],
    };
  });

  return changed ? result : messages;
}

/**
 * Cache-aware 零成本压缩：对整表确定性 Snip + Microcompact。
 * 会话消息始终是原文；每轮重放后，仅追加新尾部时前缀字节与上一轮一致。
 * 导出供单元测试验证多轮前缀稳定性。
 */
export function compactPiMessagesCacheAware(messages: PiMessage[]): PiMessage[] {
  const afterSnip = snipPiToolResults(messages);
  return microcompactPiToolResults(afterSnip);
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
