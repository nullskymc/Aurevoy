import type { Message } from '@aurevoy/shared';
import { describe, expect, it } from 'vitest';
import { mergeDurableTaskMessages, toPiMessage } from './runtime.js';

function message(id: string, role: Message['role'], content: string): Message {
  return {
    id,
    role,
    content,
    createdAt: `2026-07-29T00:00:0${id.length}.000Z`,
  };
}

describe('Pi runtime durable message reconciliation', () => {
  it('preserves a steering user message already appended by the HTTP task instance', () => {
    const original = message('original', 'user', '财经简报');
    const assistant = message('answer', 'assistant', '财经终稿');
    const steering = message('steering', 'user', '你好');
    const steeringAnswer = message('steering-answer', 'assistant', '你好！');

    const durable = [original, assistant, steering, steeringAnswer];
    const staleRuntime = [original, assistant, steeringAnswer];

    expect(mergeDurableTaskMessages(durable, staleRuntime).map((item) => item.id)).toEqual([
      'original',
      'answer',
      'steering',
      'steering-answer',
    ]);
  });

  it('keeps an in-memory terminal message that has not been appended yet', () => {
    const original = message('original', 'user', 'goal');
    const failure = message('failure', 'assistant', '任务失败');

    expect(mergeDurableTaskMessages([original], [original, failure]).map((item) => item.id))
      .toEqual(['original', 'failure']);
  });

  it('keeps rich content blocks appended to an already durable assistant message', () => {
    const durableAssistant = {
      ...message('assistant', 'assistant', ''),
      toolCalls: [{
        id: 'attach-1',
        type: 'function' as const,
        function: { name: 'attach_content', arguments: '{}' },
      }],
    };
    const reportBlock = {
      id: 'report',
      type: 'file_reference' as const,
      content: '/tmp/research/report.md',
      name: 'report.md',
      mimeType: 'text/markdown',
      source: 'tool' as const,
    };
    const chartBlock = {
      id: 'chart',
      type: 'image' as const,
      content: '/tmp/research/chart.png',
      name: 'chart.png',
      mimeType: 'image/png',
      source: 'tool' as const,
    };
    const memoryAssistant = {
      ...durableAssistant,
      contentBlocks: [reportBlock, chartBlock],
    };

    const [merged] = mergeDurableTaskMessages([durableAssistant], [memoryAssistant]);

    expect(merged.contentBlocks).toEqual([reportBlock, chartBlock]);
    expect(merged.toolCalls).toEqual(durableAssistant.toolCalls);
  });

  it('retains durable blocks and applies a runtime update for the same block id', () => {
    const durable = {
      ...message('assistant', 'assistant', ''),
      contentBlocks: [{
        id: 'report',
        type: 'file_reference' as const,
        content: '/tmp/old-report.md',
      }],
    };
    const updated = {
      ...durable,
      contentBlocks: [{
        id: 'report',
        type: 'file_reference' as const,
        content: '/tmp/new-report.md',
      }, {
        id: 'chart',
        type: 'image' as const,
        content: '/tmp/chart.png',
      }],
    };

    const [merged] = mergeDurableTaskMessages([durable], [updated]);

    expect(merged.contentBlocks).toEqual(updated.contentBlocks);
  });

  it('does not replay provider-hosted calls through the local Pi tool executor', async () => {
    const call: Message = {
      ...message('hosted-call', 'assistant', ''),
      providerExecuted: true,
      toolCalls: [{
        id: 'search-1',
        type: 'function',
        providerExecuted: true,
        function: {
          name: 'web_search',
          arguments: '{}',
        },
      }],
    };
    const result: Message = {
      ...message('hosted-result', 'tool', '{}'),
      toolCallId: 'search-1',
      providerExecuted: true,
    };

    await expect(toPiMessage(call, new Map(), {} as never)).resolves.toEqual([]);
    await expect(toPiMessage(result, new Map(), {} as never)).resolves.toEqual([]);
  });
});
