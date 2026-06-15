/**
 * P7: 子代理（Sub-agent）执行模块。
 *
 * 允许 Agent 主循环通过 delegate_task 工具委托独立子任务给受限子代理。
 * 子代理拥有独立的 LLM 对话循环，但受严格约束：
 * - 默认仅 safe 只读工具
 * - 最大 5 轮
 * - 总超时 60s
 * - 不写 memory
 * - 结果截断到 20KB
 */

import { randomUUID } from 'node:crypto';
import type { Message, ToolCall } from '@aurevoy/shared';
import { getProvider, type AccumulatedToolCall } from '../llm/provider.js';
import { toolRegistry } from '../tools/registry.js';
import { config } from '../config.js';

/** 子代理默认可用工具（safe 只读）。 */
const DEFAULT_READONLY_TOOLS = ['list_directory', 'read_file', 'search_files', 'get_current_time'];

export interface SubTask {
  goal: string;
  prompt: string;
  allowedTools?: string[];
  workspaceDir: string;
}

export interface SubTaskResult {
  ok: boolean;
  content: string;
  toolCallCount: number;
  iterations: number;
  error?: string;
}

/**
 * 执行一个子代理任务。
 *
 * 使用简化 ReAct 循环：调用 LLM → 执行 safe 工具 → 回灌结果 → 重复，
 * 直到模型给出最终回复、达到轮次上限或超时。
 */
export async function runSubTask(subTask: SubTask): Promise<SubTaskResult> {
  const allowedTools = subTask.allowedTools ?? DEFAULT_READONLY_TOOLS;
  const maxIterations = 5;
  const totalTimeoutMs = 60000;
  const outputCharCap = 20000;

  const toolDescriptors = toolRegistry
    .list()
    .filter((t) => allowedTools.includes(t.name));

  const messages: Message[] = [
    {
      id: randomUUID(),
      role: 'system',
      content:
        '你是 Aurevoy 的子代理。你的任务是完成主代理委托给你的子任务。\n\n' +
        '约束：\n' +
        '- 只能使用提供的只读工具\n' +
        '- 不要修改任何文件\n' +
        '- 简洁回复，不要过度分析\n' +
        '- 完成任务后直接输出最终结果',
      createdAt: new Date().toISOString(),
    },
    {
      id: randomUUID(),
      role: 'user',
      content: `子任务目标：${subTask.goal}\n\n详细指令：${subTask.prompt}`,
      createdAt: new Date().toISOString(),
    },
  ];

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), totalTimeoutMs);

  let toolCallCount = 0;
  let iterations = 0;

  try {
    for (; iterations < maxIterations; iterations++) {
      if (abortController.signal.aborted) {
        return {
          ok: false,
          content: '',
          toolCallCount,
          iterations,
          error: '子代理超时或被取消',
        };
      }

      let textBuffer = '';
      let toolCalls: AccumulatedToolCall[] = [];

      try {
        const stream = getProvider().stream(messages, {
          tools: toolDescriptors.length > 0 ? toolDescriptors : undefined,
          toolChoice: 'auto',
          signal: abortController.signal,
        });
        for await (const chunk of stream) {
          if (chunk.textDelta) textBuffer += chunk.textDelta;
          if (chunk.done) toolCalls = chunk.toolCallsSnapshot ?? [];
        }
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') {
          return {
            ok: false,
            content: textBuffer.slice(0, outputCharCap),
            toolCallCount,
            iterations,
            error: '子代理超时',
          };
        }
        return {
          ok: false,
          content: '',
          toolCallCount,
          iterations,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      // LLM 给出最终回复
      if (toolCalls.length === 0 || textBuffer.trim()) {
        const assistantMsg: Message = {
          id: randomUUID(),
          role: 'assistant',
          content: textBuffer,
          createdAt: new Date().toISOString(),
        };
        if (toolCalls.length > 0) {
          assistantMsg.toolCalls = toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          }));
        }
        messages.push(assistantMsg);
      }

      // 没有工具调用 → 返回最终结果
      if (toolCalls.length === 0) {
        return {
          ok: true,
          content: textBuffer.slice(0, outputCharCap),
          toolCallCount,
          iterations: iterations + 1,
        };
      }

      // 有工具调用但无文本 → assistant 消息仍需添加
      if (!textBuffer.trim() && toolCalls.length > 0) {
        const assistantMsg: Message = {
          id: randomUUID(),
          role: 'assistant',
          content: '',
          createdAt: new Date().toISOString(),
          toolCalls: toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        };
        messages.push(assistantMsg);
      }

      // 执行工具（仅 safe，无审批，并行）
      const results: Array<{ callId: string; output: unknown }> = [];
      const executePromises = toolCalls.map(async (tc) => {
        const name = tc.function.name;

        // 安全检查：只允许白名单工具
        if (!allowedTools.includes(name)) {
          return {
            callId: tc.id,
            output: { error: `子代理不允许使用工具：${name}` },
          };
        }

        let args: Record<string, unknown>;
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          return {
            callId: tc.id,
            output: { error: '工具参数不是合法 JSON' },
          };
        }

        const call: ToolCall = { id: tc.id, toolName: name, args };
        try {
          const result = await toolRegistry.invokeWithTimeout(
            call,
            {
              taskId: undefined,
              workspaceDir: subTask.workspaceDir,
              abortSignal: abortController.signal,
            },
            config.agent.toolTimeoutMs,
          );
          toolCallCount++;
          return {
            callId: tc.id,
            output: result.ok ? result.output : { error: result.error },
          };
        } catch (err) {
          return {
            callId: tc.id,
            output: { error: err instanceof Error ? err.message : String(err) },
          };
        }
      });

      const settled = await Promise.all(executePromises);
      results.push(...settled);

      // 按原始顺序回填 tool result 消息
      for (const tc of toolCalls) {
        const r = results.find((x) => x.callId === tc.id);
        if (r) {
          messages.push({
            id: randomUUID(),
            role: 'tool',
            content: JSON.stringify(r.output ?? null),
            toolCallId: tc.id,
            createdAt: new Date().toISOString(),
          });
        }
      }
    }

    // 达到最大轮次
    return {
      ok: true,
      content: `子代理达到最大轮次 (${maxIterations})。最后 ${toolCallCount} 次工具调用已完成，但未生成最终摘要。`,
      toolCallCount,
      iterations,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
