import type { Message } from '@aurevoy/shared';
import type { AgentHarness } from '@earendil-works/pi-agent-core';
import { describe, expect, it, vi } from 'vitest';
import { ActivePiTaskController } from './active-controller.js';

function message(id: string, content: string): Message {
  return {
    id,
    role: 'user',
    content,
    createdAt: `2026-07-29T00:00:00.000Z`,
  };
}

const convert = async (input: Message) => ({ text: input.content, images: [] });

function makeHarness(overrides: {
  steer?: () => Promise<void>;
  followUp?: () => Promise<void>;
  steerQueue?: unknown[];
  followUpQueue?: unknown[];
  emitQueueUpdate?: () => Promise<void>;
}): AgentHarness {
  return {
    steer: overrides.steer ?? (() => Promise.resolve()),
    followUp: overrides.followUp ?? (() => Promise.resolve()),
    steerQueue: overrides.steerQueue ?? [],
    followUpQueue: overrides.followUpQueue ?? [],
    emitQueueUpdate: overrides.emitQueueUpdate ?? (() => Promise.resolve()),
  } as unknown as AgentHarness;
}

describe('ActivePiTaskController 投递可靠性', () => {
  it('harness 未 attach 时入缓冲队列并视为已受理', async () => {
    const controller = new ActivePiTaskController(convert);
    await expect(controller.enqueueSteering(message('a', 'hi'))).resolves.toBe(true);
    await expect(controller.enqueueFollowUp(message('b', 'later'))).resolves.toBe(true);
  });

  it('attach 时把缓冲消息统一投递到 harness', async () => {
    const controller = new ActivePiTaskController(convert);
    await controller.enqueueSteering(message('a', 'steer-me'));
    const harness = makeHarness({});
    const steerSpy = vi.spyOn(harness, 'steer');
    controller.attach(harness);
    await Promise.resolve();
    expect(steerSpy).toHaveBeenCalledWith('steer-me', undefined);
  });

  it('steer 成功时投递结果为 true', async () => {
    const controller = new ActivePiTaskController(convert);
    controller.attach(makeHarness({}));
    await expect(controller.enqueueSteering(message('a', 'ok'))).resolves.toBe(true);
  });

  it('steer 拒绝（run 已收尾）时投递结果为 false，而不抛出', async () => {
    const controller = new ActivePiTaskController(convert);
    controller.attach(makeHarness({ steer: () => Promise.reject(new Error('harness settled')) }));
    await expect(controller.enqueueSteering(message('a', 'too late'))).resolves.toBe(false);
  });

  it('followUp 拒绝时投递结果为 false，而不抛出', async () => {
    const controller = new ActivePiTaskController(convert);
    controller.attach(makeHarness({ followUp: () => Promise.reject(new Error('harness settled')) }));
    await expect(controller.enqueueFollowUp(message('a', 'too late'))).resolves.toBe(false);
  });

  it('按 kind 撤回尚未注入的队列并发布 queue_update', async () => {
    const controller = new ActivePiTaskController(convert);
    const emitQueueUpdate = vi.fn(() => Promise.resolve());
    const harness = makeHarness({
      steerQueue: [{ role: 'user', content: 'now' }],
      followUpQueue: [{ role: 'user', content: 'later' }],
      emitQueueUpdate,
    });
    controller.attach(harness);
    await expect(controller.clearQueue('steering')).resolves.toBe(true);
    expect((harness as unknown as { steerQueue: unknown[] }).steerQueue).toHaveLength(0);
    expect((harness as unknown as { followUpQueue: unknown[] }).followUpQueue).toHaveLength(1);
    expect(emitQueueUpdate).toHaveBeenCalledOnce();
  });
});
