import { promises as fs } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  runAgentLoopContinue,
  type AgentContext as PiAgentContext,
  type AgentEvent as PiAgentEvent,
  type AgentLoopConfig as PiAgentLoopConfig,
  type AgentMessage,
  type AgentTool,
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
  buildSkillCatalogMessage,
  buildSystemContextMessage,
  buildToolGuidanceMessage,
  totalTokens,
} from './context.js';
import { createCheckpoint, createClarification, effectiveBudget, initialBudgetUsage, resolveClarification, updateWallTime } from './m6-state.js';
import { waitForPiApproval } from './pi-approval.js';
import { assertPiLLMConfigured, createPiModel } from '../llm/pi-provider.js';
import { decideToolPermission } from './approval.js';

interface PiRuntimeOptions {
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
const budgetStopReasons = new Map<string, string>();
const invalidPiToolCallErrors = new Map<string, Map<string, string>>();
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
  private steeringQueue: Message[] = [];
  private followUpQueue: Message[] = [];

  constructor(
    private readonly modelForNextTurn: () => PiModel<any>,
  ) {}

  enqueueSteering(message: Message): void {
    this.steeringQueue.push(message);
  }

  enqueueFollowUp(message: Message): void {
    this.followUpQueue.push(message);
  }

  async drainSteering(): Promise<AgentMessage[]> {
    return await this.drainOne(this.steeringQueue);
  }

  async drainFollowUp(): Promise<AgentMessage[]> {
    return await this.drainOne(this.followUpQueue);
  }

  private async drainOne(queue: Message[]): Promise<AgentMessage[]> {
    const next = queue.shift();
    if (!next) return [];
    return [await toPiUserMessage(next, this.modelForNextTurn())];
  }
}

export function steerPiTask(taskId: string, message: Message): boolean {
  const controller = activePiControllers.get(taskId);
  if (!controller) return false;
  controller.enqueueSteering(message);
  return true;
}

export function followUpPiTask(taskId: string, message: Message): boolean {
  const controller = activePiControllers.get(taskId);
  if (!controller) return false;
  controller.enqueueFollowUp(message);
  return true;
}

export function resolvePiClarificationAnswer(taskId: string, clarificationId: string, answer: string): boolean {
  const byTask = pendingClarificationResolvers.get(taskId);
  const resolve = byTask?.get(clarificationId);
  if (!resolve) return false;
  byTask!.delete(clarificationId);
  if (byTask!.size === 0) pendingClarificationResolvers.delete(taskId);
  resolve(answer);
  return true;
}

