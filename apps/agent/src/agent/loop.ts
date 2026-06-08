import { randomUUID } from 'node:crypto';
import type {
  Message,
  MessageToolCall,
  PlanStep,
  Task,
  TaskErrorCategory,
  TaskPhase,
  TaskStatus,
  TaskTraceEntry,
  ToolCall,
  ToolRiskLevel,
} from '@aurevoy/shared';
import { taskEvents } from './events.js';
import { getProvider, getProviderName, type AccumulatedToolCall } from '../llm/provider.js';
import { buildContextWindow, buildMemorySystemMessage } from './context.js';
import { toolRegistry } from '../tools/registry.js';
import { withRetry } from './retry.js';
import { taskStore, traceStore, memoryStore } from '../store/db.js';
import { config } from '../config.js';

/** 单任务最大 LLM 调用轮次 */
const MAX_ITERATIONS = 20;
/** 同一工具+相同参数最多重复调用次数，超过即注入纠正提示 */
const DUPLICATE_CALL_LIMIT = 3;
/** 单轮最多并行工具调用数 */
const MAX_TOOL_CALLS_PER_TURN = 10;
/** 进程重启后不会再有内存执行句柄的状态；启动时必须收敛成可解释失败。 */
const INTERRUPTED_STATUSES: readonly TaskStatus[] = ['pending', 'planning', 'running', 'paused'];
/** 进行中任务的取消句柄 */
const activeAbortControllers = new Map<string, AbortController>();

/** 等待中的工具审批：taskId → (callId → 决策回调) */
const pendingApprovals = new Map<string, Map<string, (approved: boolean) => void>>();

/** 取消一个进行中的任务（hard cancel：中断 fetch 流） */
export function cancelTask(taskId: string): boolean {
  const ac = activeAbortControllers.get(taskId);
  if (!ac) return false;
  ac.abort();
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
  task.status = 'pending';
  task.phase = 'initializing';
  task.plan = task.plan.map((step) =>
    step.status === 'completed' ? step : { ...step, status: 'pending' },
  );
  task.updatedAt = now;
  taskStore.save(task);
  writeTrace(task.id, 'phase', 'initializing', {
    ok: true,
    summary: '用户恢复历史任务，使用持久消息历史重新进入 Agent 循环',
    data: { previousStatus, previousPhase, patchedToolResults },
  });
  return task;
}

/**
 * 在同一任务内追加一轮用户输入（多轮对话）。
 *
 * 仅追加 user 消息并持久化、广播；调用方随后再 `runTask(task)`，
 * 循环会带着完整的历史 `task.messages` 作为上下文继续推进。
 */
