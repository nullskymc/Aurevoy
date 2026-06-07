import { randomUUID } from 'node:crypto';
import type { Task, PlanStep, Message, MessageToolCall } from '@aurevoy/shared';
import { taskEvents } from './events.js';
import { getProvider, type AccumulatedToolCall } from '../llm/provider.js';
import { toolRegistry } from '../tools/registry.js';
import { withRetry } from './retry.js';
import { taskStore } from '../store/db.js';

/** 单任务最大 LLM 调用轮次 */
const MAX_ITERATIONS = 20;
/** 同一工具+相同参数最多重复调用次数，超过即注入纠正提示 */
const DUPLICATE_CALL_LIMIT = 3;
/** 单轮最多并行工具调用数 */
const MAX_TOOL_CALLS_PER_TURN = 10;
/** 等待用户审批的超时（毫秒）；超时视为拒绝，避免任务永久挂起 */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

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
    const timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS);

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
    plan: [],
    messages: [userMsg],
    createdAt: now,
    updatedAt: now,
  };
  taskStore.save(task);
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
    taskEvents.publish({ type: 'step_update', taskId: task.id, step: { ...planStep } });
  };

  const messages = task.messages;
  const toolDescriptors = toolRegistry.list();
  const callFingerprints = new Map<string, number>();

  try {
    task.status = 'running';
    touch();
    taskEvents.publish({ type: 'status', taskId: task.id, status: 'running' });
    taskEvents.publish({ type: 'plan', taskId: task.id, plan: task.plan });

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (abortController.signal.aborted) return finishCancelled(task, touch);

      let textBuffer = '';
      let reasoningContent = '';
      let finishReason: string | undefined;
      let toolCalls: AccumulatedToolCall[] = [];

      // ---------- 调用 LLM（带重试） ----------
      await withRetry(
        async () => {
          // 重试时重置本轮累积
          textBuffer = '';
          reasoningContent = '';
          finishReason = undefined;
          toolCalls = [];
          const stream = getProvider().stream(messages, {
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

      // ---------- 情况 A：输出被截断 ----------
      if (finishReason === 'length') {
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
        taskEvents.publish({ type: 'tool_call', taskId: task.id, call });

        // 风险门：非 safe 工具执行前请求用户审批
        const risk = toolRegistry.riskLevelOf(name);
        if (risk !== 'safe') {
          taskEvents.publish({ type: 'approval_request', taskId: task.id, call, riskLevel: risk });
          updateStep(`等待确认：${name}`, 'running');
          const approved = await waitForApproval(task.id, tc.id, abortController.signal);
          if (abortController.signal.aborted) return finishCancelled(task, touch);
          if (!approved) {
            const denied = { callId: tc.id, ok: false, error: '用户拒绝了该工具调用' };
            taskEvents.publish({ type: 'tool_result', taskId: task.id, result: denied });
            messages.push(
              makeToolResult(tc.id, {
                error: '用户拒绝执行该工具。请改用其他方式，或直接给出最终答案。',
              }),
            );
            continue;
          }
          updateStep(`调用工具：${name}`, 'running');
        }

        const result = await toolRegistry.invoke(call);
        taskEvents.publish({ type: 'tool_result', taskId: task.id, result });

        messages.push(
          makeToolResult(tc.id, result.ok ? result.output : { error: result.error }),
        );
      }

      // 每轮结束持久化，保证崩溃可恢复
      touch();
      if (abortController.signal.aborted) return finishCancelled(task, touch);
    }

    // 超过最大轮次兜底
    const fallback = makeAssistant(
      '已达到最大推理轮次，基于目前收集到的信息，这是我能给出的结果。',
      '',
    );
    messages.push(fallback);
    taskEvents.publish({ type: 'message', taskId: task.id, message: fallback });
    return finishCompleted(task, updateStep, touch);
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      return finishCancelled(task, touch);
    }
    task.status = 'failed';
    updateStep('任务失败', 'failed');
    touch();
    const message = err instanceof Error ? err.message : String(err);
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
  updateStep('任务完成', 'completed');
  touch();
  taskEvents.publish({ type: 'done', taskId: task.id, status: 'completed' });
}

function finishCancelled(task: Task, touch: () => void): void {
  task.status = 'cancelled';
  touch();
  taskEvents.publish({ type: 'status', taskId: task.id, status: 'cancelled' });
  taskEvents.publish({ type: 'done', taskId: task.id, status: 'cancelled' });
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