export async function runPiTask(task: Task, options: PiRuntimeOptions): Promise<void> {
  task.pendingApprovals = [];
  task.budgetUsage = task.budgetUsage ?? initialBudgetUsage();
  setTaskState(task, 'running', 'initializing');
  updateContextSnapshot(task);
  saveTask(task);
  publish({ type: 'status', taskId: task.id, status: 'running' });
  publish({ type: 'phase', taskId: task.id, phase: 'initializing', detail: '准备 Agent runtime' });
  publish({ type: 'context_snapshot', taskId: task.id, tokens: task.contextTokens ?? 0 });
  await publishScoutReport(task, options.workspaceDir);

  try {
    assertPiLLMConfigured();
    const selectedModel = selectPiModelForTask(task);
    assertPiModelSupportsAttachments(task, selectedModel);
    const controller = new ActivePiTaskController(() => selectPiModelForTask(task));
    const context: PiAgentContext = {
      systemPrompt: await buildPiSystemPrompt(task, options.workspaceDir),
      tools: createPiTools(task, options),
      messages: await toPiMessages(task.messages, selectedModel),
    };
    const initialThinkingLevel = runtimeThinkingLevel();
    const loopConfig: PiAgentLoopConfig = {
      model: selectedModel,
      reasoning: initialThinkingLevel === 'off' ? undefined : initialThinkingLevel,
      getApiKey: () => config.llm.apiKey,
      toolExecution: runtimeToolExecution(),
      convertToLlm: (messages) => messages.filter((message): message is PiMessage =>
        message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult',
      ),
      prepareNextTurn: async () => {
        const model = selectPiModelForTask(task);
        assertPiModelSupportsAttachments(task, model);
        const thinkingLevel = runtimeThinkingLevel();
        return {
          model,
          ...(thinkingLevel === 'off' ? {} : { thinkingLevel }),
        };
      },
      beforeToolCall: async ({ toolCall, args }, signal) => {
        const call = toAurevoyToolCall(task, toolCall.id, toolCall.name, args);
        return await gatePiToolCall(task, call, signal ?? options.signal);
      },
      getSteeringMessages: async () => await controller.drainSteering(),
      getFollowUpMessages: async () => await controller.drainFollowUp(),
      shouldStopAfterTurn: async () => shouldStopAfterTurn(task, options.taskStartedAtMs),
    };

    publish({ type: 'phase', taskId: task.id, phase: 'thinking', detail: 'Agent 正在思考' });
    const abortPromise = new Promise<never>((_, reject) => {
      if (options.signal.aborted) return reject(new Error('cancelled'));
      options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
    activePiControllers.set(task.id, controller);
    try {
      await Promise.race([
        runAgentLoopContinue(
          context,
          loopConfig,
          async (event) => {
            await handlePiEvent(task, event, options.signal, options.taskStartedAtMs, options.workspaceDir);
          },
          options.signal,
        ),
        abortPromise,
      ]);
    } finally {
      activePiControllers.delete(task.id);
      invalidPiToolCallErrors.delete(task.id);
    }

    if (options.signal.aborted) {
      finishCancelled(task);
      return;
    }
    const budgetStopReason = budgetStopReasons.get(task.id);
    if (budgetStopReason) {
      budgetStopReasons.delete(task.id);
      finishFailed(task, new Error(`预算超限：${budgetStopReason}`), 'timeout');
      return;
    }
    finishCompleted(task);
  } catch (err) {
    if (options.signal.aborted) {
      finishCancelled(task);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const isConfigError =
      message.includes('未配置 LLM') ||
      message.includes('未支持的 Provider') ||
      message.includes('AUREVOY_LLM_API_KEY');
    finishFailed(task, err, isConfigError ? 'configuration' : 'unknown');
  }
}

async function toPiUserMessage(message: Message, model: PiModel<any>): Promise<AgentMessage> {
  return {
    role: 'user',
    content: await userMessageContentToPi(message, model),
    timestamp: new Date(message.createdAt).getTime(),
  };
}

function shouldStopAfterTurn(task: Task, taskStartedAtMs: number): boolean {
  task.budgetUsage = task.budgetUsage ?? initialBudgetUsage();
  updateWallTime(task, taskStartedAtMs);
  const usage = task.budgetUsage;
  const budget = effectiveBudget(task);
  const reason =
    usage.iterations >= budget.maxIterations ? `达到最大轮次 ${budget.maxIterations}` :
    usage.toolCalls >= budget.maxToolCalls ? `达到最大工具调用数 ${budget.maxToolCalls}` :
    usage.wallTimeMs >= budget.maxWallTimeMs ? `达到最大运行时间 ${budget.maxWallTimeMs}ms` :
    usage.outputBytes >= budget.maxOutputBytes ? `达到最大输出字节数 ${budget.maxOutputBytes}` :
    null;
  if (!reason) return false;

  budgetStopReasons.set(task.id, reason);
  saveTask(task);
  publish({ type: 'budget_usage', taskId: task.id, usage, budget: task.budget });
  writePiTrace(task, 'phase', {
    ok: true,
    phase: task.phase,
    summary: `本轮结束后主动停步：${reason}`,
    data: { usage, budget },
  });
  return true;
}

async function publishScoutReport(task: Task, workspaceDir: string): Promise<void> {
  const startedAt = Date.now();
  publish({ type: 'scout_started', taskId: task.id });
  const keyFiles = await findScoutKeyFiles(workspaceDir);
  const techStack = await inferScoutTechStack(workspaceDir);
  const report: ScoutReport = {
    keyFiles,
    techStack,
    constraints: [
      '跨进程契约必须以 packages/shared/src 为唯一来源',
      '外部能力不可用时必须明确失败或降级，不伪造成功',
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
  const candidates = [
    ['AGENTS.md', '协作规则和项目入口说明'],
    ['README.md', '项目简介和本地运行说明'],
    ['package.json', 'Node workspace 脚本和依赖'],
    ['docs/ARCHITECTURE.md', '系统架构与模块职责'],
    ['docs/API.md', 'HTTP/SSE 契约说明'],
    ['docs/UI_DESIGN.md', '前端交互与信息架构'],
    ['packages/shared/src/index.ts', '前后端共享类型契约'],
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
  const projectInfo = task.projectId ? projectStore.get(task.projectId) : undefined;
  const messages = [
    {
      content: [
        'You are Aurevoy, a personal AI agent desktop runtime.',
        'Use tools to inspect and change the local workspace when needed.',
        'Do not claim completed work unless the tool results support it.',
      ].join('\n'),
    },
    buildSystemContextMessage(
      workspaceDir,
      undefined,
      projectInfo ? { name: projectInfo.name, path: projectInfo.path } : undefined,
    ),
    buildToolGuidanceMessage(),
    buildSkillCatalogMessage(),
    await buildAttachmentContextMessage(task),
  ].filter((message): message is { content: string } => !!message?.content);
  return messages.map((message) => message.content).join('\n\n');
}

function selectPiModelForTask(task: Task): PiModel<any> {
  const hasImageAttachment = task.messages.some((message) =>
    message.attachments?.some((attachment) => attachment.type === 'image'),
  );
  return createPiModel(hasImageAttachment && config.llm.visionModel ? config.llm.visionModel : undefined);
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
  if (imageAttachments.length === 0) return message.content;

  const content: Array<PiTextContent | PiImageContent> = [{ type: 'text', text: message.content }];
  for (const attachment of imageAttachments) {
    if (!model.input?.includes('image')) {
      throw new Error(`模型 ${model.provider}:${model.id} 不支持图片附件：${attachment.name}`);
    }
    content.push({
      type: 'text',
      text: `[Attached image: ${attachment.name}, mime: ${attachment.mimeType}, path: ${attachment.path}]`,
    });
    content.push(await imageAttachmentToPiContent(attachment));
  }
  return content;
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

function createPiTools(task: Task, options: PiRuntimeOptions): AgentTool[] {
  // 初始化统一工具框架（如果尚未初始化）
  initializeUnifiedToolFramework();

  // 获取所有可用工具，并注入带任务上下文的执行器
  return withPiCompatibilityAliases(getAgentToolsForPi()).map((agentTool) => {
    const executionToolName = executionToolNameForPiTool(agentTool.name);
    const def = unifiedToolRegistry.get(executionToolName)!;
    return {
      ...agentTool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        const rawValidationError = consumeInvalidPiToolCallError(task.id, toolCallId);
        if (rawValidationError) {
          throw new Error(rawValidationError);
        }
        if (agentTool.name === 'ask_user') {
          const result = await executeAskUserTool(task, toolCallId, params, signal ?? options.signal);
          return {
            content: [{ type: 'text', text: formatUnknown(result) }],
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
                  content: [{ type: 'text', text: message }],
                  details: event,
                });
              }
            }
          },
        });

        try {
          const result = await def.execute(executionParams as Record<string, unknown>, context);
          return {
            content: [{ type: 'text', text: formatUnknown(result) }],
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

async function executeAskUserTool(
  task: Task,
  callId: string,
  params: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const args = isRecord(params) ? params : {};
  const question = typeof args.question === 'string' ? args.question : '请补充完成任务所需的信息。';
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
  const validationError = validatePiToolCallInput(call);
  if (validationError) {
    const message = `schema_validation_failed: ${validationError}`;
    appendToolResult(task, call.id, call.toolName, { error: message }, true, '');
    return { block: true, reason: message };
  }

  const riskLevel = unifiedToolRegistry.riskLevelOf(call.toolName);
  const permission = decideToolPermission(
    {
      autoModeLevel: config.autoMode.level as 'auto' | 'plan',
      autoModePaused: !!task.autoModeState?.paused,
    },
    call.toolName,
    riskLevel,
  );
  if (permission.allowed) {
    return undefined;
  }

  task.pendingApprovals = [
    ...(task.pendingApprovals ?? []),
    { call, riskLevel, createdAt: new Date().toISOString() },
  ];
  setTaskState(task, 'paused', 'waiting_approval');
  saveTask(task);
  publish({ type: 'phase', taskId: task.id, phase: 'waiting_approval', detail: `等待审批工具 ${call.toolName}` });
  publish({ type: 'approval_request', taskId: task.id, call, riskLevel });

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
    data: { approved: decision.approved },
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
      task.budgetUsage = task.budgetUsage ?? initialBudgetUsage();
      task.budgetUsage.toolCalls += 1;
      saveTask(task);
      {
        const rawCall = toAurevoyToolCall(task, event.toolCallId, event.toolName, event.args);
        const validationError = validatePiToolCallInput(rawCall);
        if (validationError) {
          rememberInvalidPiToolCall(task.id, event.toolCallId, `schema_validation_failed: ${validationError}`);
        }
      }
      publish({ type: 'phase', taskId: task.id, phase: 'calling_tool', detail: `调用工具 ${event.toolName}` });
      publish({ type: 'tool_call', taskId: task.id, call: toAurevoyToolCall(task, event.toolCallId, event.toolName, event.args) });
      writePiTrace(task, 'tool_call', {
        ok: true,
        callId: event.toolCallId,
        toolName: event.toolName,
        riskLevel: unifiedToolRegistry.riskLevelOf(event.toolName),
        summary: `调用工具 ${event.toolName}`,
        data: { args: event.args },
      });
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
      task.budgetUsage = task.budgetUsage ?? initialBudgetUsage();
      task.budgetUsage.iterations += 1;
      updateWallTime(task, taskStartedAtMs);
      updateContextSnapshot(task);
      saveTask(task);
      publish({ type: 'budget_usage', taskId: task.id, usage: task.budgetUsage, budget: task.budget });
      publish({ type: 'context_snapshot', taskId: task.id, tokens: task.contextTokens ?? 0 });
      break;
    case 'agent_end':
      break;
  }
}

function runtimeThinkingLevel(): AgentThinkingLevel {
  return config.agent.thinkingLevel;
}

function runtimeToolExecution(): AgentToolExecutionMode {
  return config.agent.toolExecution;
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
  }
}

function addOutputBytes(task: Task, delta: string): void {
  task.budgetUsage = task.budgetUsage ?? initialBudgetUsage();
  task.budgetUsage.outputBytes += Buffer.byteLength(delta, 'utf8');
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
  saveTask(task);
  publish({ type: 'message', taskId: task.id, message: mapped });
  publish({ type: 'token_usage', taskId: task.id, usage: task.tokenUsage });

  const hasToolCalls = (mapped.toolCalls?.length ?? 0) > 0;
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

  // 当 attach_content 工具成功返回时，提取 contentBlock 并推送给前端。
  // Pi runtime 会把工具原始返回值放到 AgentToolResult.details，不能只看最外层 result。
  if (!isError && toolName === 'attach_content') {
    const raw = extractAttachContentBlock(result, details);
    if (isRecord(raw) && typeof raw.type === 'string' && typeof raw.content === 'string') {
      let resolvedContent = String(raw.content);
      const blockType = (raw.type as string) === 'file_reference' || (raw.type as string) === 'image'
        ? 'file' : 'url';
      if (blockType === 'file' && resolvedContent.length > 0 && !resolvedContent.startsWith('/') && !resolvedContent.startsWith('~')) {
        resolvedContent = join(workspaceDir, resolvedContent);
      }
      const block: ContentBlock = {
        id: randomUUID(),
        type: raw.type as ContentBlock['type'],
        content: resolvedContent,
        name: typeof raw.name === 'string' ? raw.name : undefined,
        mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : undefined,
        size: typeof raw.size === 'number' ? raw.size : undefined,
      };
      // 找到发起该工具调用的 assistant 消息，将内容块挂载上去
      let assistantMessageId: string | undefined;
      for (let i = task.messages.length - 1; i >= 0; i--) {
        const msg = task.messages[i];
        if (msg.role === 'assistant' && msg.toolCalls?.some((tc) => tc.id === callId)) {
          msg.contentBlocks = [...(msg.contentBlocks ?? []), block];
          assistantMessageId = msg.id;
          break;
        }
      }
      saveTask(task);
      publish({ type: 'content_blocks_added', taskId: task.id, messageId: assistantMessageId ?? message.id, blocks: [block] });
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
  usage: PiUsage | null | undefined,
  provider: string,
  model: string,
): AggregatedTokenUsage {
  const normalized = normalizePiUsage(usage);
  if (!normalized) {
    return {
      ...(current ?? {}),
      available: current?.available ?? false,
      provider,
      model,
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    available: true,
    provider,
    model,
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

function normalizePiUsage(usage: PiUsage | null | undefined): Required<Pick<
  AggregatedTokenUsage,
  'promptTokens' | 'completionTokens' | 'totalTokens' | 'reasoningTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'estimatedCostUsd'
>> | null {
  if (!usage) return null;
  const input = safeUsageNumber(usage.input);
  const output = safeUsageNumber(usage.output);
  const cacheRead = safeUsageNumber(usage.cacheRead);
  const cacheWrite = safeUsageNumber(usage.cacheWrite);
  const total = safeUsageNumber(usage.totalTokens) || input + output + cacheRead + cacheWrite;
  const reasoning = safeUsageNumber(usage.reasoning);
  const cost = safeUsageNumber(usage.cost?.total);
  if (total <= 0 && input <= 0 && output <= 0 && cacheRead <= 0 && cacheWrite <= 0 && reasoning <= 0 && cost <= 0) {
    return null;
  }
  return {
    promptTokens: input + cacheRead + cacheWrite,
    completionTokens: output,
    totalTokens: total,
    reasoningTokens: reasoning,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    estimatedCostUsd: cost,
  };
}

function safeUsageNumber(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

async function buildAttachmentContextMessage(task: Task): Promise<{ content: string } | null> {
  const lastMessage = [...task.messages]
    .reverse()
    .find((message) => message.role === 'user' && message.attachments?.length);
  if (!lastMessage?.attachments?.length) return null;

  const lines = ['[Attached Files]', ''];
  for (const attachment of lastMessage.attachments) {
    if (attachment.type === 'image') continue;
    lines.push(await formatAttachment(attachment));
  }
  return { content: lines.join('\n') };
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
  // Pi runtime 可能把错误包装成 AgentToolResult，错误文本在 content 数组里
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
  return task.messages.flatMap((message) => message.attachments?.map((attachment) => attachment.path) ?? []);
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
  setTaskState(task, 'completed', 'finalizing');
  saveTask(task);
  publish({ type: 'status', taskId: task.id, status: 'completed' });
  publish({ type: 'phase', taskId: task.id, phase: 'finalizing', detail: '任务完成' });
  publish({ type: 'done', taskId: task.id, status: 'completed' });
  writePiTrace(task, 'done', { ok: true, summary: '任务完成' });
}

function finishCancelled(task: Task): void {
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