export function addUserTurn(task: Task, content: string): Message {
  const userMsg: Message = {
    id: randomUUID(),
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
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
    data: { message: content },
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

/** 创建一个新任务并持久化（尚未开始执行） */
export function createTask(goal: string): Task {
  const now = new Date().toISOString();
  const userMsg: Message = {
    id: randomUUID(),
    role: 'user',
    content: goal,
    createdAt: now,
  };
  const task: Task = {
    id: randomUUID(),
    goal,
    status: 'pending',
    phase: 'initializing',
    plan: [],
    messages: [userMsg],
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
 * Agent 主循环（ReAct 工具调用循环）。
 *
 * 每轮调用 LLM：若模型请求工具，则执行并把结果作为 role:'tool' 消息回灌，再次请求；
 * 直到模型给出最终答案、达到最大轮次或被取消。
 * 含防死循环（指纹去重）、重试（指数退避）、取消（AbortController）与每轮持久化。
 */
export async function runTask(task: Task): Promise<void> {
  const abortController = new AbortController();
  activeAbortControllers.set(task.id, abortController);

  const touch = () => {
    task.updatedAt = new Date().toISOString();
    taskStore.save(task);
  };

  // 隐式计划：用单步计划承载工具调用轨迹
  const planStep: PlanStep = { id: 'exec', description: '正在执行任务…', status: 'running' };
  task.plan = [planStep];
  const updateStep = (description: string, status: PlanStep['status']) => {
    planStep.description = description;
    planStep.status = status;
    touch();
    taskEvents.publish({ type: 'step_update', taskId: task.id, step: { ...planStep } });
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

  const messages = task.messages;
  const toolDescriptors = toolRegistry.list();
  const callFingerprints = new Map<string, number>();

  try {
    setRuntimePhase('initializing', '准备运行任务', 'running');
    taskEvents.publish({ type: 'plan', taskId: task.id, plan: task.plan });

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (abortController.signal.aborted) return finishCancelled(task, updateStep, touch);
      setRuntimePhase('thinking', `第 ${iteration + 1} 轮模型思考`, 'running');

      let textBuffer = '';
      let reasoningContent = '';
      let finishReason: string | undefined;
      let toolCalls: AccumulatedToolCall[] = [];
      const llmStartedAt = Date.now();

      // 会话级短期记忆：把完整历史压缩为本轮上下文窗口（非裸拼接）
      const ctx = buildContextWindow(messages);
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

      // 长期记忆：把启用的记忆作为 system 消息注入到上下文最前面（禁用的不注入）
      const memoryMessage = buildMemorySystemMessage(memoryStore.listEnabled());
      const requestMessages = memoryMessage ? [memoryMessage, ...ctx.messages] : ctx.messages;

      // ---------- 调用 LLM（带重试） ----------
      try {
        await withRetry(
          async () => {
            // 重试时重置本轮累积
            textBuffer = '';
            reasoningContent = '';
            finishReason = undefined;
            toolCalls = [];
            const stream = getProvider().stream(requestMessages, {
              tools: toolDescriptors.length > 0 ? toolDescriptors : undefined,
              toolChoice: 'auto',
              signal: abortController.signal,
            });
            for await (const chunk of stream) {
              if (chunk.textDelta) {
                textBuffer += chunk.textDelta;
                taskEvents.publish({ type: 'token', taskId: task.id, delta: chunk.textDelta });
              }
              if (chunk.reasoningContentDelta) reasoningContent += chunk.reasoningContentDelta;
              if (chunk.done) {
                finishReason = chunk.finishReason;
                toolCalls = chunk.toolCallsSnapshot ?? [];
              }
            }
          },
          abortController.signal,
        );
        writeTrace(task.id, 'llm', 'thinking', {
          iteration: iteration + 1,
          startedAtMs: llmStartedAt,
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

      // 逐个执行工具并回填结果
      for (const tc of toolCalls) {
        const name = tc.function.name;
        setRuntimePhase('calling_tool', `准备调用工具：${name}`, 'running');
        updateStep(`调用工具：${name}`, 'running');

        // 防死循环：指纹去重
        const fingerprint = `${name}:${tc.function.arguments}`;
        const count = (callFingerprints.get(fingerprint) ?? 0) + 1;
        callFingerprints.set(fingerprint, count);
        if (count > DUPLICATE_CALL_LIMIT) {
          messages.push(
            makeToolResult(tc.id, {
              error: `工具 "${name}" 已用相同参数被调用 ${count} 次。请换一种方式，或直接给出最终答案。`,
            }),
          );
          continue;
        }

        // 解析参数
        let args: Record<string, unknown>;
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          messages.push(
            makeToolResult(tc.id, { error: `工具参数不是合法 JSON：${tc.function.arguments}` }),
          );
          continue;
        }

        const call = { id: tc.id, toolName: name, args };
        const risk = toolRegistry.riskLevelOf(name);
        taskEvents.publish({ type: 'tool_call', taskId: task.id, call });
        writeToolCallTrace(task.id, call, risk, iteration + 1);

        // 风险门：非 safe 工具执行前请求用户审批
        if (risk !== 'safe') {
          taskEvents.publish({ type: 'approval_request', taskId: task.id, call, riskLevel: risk });
          updateStep(`等待确认：${name}`, 'paused');
          setRuntimePhase('waiting_approval', `等待确认：${name}`, 'paused');
          const approved = await waitForApproval(task.id, tc.id, abortController.signal);
          if (abortController.signal.aborted) return finishCancelled(task, updateStep, touch);
          writeApprovalTrace(task.id, call, risk, approved, iteration + 1);
          if (!approved) {
            const denied = { callId: tc.id, ok: false, error: '用户拒绝了该工具调用' };
            taskEvents.publish({ type: 'tool_result', taskId: task.id, result: denied });
            writeTrace(task.id, 'tool_result', 'waiting_approval', {
              iteration: iteration + 1,
              callId: tc.id,
              toolName: name,
              riskLevel: risk,
              ok: false,
              errorCategory: 'permission',
              errorMessage: denied.error,
              summary: `工具被拒绝：${name}`,
            });
            messages.push(
              makeToolResult(tc.id, {
                error: '用户拒绝执行该工具。请改用其他方式，或直接给出最终答案。',
              }),
            );
            setRuntimePhase('thinking', `审批被拒绝：${name}`, 'running');
            continue;
          }
          setRuntimePhase('calling_tool', `审批通过，调用工具：${name}`, 'running');
          updateStep(`调用工具：${name}`, 'running');
        }

        const toolStartedAt = Date.now();
        const result = await toolRegistry.invoke(call, { taskId: task.id, taskGoal: task.goal });
        taskEvents.publish({ type: 'tool_result', taskId: task.id, result });
        writeTrace(task.id, 'tool_result', 'calling_tool', {
          iteration: iteration + 1,
          startedAtMs: toolStartedAt,
          callId: tc.id,
          toolName: name,
          riskLevel: risk,
          ok: result.ok,
          errorCategory: result.ok ? undefined : 'tool',
          errorMessage: result.error,
          summary: result.ok ? `工具成功：${name}` : `工具失败：${name}`,
          data: result.ok ? { output: summarizePayload(result.output) } : undefined,
        });

        messages.push(
          makeToolResult(tc.id, result.ok ? result.output : { error: result.error }),
        );
      }

      // 每轮结束持久化，保证崩溃可恢复
      touch();
      if (abortController.signal.aborted) return finishCancelled(task, updateStep, touch);
    }

    // 超过最大轮次兜底
    setRuntimePhase('finalizing', '达到最大推理轮次，整理已有信息', 'running');
    const fallback = makeAssistant(
      '已达到最大推理轮次，基于目前收集到的信息，这是我能给出的结果。',
      '',
    );
    messages.push(fallback);
    taskEvents.publish({ type: 'message', taskId: task.id, message: fallback });
    return finishCompleted(task, updateStep, touch);
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

function finishCompleted(
  task: Task,
  updateStep: (d: string, s: PlanStep['status']) => void,
  touch: () => void,
): void {
  task.status = 'completed';
  task.phase = 'finalizing';
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
  const endedAtMs = Date.now();
  const startedAtMs = patch.startedAtMs ?? endedAtMs;
  traceStore.append({
    id: randomUUID(),
    taskId,
    kind,
    phase,
    iteration: patch.iteration,
    callId: patch.callId,
    toolName: patch.toolName,
    riskLevel: patch.riskLevel,
    provider: getProviderName(),
    model: config.llm.model,
    finishReason: patch.finishReason,
    tokenUsage: null,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: Math.max(0, endedAtMs - startedAtMs),
    ok: patch.ok,
    errorCategory: patch.errorCategory,
    errorMessage: patch.errorMessage,
    summary: patch.summary,
    data: patch.data,
  });
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
