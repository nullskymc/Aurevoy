import { randomUUID } from 'node:crypto';
import {
  AgentHarness,
  InMemorySessionRepo,
  type AgentEvent,
  type AgentTool,
} from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import type {
  AutoModeLevel,
  SubagentStopReason,
  Task,
  TaskErrorCategory,
} from '@aurevoy/shared';
import { config } from '../config.js';
import { createTaskLogger, type TaskLogger } from '../logging/trace.js';
import { createPiModel } from '../llm/pi-provider.js';
import {
  unifiedToolRegistry,
  validateToolInputSchema,
  type UnifiedToolContext,
} from '../tool/unified-registry.js';
import { createAurevoyPiModels } from './pi-harness.js';
import {
  approvalConfigFromTask,
  decideToolPermission,
  type ApprovalConfig,
} from './approval.js';
import { SubagentConcurrencyLimiter } from './subagent-limiter.js';
import {
  DEFAULT_SUBAGENT_ROLE,
  getSubagentProfile,
  resolveSubagentTools,
  type SubagentRole,
} from './subagent-profiles.js';

const subagentLimiter = new SubagentConcurrencyLimiter(
  () => config.agent.subagentMaxConcurrency,
);

export interface SubTaskProgress {
  runId: string;
  phase: 'queued' | 'running' | 'tool_started' | 'tool_completed' | 'completed';
  message: string;
  iteration?: number;
  toolCallId?: string;
  toolName?: string;
  toolStatus?: 'completed' | 'failed';
  toolDurationMs?: number;
  error?: string;
}

export interface SubTask {
  goal: string;
  prompt: string;
  /** 子代理角色；决定默认工具面与 system prompt */
  role?: SubagentRole;
  /** 显式工具白名单（若提供则覆盖角色默认集） */
  allowedTools?: string[];
  workspaceDir: string;
  /** 父任务权限配置。子代理继承父代理 auto/plan 与 paused/planApproved。 */
  approvalConfig?: ApprovalConfig;
  /** 父任务快照，用于权限、工具上下文与审计关联。 */
  parentTask?: Task;
  /** 父 delegate 调用 ID，用于把内部进度归并到同一 UI 卡片。 */
  parentCallId?: string;
  /** 允许访问的附件/显式外部路径，继承自父任务工具上下文。 */
  externalPaths?: string[];
  /** 父工具取消信号。 */
  signal?: AbortSignal;
  /** 渐进反馈；回调异常不会影响子代理执行。 */
  onProgress?: (progress: SubTaskProgress) => void;
  /** 透传既有 SSE 事件，供子代理内部工具报告进度。 */
  publishEvent?: (event: Record<string, unknown>) => void;
}

export interface SubTaskResult {
  runId: string;
  ok: boolean;
  content: string;
  toolCallCount: number;
  iterations: number;
  role: SubagentRole;
  stopReason: SubagentStopReason;
  durationMs: number;
  truncated: boolean;
  error?: string;
}

/**
 * 使用 Pi AgentHarness 执行隔离子任务。
 * 边界：并发闸门、父取消、工具白名单与父权限；无独立轮次/总时长上限。
 */
