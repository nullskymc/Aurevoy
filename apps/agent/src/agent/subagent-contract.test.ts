import { Schema } from 'effect';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerEffectTool } from '../tool/effect-bridge.js';
import { make } from '../tool/framework/definition.js';
import { getAgentToolsForPi, initializeUnifiedToolFramework } from '../tool/index.js';
import { unifiedToolRegistry } from '../tool/unified-registry.js';
import { skillRegistry } from '../skills/registry.js';

describe('subagent tool contract', () => {
  beforeAll(() => {
    skillRegistry.load();
    initializeUnifiedToolFramework();
  });

  afterEach(() => {
    unifiedToolRegistry.unregister('test_context_probe');
  });

  it('exposes only the canonical delegate entry without turn/duration caps', () => {
    const names = unifiedToolRegistry.listNames();
    expect(names).toContain('delegate');
    expect(names).not.toContain('delegate_task');
    expect(names).toContain('present_ui');

    const inputSchema = unifiedToolRegistry.get('delegate')?.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(inputSchema.properties).toHaveProperty('goal');
    expect(inputSchema.properties).toHaveProperty('role');
    expect(inputSchema.properties).not.toHaveProperty('maxIterations');
    expect(inputSchema.properties).not.toHaveProperty('timeoutMs');
    expect(unifiedToolRegistry.riskLevelOf('delegate')).toBe('safe');
  });

  it('accepts local canvas fragments and rejects networked scripts', async () => {
    const presentUi = unifiedToolRegistry.get('present_ui');
    expect(presentUi).toBeDefined();
    const toolContext = { taskId: 'test-task', workspaceDir: '/tmp/ws', callId: 'call-1' };

    const staticResult = await presentUi!.execute({
      kind: 'canvas',
      id: 'demo-explorer',
      props: { html: '<section><h2>Demo</h2></section>' },
    }, toolContext);
    expect(staticResult).toMatchObject({
      contentBlock: {
        id: 'demo-explorer',
        type: 'ui',
        kind: 'canvas',
        props: { html: '<section><h2>Demo</h2></section>' },
      },
    });

    const interactiveResult = await presentUi!.execute({
      kind: 'canvas',
      props: {
        html: '<button id="filter">Filter</button>',
        script: 'document.querySelector("#filter").textContent = "Ready";',
      },
    }, toolContext);
    expect(interactiveResult).toMatchObject({
      contentBlock: { type: 'ui', kind: 'canvas' },
    });

    const rejectedResult = await presentUi!.execute({
      kind: 'canvas',
      props: {
        html: '<output id="result"></output>',
        script: 'fetch("https://example.com/data.json")',
      },
    }, toolContext);
    expect(rejectedResult).toMatchObject({
      ok: false,
      error: expect.stringContaining('不得访问网络'),
    });
  });

  it('gates present_ui on the visualize skill being enabled', () => {
    // 工具始终在注册表里，但只有 visualize 启用时才进入模型可见的工具面。
    expect(unifiedToolRegistry.listNames()).toContain('present_ui');
    expect(getAgentToolsForPi().map((tool) => tool.name)).toContain('present_ui');

    const isEnabled = vi.spyOn(skillRegistry, 'isEnabled').mockImplementation((name) => name !== 'visualize');
    try {
      const gated = getAgentToolsForPi().map((tool) => tool.name);
      expect(gated).not.toContain('present_ui');
      // 其余工具不受影响
      expect(gated).toContain('attach_content');
      expect(gated).toContain('delegate');
    } finally {
      isEnabled.mockRestore();
    }
  });

  it('forwards cancellation and progress capabilities through the Effect bridge', async () => {
    const probe = make({
      name: 'test_context_probe',
      riskLevel: 'safe',
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
