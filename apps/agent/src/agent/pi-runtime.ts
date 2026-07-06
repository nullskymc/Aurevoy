import { promises as fs } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Agent, type AgentEvent as PiAgentEvent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import {
  type AssistantMessageEvent as PiAssistantMessageEvent,
  type AssistantMessage as PiAssistantMessage,
  type Message as PiMessage,
  type Model as PiModel,
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
import { unifiedToolRegistry } from '../tool/unified-registry.js';
import { initializeUnifiedToolFramework, getAgentToolsForPi, createToolContext } from '../tool/index.js';
import {
  buildSkillCatalogMessage,
  buildSystemContextMessage,
  buildToolGuidanceMessage,
  totalTokens,
} from './context.js';
import { effectiveBudget, initialBudgetUsage, updateWallTime } from './m6-state.js';
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
const activePiAgents = new Map<string, Agent>();

export function steerPiTask(taskId: string, message: Message): boolean {
  const agent = activePiAgents.get(taskId);
  if (!agent) return false;
  agent.steer(toPiUserMessage(message));
  return true;
}

export function followUpPiTask(taskId: string, message: Message): boolean {
  const agent = activePiAgents.get(taskId);
  if (!agent) return false;
  agent.followUp(toPiUserMessage(message));
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
    const model = createPiModel();
    const agent = new Agent({
      initialState: {
        systemPrompt: await buildPiSystemPrompt(task, options.workspaceDir),
        model,
        thinkingLevel: runtimeThinkingLevel(),
        tools: createPiTools(task, options),
        messages: toPiMessages(task.messages, model),
      },
      getApiKey: () => config.llm.apiKey,
      toolExecution: runtimeToolExecution(),
      prepareNextTurnWithContext: async () => ({
        model: createPiModel(),
        thinkingLevel: runtimeThinkingLevel(),
      }),
      beforeToolCall: async ({ toolCall, args }, signal) => {
        const call = toAurevoyToolCall(task, toolCall.id, toolCall.name, args);
        return await gatePiToolCall(task, call, signal ?? options.signal);
      },
    });
    installShouldStopAfterTurn(agent, task, options.taskStartedAtMs);

    agent.subscribe(async (event, signal) => {
      await handlePiEvent(task, event, signal, options.taskStartedAtMs);
    });

    publish({ type: 'phase', taskId: task.id, phase: 'thinking', detail: 'Agent 正在思考' });
    const abortPromise = new Promise<never>((_, reject) => {
      if (options.signal.aborted) return reject(new Error('cancelled'));
      options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
    activePiAgents.set(task.id, agent);
    try {
      await Promise.race([agent.continue(), abortPromise]);
    } finally {
      activePiAgents.delete(task.id);
    }

    if (options.signal.aborted) {
      finishCancelled(task);
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

function toPiUserMessage(message: Message): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: message.content }],
    timestamp: new Date(message.createdAt).getTime(),
  };
}

function installShouldStopAfterTurn(agent: Agent, task: Task, taskStartedAtMs: number): void {
  const rawAgent = agent as unknown as {
    createLoopConfig?: (options?: unknown) => Record<string, unknown>;
  };
  const original = rawAgent.createLoopConfig?.bind(agent);
  if (!original) return;

  rawAgent.createLoopConfig = (options?: unknown) => {
    const loopConfig = original(options);
    return {
      ...loopConfig,
      shouldStopAfterTurn: async () => shouldStopAfterTurn(task, taskStartedAtMs),
    };
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

function createPiTools(task: Task, options: PiRuntimeOptions): AgentTool[] {
  // 初始化统一工具框架（如果尚未初始化）
  initializeUnifiedToolFramework();

  // 获取所有可用工具，并注入带任务上下文的执行器
  return getAgentToolsForPi().map((agentTool) => {
    const def = unifiedToolRegistry.get(agentTool.name)!;
    return {
      ...agentTool,
      execute: async (toolCallId, params, signal, onUpdate) => {
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
          const result = await def.execute(params as Record<string, unknown>, context);
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

async function gatePiToolCall(
  task: Task,
  call: ToolCall,
  signal: AbortSignal,
): Promise<{ block?: boolean; reason?: string } | undefined> {
  const riskLevel = unifiedToolRegistry.riskLevelOf(call.toolName);
  const permission = decideToolPermission(
    {
      autoModeLevel: config.autoMode.level as 'off' | 'plan' | 'auto-edit' | 'full',
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

async function handlePiEvent(
  task: Task,
  event: PiAgentEvent,
  signal: AbortSignal,
  taskStartedAtMs: number,
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
      appendToolResult(task, event.toolCallId, event.toolName, event.result, event.isError);
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
  } else if (event.type === 'thinking_delta') {
    addOutputBytes(task, event.delta);
    publish({ type: 'reasoning', taskId: task.id, delta: event.delta });
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

function appendToolResult(task: Task, callId: string, toolName: string, result: unknown, isError: boolean): void {
  const details = isRecord(result) && 'details' in result ? result.details : result;
  const toolResult: ToolResult = isError
    ? { callId, ok: false, error: extractToolErrorMessage(result, details) }
    : { callId, ok: true, output: details };
  const message: Message = {
    id: randomUUID(),
    role: 'tool',
    content: isError
      ? JSON.stringify({ error: toolResult.error || '工具执行失败' })
      : formatUnknown(toolResult.output),
    toolCallId: callId,
    createdAt: new Date().toISOString(),
  };
  task.messages.push(message);
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
      const block: ContentBlock = {
        id: randomUUID(),
        type: raw.type as ContentBlock['type'],
        content: raw.content,
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
  const reasoningContent = message.content
    .filter((block) => block.type === 'thinking')
    .map((block) => block.thinking)
    .join('');
  return {
    id: randomUUID(),
    role: 'assistant',
    content: piContentToText(message.content.filter((block) => block.type !== 'toolCall')),
    createdAt: new Date(message.timestamp).toISOString(),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    reasoningContent: reasoningContent || undefined,
    failure: message.errorMessage
      ? { message: message.errorMessage, category: message.stopReason === 'aborted' ? 'cancelled' : 'model' }
      : undefined,
  };
}

function toPiMessages(messages: Message[], model: PiModel<any>): PiMessage[] {
  const toolNamesByCallId = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      toolNamesByCallId.set(call.id, call.function.name);
    }
  }
  return messages.flatMap((message) => toPiMessage(message, toolNamesByCallId, model));
}

function toPiMessage(message: Message, toolNamesByCallId: Map<string, string>, model: PiModel<any>): PiMessage[] {
  const timestamp = new Date(message.createdAt).getTime();
  if (message.role === 'user') {
    return [{
      role: 'user',
      content: [{ type: 'text', text: message.content }],
      timestamp,
    }];
  }
  if (message.role === 'assistant') {
    const thinkingBlock = message.reasoningContent
      ? [{
          type: 'thinking' as const,
          thinking: message.reasoningContent,
          thinkingSignature: reasoningReplayFieldForModel(model),
        }]
      : [];
    return [{
      role: 'assistant',
      content: [
        ...thinkingBlock,
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

function reasoningReplayFieldForModel(model: PiModel<any>): 'reasoning_content' | undefined {
  if (model.api !== 'openai-completions') return undefined;
  const compat = isRecord(model.compat) ? model.compat : {};
  // 同时检查 model 级别的 provider 和用户配置的 provider，避免 Pi SDK builtin model 缺失 compat 信息
  const configuredProvider = config.llm.provider?.toLowerCase() ?? '';
  const isDeepSeek =
    model.provider === 'deepseek' ||
    configuredProvider === 'deepseek' ||
    compat.thinkingFormat === 'deepseek';
  const isQwen =
    model.provider === 'qwen' ||
    configuredProvider === 'qwen' ||
    compat.thinkingFormat === 'qwen' ||
    compat.thinkingFormat === 'qwen-chat-template';
  if (
    compat.requiresReasoningContentOnAssistantMessages === true ||
    isDeepSeek ||
    isQwen ||
    model.provider === 'openai-compatible'
  ) {
    return 'reasoning_content';
  }
  return undefined;
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
    if (isRecord(block) && block.type === 'thinking' && typeof block.thinking === 'string') return block.thinking;
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