export async function runSubTask(subTask: SubTask): Promise<SubTaskResult> {
  const runId = randomUUID();
  const startedAtMs = Date.now();
  const role = subTask.role ?? DEFAULT_SUBAGENT_ROLE;
  const profile = getSubagentProfile(role);
  const requestedTools = resolveSubagentTools(role, subTask.allowedTools);
  const allowedTools = requestedTools.filter(
    (name) => !!unifiedToolRegistry.get(name) && unifiedToolRegistry.isEnabled(name),
  );
  const approvalConfig = resolveSubagentApprovalConfig(subTask);
  const logger = subTask.parentTask?.id
    ? createTaskLogger(subTask.parentTask.id)
    : undefined;

  if (allowedTools.length === 0) {
    const unavailable = requestedTools.length > 0 ? `：${requestedTools.join(', ')}` : '';
    return buildResult({
      runId,
      startedAtMs,
      role,
      stopReason: 'error',
      error: `子代理角色 ${role} 没有已启用的可用工具${unavailable}`,
    });
  }

  emitProgress(subTask, {
    runId,
    phase: 'queued',
    message: `子代理 ${role} 等待执行槽位（并发上限 ${config.agent.subagentMaxConcurrency}）`,
  });

  let releaseSlot: (() => void) | undefined;
  try {
    releaseSlot = await subagentLimiter.acquire(subTask.signal);
  } catch {
    return buildResult({
      runId,
      startedAtMs,
      role,
      stopReason: 'cancelled',
      error: '父任务已取消，子代理未启动',
    });
  }

  let content = '';
  let toolCallCount = 0;
  let iterations = 0;
  let error: string | undefined;
  let forcedStopReason: Extract<SubagentStopReason, 'cancelled'> | undefined;
  let harness: AgentHarness | undefined;
  const toolStartedAt = new Map<string, number>();

  const forceStop = (
    reason: Extract<SubagentStopReason, 'cancelled'>,
    message: string,
  ): void => {
    if (forcedStopReason) return;
    forcedStopReason = reason;
    error = message;
    void harness?.abort();
  };

  const onParentAbort = () => forceStop('cancelled', '父任务已取消，子代理同步终止');
  subTask.signal?.addEventListener('abort', onParentAbort, { once: true });
  if (subTask.signal?.aborted) onParentAbort();

  traceSubagent(logger, runId, subTask, role, 'running', true, startedAtMs, {
    allowedTools,
  });
  emitProgress(subTask, {
    runId,
    phase: 'running',
    message: `子代理 ${role} 已启动`,
  });

  try {
    const model = createPiModel();
    const session = await new InMemorySessionRepo().create({ id: runId });
    harness = new AgentHarness({
      env: new NodeExecutionEnv({ cwd: subTask.workspaceDir, shellEnv: process.env }),
      session,
      models: createAurevoyPiModels(model),
      systemPrompt: buildSubagentSystemPrompt(
        subTask,
        role,
        allowedTools,
        approvalConfig,
      ),
      model,
      thinkingLevel: 'off',
      tools: createSubagentPiTools(allowedTools, subTask),
      streamOptions: {
        // 单次 LLM 请求超时（非子代理总时长上限）
        timeoutMs: config.llm.timeoutMs,
        maxRetries: 2,
        maxRetryDelayMs: 30_000,
        cacheRetention: 'short',
      },
    });

    harness.subscribe((event) => {
      if (!isPiAgentEvent(event)) return;
      const captured = captureSubagentEvent(event);
      if (captured.content) content = captured.content;
      toolCallCount += captured.toolCalls;
      iterations += captured.turns;
      if (captured.error && !forcedStopReason) error = captured.error;

      if (event.type === 'tool_execution_start') {
        toolStartedAt.set(event.toolCallId, Date.now());
        traceSubagentTool(logger, runId, role, event.toolCallId, event.toolName, 'tool_call', {
          ok: true,
          data: { args: event.args },
        });
        emitProgress(subTask, {
          runId,
          phase: 'tool_started',
          message: `子代理 ${role} 正在调用 ${event.toolName}`,
          iteration: iterations,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        });
      }
      if (event.type === 'tool_execution_end') {
        traceSubagentTool(logger, runId, role, event.toolCallId, event.toolName, 'tool_result', {
          ok: !event.isError,
          startedAtMs: toolStartedAt.get(event.toolCallId),
          errorCategory: event.isError ? 'tool' : undefined,
          errorMessage: event.isError ? piContentToText(event.result.content) : undefined,
        });
        emitProgress(subTask, {
          runId,
          phase: 'tool_completed',
          message: event.isError
            ? `子代理 ${role} 调用 ${event.toolName} 失败`
            : `子代理 ${role} 已完成 ${event.toolName}`,
          iteration: iterations,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          toolStatus: event.isError ? 'failed' : 'completed',
          toolDurationMs: Math.max(0, Date.now() - (toolStartedAt.get(event.toolCallId) ?? Date.now())),
          error: event.isError ? piContentToText(event.result.content) : undefined,
        });
        toolStartedAt.delete(event.toolCallId);
      }
    });
    harness.on('tool_call', (event) => {
      if (!allowedTools.includes(event.toolName)) {
        return { block: true, reason: `子代理（${role}）不允许使用工具：${event.toolName}` };
      }
      const risk = unifiedToolRegistry.riskLevelOf(event.toolName);
      const permission = decideToolPermission(approvalConfig, event.toolName, risk);
      if (!permission.allowed) {
        return {
          block: true,
          reason: permission.reason
            ?? `子代理继承父权限，当前不允许执行工具：${event.toolName}`,
        };
      }
      return undefined;
    });

    if (forcedStopReason) throw new Error(error ?? '子代理已取消');
    await harness.prompt(`子任务目标：${subTask.goal}\n\n详细指令：${subTask.prompt}`);

    const stopReason: SubagentStopReason = forcedStopReason ?? (error ? 'error' : 'completed');
    const truncatedContent = truncateResultContent(content, profile.maxOutputChars);
    const result = buildResult({
      runId,
      startedAtMs,
      role,
      stopReason,
      content: truncatedContent.content,
      truncated: truncatedContent.truncated,
      toolCallCount,
      iterations,
      error,
    });
    traceSubagent(logger, runId, subTask, role, stopReason, result.ok, startedAtMs, {
      iterations,
      toolCallCount,
      truncated: result.truncated,
      error: result.error,
    });
    emitProgress(subTask, {
      runId,
      phase: 'completed',
      message: result.ok
        ? `子代理 ${role} 已完成：${iterations} 轮，${toolCallCount} 次工具调用`
        : `子代理 ${role} 已停止：${result.error ?? stopReason}`,
      iteration: iterations,
    });
    return result;
  } catch (err) {
    const stopReason: SubagentStopReason = forcedStopReason ?? 'error';
    const caught = err instanceof Error ? err.message : String(err);
    const finalError = error ?? caught;
    const truncatedContent = truncateResultContent(content, profile.maxOutputChars);
    const result = buildResult({
      runId,
      startedAtMs,
      role,
      stopReason,
      content: truncatedContent.content,
      truncated: truncatedContent.truncated,
      toolCallCount,
      iterations,
      error: finalError,
    });
    traceSubagent(logger, runId, subTask, role, stopReason, false, startedAtMs, {
      iterations,
      toolCallCount,
      error: finalError,
    });
    emitProgress(subTask, {
      runId,
      phase: 'completed',
      message: `子代理 ${role} 执行失败：${finalError}`,
      iteration: iterations,
    });
    return result;
  } finally {
    subTask.signal?.removeEventListener('abort', onParentAbort);
    releaseSlot();
  }
}

