import { Agent, type AgentEvent, type AgentTool } from '@earendil-works/pi-agent-core';
import { config } from '../config.js';
import { createPiModel } from '../llm/pi-provider.js';
import { unifiedToolRegistry, type UnifiedToolContext } from '../tool/unified-registry.js';

const DEFAULT_READONLY_TOOLS = ['list_directory', 'open_file', 'scroll', 'search_grep', 'get_current_time'];
const MAX_OUTPUT_CHARS = 20_000;

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

/** 使用 Pi Agent 执行只读子任务，供 delegate_task 工具调用。 */
export async function runSubTask(subTask: SubTask): Promise<SubTaskResult> {
  const allowedTools = subTask.allowedTools ?? DEFAULT_READONLY_TOOLS;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 60_000);
  let content = '';
  let toolCallCount = 0;
  let iterations = 0;
  let error: string | undefined;

  try {
    const agent = new Agent({
      initialState: {
        systemPrompt: buildSubagentSystemPrompt(subTask),
        model: createPiModel(),
        thinkingLevel: 'off',
        tools: createReadonlyPiTools(allowedTools, subTask.workspaceDir, abortController.signal),
        messages: [],
      },
      getApiKey: () => config.llm.apiKey,
      toolExecution: 'parallel',
      beforeToolCall: async ({ toolCall }) => {
        if (!allowedTools.includes(toolCall.name)) {
          return { block: true, reason: `子代理不允许使用工具：${toolCall.name}` };
        }
        if (unifiedToolRegistry.riskLevelOf(toolCall.name) !== 'safe') {
          return { block: true, reason: `子代理只允许 safe 工具：${toolCall.name}` };
        }
        return undefined;
      },
    });

    agent.subscribe((event) => {
      const captured = captureSubagentEvent(event);
      if (captured.content) content = captured.content.slice(0, MAX_OUTPUT_CHARS);
      toolCallCount += captured.toolCalls;
      iterations += captured.turns;
      if (captured.error) error = captured.error;
    });

    await agent.prompt(`子任务目标：${subTask.goal}\n\n详细指令：${subTask.prompt}`);

    return {
      ok: !error && !abortController.signal.aborted,
      content: content.slice(0, MAX_OUTPUT_CHARS),
      toolCallCount,
      iterations,
      error: abortController.signal.aborted ? '子代理超时或被取消' : error,
    };
  } catch (err) {
    return {
      ok: false,
      content: content.slice(0, MAX_OUTPUT_CHARS),
      toolCallCount,
      iterations,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildSubagentSystemPrompt(subTask: SubTask): string {
  return [
    '你是 Aurevoy 的子代理。你的任务是完成主代理委托给你的独立子任务。',
    `工作区：${subTask.workspaceDir}`,
    `当前环境：${process.platform} ${process.arch}`,
    `当前时间：${new Date().toISOString()}`,
    '',
    '约束：',
    '- 只能使用提供的只读 safe 工具',
    '- 不要修改任何文件',
    '- 简洁回复，不要过度分析',
    '- 完成任务后直接输出最终结果',
  ].join('\n');
}

function createReadonlyPiTools(
  allowedTools: string[],
  workspaceDir: string,
  outerSignal: AbortSignal,
): AgentTool[] {
  // 使用统一工具框架获取工具，并注入工作区上下文
  const agentTools = unifiedToolRegistry.toAgentTools(allowedTools);

  return agentTools
    .filter((tool) => unifiedToolRegistry.riskLevelOf(tool.name) === 'safe')
    .map((agentTool) => {
      const def = unifiedToolRegistry.get(agentTool.name)!;
      return {
        ...agentTool,
        execute: async (toolCallId, params, signal) => {
          const context: UnifiedToolContext = {
            taskId: '',
            workspaceDir,
            abortSignal: signal ?? outerSignal,
            callId: toolCallId,
          };
          try {
            const result = await def.execute(params as Record<string, unknown>, context);
            return {
              content: [{ type: 'text', text: formatUnknown(result) }],
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

function captureSubagentEvent(event: AgentEvent): { content?: string; toolCalls: number; turns: number; error?: string } {
  if (event.type === 'tool_execution_end') {
    return { toolCalls: 1, turns: 0 };
  }
  if (event.type === 'turn_end') {
    const message = event.message;
    if (message.role !== 'assistant') return { toolCalls: 0, turns: 1 };
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
