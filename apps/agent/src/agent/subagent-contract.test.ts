import { Schema } from 'effect';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerEffectTool } from '../tool/effect-bridge.js';
import { make } from '../tool/framework/definition.js';
import { initializeUnifiedToolFramework } from '../tool/index.js';
import { unifiedToolRegistry } from '../tool/unified-registry.js';

describe('subagent tool contract', () => {
  beforeAll(() => initializeUnifiedToolFramework());

  afterEach(() => {
    unifiedToolRegistry.unregister('test_context_probe');
  });

  it('exposes only the canonical delegate entry with an effective turn limit', () => {
    const names = unifiedToolRegistry.listNames();
    expect(names).toContain('delegate');
    expect(names).not.toContain('delegate_task');
    expect(names).not.toContain('present_ui');

    const inputSchema = unifiedToolRegistry.get('delegate')?.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(inputSchema.properties).toHaveProperty('maxIterations');
    expect(unifiedToolRegistry.riskLevelOf('delegate')).toBe('safe');
  });

  it('forwards cancellation and progress capabilities through the Effect bridge', async () => {
    const probe = make({
      name: 'test_context_probe',
      description: 'test only',
      input: Schema.Struct({}),
      output: Schema.Struct({ hasSignal: Schema.Boolean, hasPublisher: Schema.Boolean }),
      execute: async (_input, ctx) => ({
        hasSignal: ctx.abortSignal instanceof AbortSignal,
        hasPublisher: typeof ctx.publishEvent === 'function',
      }),
    });
    registerEffectTool(probe);

    const controller = new AbortController();
    const result = await unifiedToolRegistry.get('test_context_probe')!.execute({}, {
      taskId: 'task-test',
      workspaceDir: process.cwd(),
      abortSignal: controller.signal,
      callId: 'call-test',
      publishEvent: () => undefined,
    });

    expect(result).toEqual({ hasSignal: true, hasPublisher: true });
  });
});