function resolveSubagentApprovalConfig(subTask: SubTask): ApprovalConfig {
  if (subTask.approvalConfig) return subTask.approvalConfig;
  const level: AutoModeLevel = config.autoMode.level === 'plan' ? 'plan' : 'auto';
  if (subTask.parentTask) return approvalConfigFromTask(subTask.parentTask, level);
  return {
    autoModeLevel: level,
    autoModePaused: false,
    planApproved: level === 'auto',
  };
}

function buildSubagentSystemPrompt(
  subTask: SubTask,
  role: SubagentRole,
  allowedTools: string[],
  approvalConfig: ApprovalConfig,
): string {
  const profile = getSubagentProfile(role);
  const permissionLine =
    approvalConfig.autoModeLevel === 'auto' || approvalConfig.planApproved
      ? '权限：继承父代理，当前可在工具白名单内自动执行（含写入/命令，若白名单包含）。'
      : '权限：继承父代理 Plan 模式且计划尚未批准，非 safe 工具会被 runtime 拦截。';

  return [
    `你是 Aurevoy 的子代理（角色：${profile.label} / ${role}）。`,
    '你的任务是完成主代理委托给你的独立子任务；主代理仍持有用户对话与最终答复权。',
    `工作区：${subTask.workspaceDir}`,
    subTask.parentTask?.goal ? `父任务目标：${subTask.parentTask.goal}` : '',
    `当前环境：${process.platform} ${process.arch}`,
    `当前时间：${new Date().toISOString()}`,
    '',
    profile.systemPromptAddon,
    '',
    '约束：',
    `- 只能使用提供的工具：${allowedTools.join(', ')}`,
    `- ${permissionLine}`,
    '- 优先收敛，不要重复无效调用；完成后立即输出最终结果',
    '- 只返回主代理完成任务所需的结论、变更与验证；不要回传大段原始工具输出',
    '- 无法完成时明确说明阻塞原因和已经验证的事实',
  ].filter(Boolean).join('\n');
}

