import { describe, expect, it } from 'vitest';
import {
  createProviderHostedCallMessage,
  createProviderHostedResultMessage,
} from './provider-hosted-messages.js';

describe('Provider hosted tool message projection', () => {
  it('persists a provider-executed call as a standard assistant tool message', () => {
    const message = createProviderHostedCallMessage({
      id: 'search-1',
      toolName: 'web_search',
      args: {},
      summary: '搜索网页',
      providerExecuted: true,
    }, '2026-07-29T10:00:00.000Z');

    expect(message).toMatchObject({
      role: 'assistant',
      content: '',
      providerExecuted: true,
      createdAt: '2026-07-29T10:00:00.000Z',
      toolCalls: [{
        id: 'search-1',
        providerExecuted: true,
        function: {
          name: 'web_search',
          arguments: '{}',
          summary: '搜索网页',
        },
      }],
    });
  });

  it('persists a provider result as a paired tool message without search payload details', () => {
    const message = createProviderHostedResultMessage({
      callId: 'search-1',
      ok: true,
      output: { sources: ['should-not-leak'] },
      providerExecuted: true,
    }, '2026-07-29T10:00:01.000Z');

    expect(message).toMatchObject({
      role: 'tool',
      content: '{}',
      toolCallId: 'search-1',
      providerExecuted: true,
      createdAt: '2026-07-29T10:00:01.000Z',
    });
  });
});
