import { describe, expect, it } from 'vitest';
import { initializeUnifiedToolFramework } from '../../index.js';
import { unifiedToolRegistry } from '../../unified-registry.js';
import { memoryStore } from '../../../store/db.js';

/**
 * remember 曾经是个空壳：返回 created:true 却不写库，模型每轮都以为记住了。
 * 这些用例锁住「真的落库」这一契约——不要改成只断言返回值。
 */
describe('remember tool', () => {
  it('persists to memoryStore with agent provenance', async () => {
    initializeUnifiedToolFramework();
    const before = memoryStore.count();
    const marker = `test-${Math.random().toString(36).slice(2, 10)}`;

    const res = await unifiedToolRegistry.get('remember')!.execute(
      {
        content: `${marker} 用户偏好简洁输出`,
        category: 'preference',
        why: '反复出现',
        howToApply: '回答时省略铺垫',
      },
      { taskId: 'task-abc', workspaceDir: '/tmp', callId: 'call-1' },
    ) as { id: string; created: boolean };

    expect(res.created).toBe(true);
    expect(memoryStore.count()).toBe(before + 1);

    const stored = memoryStore.get(res.id);
    expect(stored?.content).toContain(marker);
    expect(stored?.category).toBe('preference');
    expect(stored?.enabled).toBe(true);
    // 来源可追溯是记忆功能的可解释性要求
    expect(stored?.source.origin).toBe('agent');
    expect(stored?.source.taskId).toBe('task-abc');
    expect(stored?.why).toBe('反复出现');
    expect(stored?.howToApply).toBe('回答时省略铺垫');

    memoryStore.delete(res.id);
    expect(memoryStore.count()).toBe(before);
  });

  it('defaults category and confidence, clamps out-of-range confidence', async () => {
    const before = memoryStore.count();
    const res = await unifiedToolRegistry.get('remember')!.execute(
      { content: '无分类记忆', confidence: 42 },
      { taskId: '', workspaceDir: '/tmp', callId: 'call-2' },
    ) as { id: string };

    const stored = memoryStore.get(res.id);
    expect(stored?.category).toBe('other');
    expect(stored?.confidence).toBe(1);
    // 空 taskId 不应写成空字符串
    expect(stored?.source.taskId).toBeUndefined();

    memoryStore.delete(res.id);
    expect(memoryStore.count()).toBe(before);
  });

  it('fails loudly on empty content instead of storing a blank memory', async () => {
    const before = memoryStore.count();
    await expect(
      unifiedToolRegistry.get('remember')!.execute(
        { content: '   ' },
        { taskId: 't', workspaceDir: '/tmp', callId: 'call-3' },
      ),
    ).rejects.toThrow(/content 不能为空/);
    expect(memoryStore.count()).toBe(before);
  });

  it('recall resolves to the knowledge-base implementation only', async () => {
    // 曾经 tools/memory/recall.ts 的空壳与 simple-tools 的真实实现同名，靠注册顺序决胜负。
    const res = await unifiedToolRegistry.get('recall')!.execute(
      { query: 'test' },
      { taskId: 't', workspaceDir: '/tmp', callId: 'call-4' },
    );
    expect(Array.isArray(res)).toBe(false);
    expect(res).toHaveProperty('found');
    expect(res).toHaveProperty('results');
  });
});