function createSubagentPiTools(allowedTools: string[], subTask: SubTask): AgentTool[] {
  const agentTools = unifiedToolRegistry.toAgentTools(allowedTools);

  return agentTools.map((agentTool): AgentTool => {
    const def = unifiedToolRegistry.get(agentTool.name)!;
    return {
      ...agentTool,
      execute: async (toolCallId, params, signal) => {
        const validationError = validateToolInputSchema(def.inputSchema, params);
        if (validationError) throw new Error(`schema_validation_failed: ${validationError}`);

        const context: UnifiedToolContext = {
          taskId: subTask.parentTask?.id ?? '',
          taskGoal: subTask.parentTask?.goal,
          workspaceDir: subTask.workspaceDir,
          externalPaths: subTask.externalPaths,
          abortSignal: signal,
          callId: toolCallId,
          task: subTask.parentTask,
          publishEvent: (event) => {
            // 子工具进度归并到父 delegate 卡片；其它已有事件保持原始归属。
            if (event.type === 'tool_progress' && subTask.parentCallId) {
              subTask.publishEvent?.({
                ...event,
                taskId: subTask.parentTask?.id ?? event.taskId,
                callId: subTask.parentCallId,
              });
              return;
            }
            subTask.publishEvent?.(event);
          },
        };
        try {
          const result = await def.execute(params as Record<string, unknown>, context);
          return {
            content: [{ type: 'text' as const, text: formatUnknown(result) }],
            details: result,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(message);
        }
      },
    };
  });
}

function isPiAgentEvent(event: { type: string }): event is AgentEvent {
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

function captureSubagentEvent(event: AgentEvent): {
  content?: string;
  toolCalls: number;
  turns: number;
  error?: string;
} {
  if (event.type === 'tool_execution_end') return { toolCalls: 1, turns: 0 };
  if (event.type === 'turn_end') {
    const message = event.message;
    if (message.role !== 'assistant') return { toolCalls: 0, turns: 0 };
    return {
      content: piContentToText(message.content),
      toolCalls: 0,
      turns: 1,
      error: message.errorMessage,
    };
  }
  return { toolCalls: 0, turns: 0 };
}

function piContentToText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') return block.text;
    if (isRecord(block) && block.type === 'thinking' && typeof block.thinking === 'string') return block.thinking;
    return '';
  }).join('');
}

function truncateResultContent(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (content.length <= maxChars) return { content, truncated: false };
  const marker = '\n\n[子代理结果已按上下文预算截断]';
  return {
    content: `${content.slice(0, Math.max(0, maxChars - marker.length))}${marker}`,
    truncated: true,
  };
}

function buildResult(input: {
  runId: string;
  startedAtMs: number;
  role: SubagentRole;
  stopReason: SubagentStopReason;
  content?: string;
  toolCallCount?: number;
  iterations?: number;
  truncated?: boolean;
  error?: string;
}): SubTaskResult {
  return {
    runId: input.runId,
    ok: input.stopReason === 'completed' && !input.error,
    content: input.content ?? '',
    toolCallCount: input.toolCallCount ?? 0,
    iterations: input.iterations ?? 0,
    role: input.role,
    stopReason: input.stopReason,
    durationMs: Math.max(0, Date.now() - input.startedAtMs),
    truncated: input.truncated ?? false,
    error: input.error,
  };
}

function emitProgress(subTask: SubTask, progress: SubTaskProgress): void {
  try {
    subTask.onProgress?.(progress);
  } catch {
    // UI/日志回调不是执行真相源，反馈失败不能中断子代理。
  }
}

function traceSubagent(
  logger: TaskLogger | undefined,
  runId: string,
  subTask: SubTask,
  role: SubagentRole,
  stopReason: string,
  ok: boolean,
  startedAtMs: number,
  data: Record<string, unknown>,
): void {
  logger?.trace('phase', null, {
    ok,
    callId: subTask.parentCallId,
    toolName: 'delegate',
    startedAtMs,
    finishReason: stopReason,
    errorCategory: ok ? undefined : stopReasonToErrorCategory(stopReason),
    errorMessage: typeof data.error === 'string' ? data.error : undefined,
    summary: stopReason === 'running'
      ? `子代理 ${role} 已启动`
      : `子代理 ${role} 结束：${stopReason}`,
    data: { subagentRunId: runId, role, goal: subTask.goal, ...data },
  });
}

function traceSubagentTool(
  logger: TaskLogger | undefined,
  runId: string,
  role: SubagentRole,
  callId: string,
  toolName: string,
  kind: 'tool_call' | 'tool_result',
  entry: {
    ok: boolean;
    startedAtMs?: number;
    errorCategory?: TaskErrorCategory;
    errorMessage?: string;
    data?: unknown;
  },
): void {
  logger?.trace(kind, null, {
    ...entry,
    callId: `${runId}:${callId}`,
    toolName,
    riskLevel: unifiedToolRegistry.riskLevelOf(toolName),
    summary: `子代理 ${role} ${kind === 'tool_call' ? '调用' : '完成'}工具 ${toolName}`,
    data: { subagentRunId: runId, role, details: entry.data },
  });
}

function stopReasonToErrorCategory(stopReason: string): TaskErrorCategory {
  if (stopReason === 'timeout') return 'timeout';
  if (stopReason === 'cancelled') return 'cancelled';
  if (stopReason === 'max_iterations') return 'budget';
  return 'unknown';
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
