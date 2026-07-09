import {
  AgentHarness,
  InMemorySessionRepo,
  type AgentEvent,
  type AgentTool,
} from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { createPiModel } from '../llm/pi-provider.js';
import { unifiedToolRegistry, type UnifiedToolContext } from '../tool/unified-registry.js';
import { createAurevoyPiModels } from './pi-harness.js';
import {
  approvalConfigFromTask,
  decideToolPermission,
  type ApprovalConfig,
} from './approval.js';
import type { AutoModeLevel, Task } from '@aurevoy/shared';
import { config } from '../config.js';
import {
  DEFAULT_SUBAGENT_ROLE,
  getSubagentProfile,
  resolveSubagentTools,
  type SubagentRole,
} from './subagent-profiles.js';

export interface SubTask {
  goal: string;
  prompt: string;
  /** 子代理角色；决定默认工具面与 system prompt */
  role?: SubagentRole;
  /** 显式工具白名单（若提供则覆盖角色默认集） */
  allowedTools?: string[];
  workspaceDir: string;
  /**
   * 父任务权限配置。子代理继承父代理 auto/plan 与 paused/planApproved。
   * 未传时从 parentTask 推导，再不行则按全局 config 推导。
   */
  approvalConfig?: ApprovalConfig;
  /** 父任务（用于继承权限与上下文） */
  parentTask?: Pick<Task, 'id' | 'autoModeState' | 'goal'>;
  /** 覆盖角色默认超时 */
  timeoutMs?: number;
}

export interface SubTaskResult {
  ok: boolean;
  content: string;
  toolCallCount: number;
  iterations: number;
  role: SubagentRole;
  error?: string;
}

/** 使用 Pi AgentHarness 执行子任务；权限继承自父代理，任务面由 role 决定。 */
export async function runSubTask(subTask: SubTask): Promise<SubTaskResult> {
  const role = subTask.role ?? DEFAULT_SUBAGENT_ROLE;
  const profile = getSubagentProfile(role);
  const allowedTools = resolveSubagentTools(role, subTask.allowedTools);
  const approvalConfig = resolveSubagentApprovalConfig(subTask);
  const timeoutMs = subTask.timeoutMs ?? profile.timeoutMs;
  const maxOutputChars = profile.maxOutputChars;

  let content = '';
  let toolCallCount = 0;
  let iterations = 0;
  let error: string | undefined;
  let harness: AgentHarness | undefined;
  const timeoutId = setTimeout(() => {
    void harness?.abort();
  }, timeoutMs);

  try {
    if (allowedTools.length === 0) {
      return {
        ok: false,
        content: '',
        toolCallCount: 0,
        iterations: 0,
        role,
        error: `子代理角色 ${role} 没有可用工具`,
      };
    }

    const model = createPiModel();
    const session = await new InMemorySessionRepo().create();
    harness = new AgentHarness({
      env: new NodeExecutionEnv({ cwd: subTask.workspaceDir, shellEnv: process.env }),
      session,
      models: createAurevoyPiModels(model),
      systemPrompt: buildSubagentSystemPrompt(subTask, role, allowedTools, approvalConfig),
      model,
      thinkingLevel: 'off',
      tools: createSubagentPiTools(allowedTools, subTask.workspaceDir, subTask.parentTask?.id),
    });

    harness.subscribe((event) => {
      if (!isPiAgentEvent(event)) return;
      const captured = captureSubagentEvent(event);
      if (captured.content) content = captured.content.slice(0, maxOutputChars);
      toolCallCount += captured.toolCalls;
      iterations += captured.turns;
      if (captured.error) error = captured.error;
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

    await harness.prompt(`子任务目标：${subTask.goal}\n\n详细指令：${subTask.prompt}`);

    return {
      ok: !error,
      content: content.slice(0, maxOutputChars),
      toolCallCount,
      iterations,
      role,
      error,
    };
  } catch (err) {
    return {
      ok: false,
      content: content.slice(0, maxOutputChars),
      toolCallCount,
      iterations,
      role,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function resolveSubagentApprovalConfig(subTask: SubTask): ApprovalConfig {
  if (subTask.approvalConfig) return subTask.approvalConfig;
  const level: AutoModeLevel = config.autoMode.level === 'plan' ? 'plan' : 'auto';
  if (subTask.parentTask) {
    return approvalConfigFromTask(subTask.parentTask, level);
  }
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
      : '权限：继承父代理 Plan 模式且计划尚未批准，非 safe 工具会被拦截。';

  return [
    `你是 Aurevoy 的子代理（角色：${profile.label} / ${role}）。`,
    '你的任务是完成主代理委托给你的独立子任务。',
    `工作区：${subTask.workspaceDir}`,
    `当前环境：${process.platform} ${process.arch}`,
    `当前时间：${new Date().toISOString()}`,
    '',
    profile.systemPromptAddon,
    '',
    '约束：',
    `- 只能使用提供的工具：${allowedTools.join(', ')}`,
    `- ${permissionLine}`,
    '- 简洁回复，不要过度分析',
    '- 完成任务后直接输出最终结果',
  ].join('\n');
}

function createSubagentPiTools(
  allowedTools: string[],
  workspaceDir: string,
  parentTaskId?: string,
): AgentTool[] {
  // 只注册实际存在的工具；忽略配置里尚未加载的名称
  const existing = allowedTools.filter((name) => !!unifiedToolRegistry.get(name));
  const agentTools = unifiedToolRegistry.toAgentTools(existing);

  return agentTools.map((agentTool): AgentTool => {
    const def = unifiedToolRegistry.get(agentTool.name)!;
    return {
      ...agentTool,
      execute: async (toolCallId, params, signal) => {
        const context: UnifiedToolContext = {
          taskId: parentTaskId ?? '',
          workspaceDir,
          abortSignal: signal,
          callId: toolCallId,
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
