import type { AnyTool } from './framework/definition.js';
import { unifiedToolRegistry, type UnifiedToolDef } from './unified-registry.js';
import type { ToolRiskLevel } from '@aurevoy/shared';

const RISK_MAP: Record<string, ToolRiskLevel> = {
  bash: 'dangerous',
  write: 'dangerous',
  edit: 'dangerous',
  delegate: 'safe',
  create_artifact: 'dangerous',
  apply_artifact: 'dangerous',
  web_fetch: 'caution',
};

function riskFor(tool: AnyTool): ToolRiskLevel {
  return RISK_MAP[tool.name] ?? 'safe';
}

export function registerEffectTool(tool: AnyTool): void {
  const unified: UnifiedToolDef = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputJSONSchema,
    riskLevel: riskFor(tool),
    source: { type: 'builtin' },
    execute: async (args, ctx) => {
      const rt = tool.runtime();
      const result = await rt.settle(args, {
        sessionID: ctx.taskId,
        taskID: ctx.taskId,
        agent: 'aurevoy',
        assistantMessageID: '',
        toolCallID: ctx.callId,
        workspaceDir: ctx.workspaceDir,
        externalPaths: ctx.externalPaths ?? [],
        abortSignal: ctx.abortSignal,
        publishEvent: ctx.publishEvent,
        task: ctx.task,
      });
      return result.output;
    },
  };
  unifiedToolRegistry.register(unified);
}

export function registerEffectTools(tools: readonly AnyTool[]): void {
  for (const tool of tools) {
    registerEffectTool(tool);
  }
}
