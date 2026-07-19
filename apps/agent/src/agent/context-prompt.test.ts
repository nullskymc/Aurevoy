import { describe, expect, it } from 'vitest';
import type { Message } from '@aurevoy/shared';
import {
  applyZeroCostCompaction,
  buildAgentIdentityMessage,
  buildStableSystemPromptParts,
  buildStableWorkspaceContextMessage,
  buildSystemContextMessage,
  buildToolGuidanceMessage,
  buildVolatileSystemPromptParts,
  buildVolatileTimeContextMessage,
  compactToolResult,
  joinSystemPromptParts,
} from './context.js';
import { compactPiMessagesCacheAware } from './pi-harness.js';
import type { Message as PiMessage } from '@earendil-works/pi-ai/compat';

function msg(
  partial: Pick<Message, 'role' | 'content'> & Partial<Message>,
): Message {
  return {
    id: partial.id ?? `m-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: partial.createdAt ?? '2026-01-01T00:00:00.000Z',
    role: partial.role,
    content: partial.content,
    toolCalls: partial.toolCalls,
    toolCallId: partial.toolCallId,
  };
}

function serializeMessages(messages: Message[]): string {
  return JSON.stringify(
    messages.map((m) => ({
      role: m.role,
      content: m.content,
      toolCallId: m.toolCallId ?? null,
      toolCalls: m.toolCalls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
      })) ?? null,
    })),
  );
}

function serializePiMessages(messages: PiMessage[]): string {
  return JSON.stringify(
    messages.map((m) => {
      if (m.role === 'toolResult') {
        return {
          role: m.role,
          toolCallId: m.toolCallId,
          toolName: m.toolName,
          content: m.content,
        };
      }
      if (m.role === 'assistant') {
        return { role: m.role, content: m.content };
      }
      if (m.role === 'user') {
        return { role: m.role, content: m.content };
      }
      return { role: (m as { role: string }).role };
    }),
  );
}

describe('main agent system prompt builders', () => {
  it('identity states product contract without obsolete file tools', () => {
    const identity = buildAgentIdentityMessage();
    expect(identity.role).toBe('system');
    expect(identity.content).toContain('Aurevoy');
    expect(identity.content).toContain('attach_content');
    expect(identity.content).not.toContain('present_ui');
    expect(identity.content).not.toContain('open_file');
    expect(identity.content).not.toContain('write_file');
    expect(identity.content).not.toContain('session_open');
    // Universal communication / control contract (no incident-specific examples)
    expect(identity.content).toMatch(/Text is for the user/i);
    expect(identity.content).toMatch(/question or status check/i);
    expect(identity.content).not.toMatch(/zotero|MCP client|GitHub README/i);
  });

  it('operating protocol covers real tools, delivery, and multi-agent', () => {
    const guidance = buildToolGuidanceMessage();
    const text = guidance.content;

    expect(text).toContain('<operating_protocol>');
    expect(text).toContain('</operating_protocol>');

    for (const name of ['read', 'write', 'edit', 'grep', 'glob', 'bash', 'list_directory']) {
      expect(text).toContain(name);
    }

    for (const name of ['attach_content', 'bundle_report', 'research']) {
      expect(text).toContain(name);
    }
    expect(text).not.toContain('present_ui');
    expect(text).toContain('Inline conversation UI is temporarily unavailable');
    expect(text).not.toContain('data_table');
    expect(text).toContain('research` is for research and file reports');

    expect(text).toContain('delegate');
    for (const role of ['explore', 'research', 'coder', 'shell', 'writer', 'general']) {
      expect(text).toContain(role);
    }

    expect(text).toContain('open_file');
    expect(text).toMatch(/Do not invent obsolete tools/);

    // Universal communication rules — no product/incident-specific recipes
    expect(text).toContain('## Communication');
    expect(text).not.toContain('OpenCode-style');
    expect(text).toMatch(/tools only to complete tasks/i);
    expect(text).toMatch(/non-trivial `bash`/i);
    expect(text).toMatch(/answer in text this turn before any further tool calls/i);
    expect(text).not.toMatch(/装了啥|遇到了什么问题|zotero|MCP client|GitHub README/i);
  });

  it('system context keeps workspace facts and minute-precision time', () => {
    const systemContext = buildSystemContextMessage('/tmp/ws');
    expect(systemContext.content).toContain('<system_context>');
    expect(systemContext.content).toContain('Workspace: /tmp/ws');
    // ISO timestamp truncated to :00Z (minute precision)
    expect(systemContext.content).toMatch(/Current time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z/);
    // stable facts appear before wall-clock so time churn only touches the tail
    const workspaceIdx = systemContext.content.indexOf('Workspace:');
    const timeIdx = systemContext.content.indexOf('Current time:');
    expect(workspaceIdx).toBeGreaterThanOrEqual(0);
    expect(timeIdx).toBeGreaterThan(workspaceIdx);
  });

  it('pinned full system (stable + frozen time) stays byte-identical across a minute boundary', () => {
    const t0 = new Date('2026-07-16T10:00:30.123Z');
    const t1 = new Date('2026-07-16T10:01:45.999Z'); // crosses minute boundary

    const stableA = joinSystemPromptParts(buildStableSystemPromptParts({ workspaceDir: '/tmp/ws' }));
    const stableB = joinSystemPromptParts(buildStableSystemPromptParts({ workspaceDir: '/tmp/ws' }));
    expect(stableA).toBe(stableB);

    // Production pins time once at run start — simulate by freezing `now` into the full prompt.
    const pinned = joinSystemPromptParts(
      [stableA],
      buildVolatileSystemPromptParts({ now: t0, attachmentContent: null }),
    );
    // Even if wall clock advances, the pinned string must be reused as-is (not rebuilt with t1).
    const stillPinned = pinned;
    expect(stillPinned).toBe(pinned);
    expect(pinned).toContain('Current time: 2026-07-16T10:00:00Z');
    expect(pinned).not.toContain('Current time: 2026-07-16T10:01:00Z');

    // Rebuilding with a later clock would diverge — that path is forbidden mid-run.
    const rebuiltLater = joinSystemPromptParts(
      [stableB],
      buildVolatileSystemPromptParts({ now: t1, attachmentContent: null }),
    );
    expect(rebuiltLater).not.toBe(pinned);

    // Identity + protocol + workspace must sit before time; attachments stay out of system.
    expect(stableA).toContain('You are Aurevoy');
    expect(stableA).toContain('<operating_protocol>');
    expect(stableA).toContain('Workspace: /tmp/ws');
    expect(stableA).not.toContain('Current time:');
    expect(stableA).not.toContain('[Attached Files]');
    expect(pinned.startsWith(stableA)).toBe(true);
  });

  it('attachments are not part of the stable system prefix', () => {
    const stable = joinSystemPromptParts(buildStableSystemPromptParts({ workspaceDir: '/proj' }));
    expect(stable).not.toContain('[Attached Files]');
    // Compatibility helper may still append attachments for tests, but production
    // mounts file bodies on the user message only.
    const withAttach = joinSystemPromptParts(
      [stable],
      buildVolatileSystemPromptParts({
        now: new Date('2026-07-16T12:00:00.000Z'),
        attachmentContent: '[Attached Files]\n\n### notes.md\n\nhello world\n',
      }),
    );
    expect(withAttach.startsWith(stable)).toBe(true);
    expect(withAttach).toContain('[Attached Files]');
  });

  it('stable workspace context excludes wall-clock fields', () => {
    const workspace = buildStableWorkspaceContextMessage('/ws', '/cfg', { name: 'Demo', path: '/ws' });
    expect(workspace.content).toContain('Workspace: /ws');
    expect(workspace.content).toContain('Project: Demo');
    expect(workspace.content).not.toContain('Current time');
    expect(workspace.content).not.toContain('Today:');

    const time = buildVolatileTimeContextMessage(new Date('2026-07-16T08:15:22.500Z'));
    expect(time.content).toContain('Current time: 2026-07-16T08:15:00Z');
  });
});

describe('cache-aware zero-cost compaction prefix stability', () => {
  const largeWebSearch = JSON.stringify({
    query: 'aurevoy cache',
    resultCount: 12,
    results: Array.from({ length: 12 }, (_, i) => ({
      title: `Result ${i}`,
      snippet: `Long snippet number ${i} `.repeat(20),
      url: `https://example.com/${i}`,
    })),
  });

  function historyWithToolTurn(extraTail: Message[] = []): Message[] {
    return [
      msg({ role: 'user', content: 'search docs' }),
      msg({
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call-empty',
            type: 'function',
            function: { name: 'web_search', arguments: '{}' },
          },
          {
            id: 'call-search',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"aurevoy cache"}' },
          },
        ],
      }),
      msg({ role: 'tool', content: '{}', toolCallId: 'call-empty' }),
      msg({ role: 'tool', content: largeWebSearch, toolCallId: 'call-search' }),
      ...extraTail,
    ];
  }

  it('snips empty tool results and microcompacts large web_search JSON', () => {
    const compacted = applyZeroCostCompaction(historyWithToolTurn());
    expect(compacted.some((m) => m.toolCallId === 'call-empty')).toBe(false);
    const search = compacted.find((m) => m.toolCallId === 'call-search');
    expect(search).toBeDefined();
    expect(search!.content).toContain('"_compacted":true');
    expect(search!.content.length).toBeLessThan(largeWebSearch.length);
    // Matches compactToolResult for the same raw payload
    expect(search!.content).toBe(compactToolResult('web_search', largeWebSearch));
  });

  it('successive transforms with only tail growth keep prior prefix bytes identical', () => {
    const turn1Session = historyWithToolTurn();
    const turn1Sent = applyZeroCostCompaction(turn1Session);
    const turn1Prefix = serializeMessages(turn1Sent);

    // Session keeps uncompacted originals; append one more tool turn
    const turn2Session = historyWithToolTurn([
      msg({
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call-fetch',
            type: 'function',
            function: { name: 'web_fetch', arguments: '{"url":"https://example.com/0"}' },
          },
        ],
      }),
      msg({
        role: 'tool',
        toolCallId: 'call-fetch',
        content: JSON.stringify({
          url: 'https://example.com/0',
          status: 200,
          contentType: 'text/html',
          content: 'x'.repeat(2000),
          links: [{ href: '/a' }, { href: '/b' }],
        }),
      }),
    ]);

    const turn2Sent = applyZeroCostCompaction(turn2Session);
    const turn2Prefix = serializeMessages(turn2Sent.slice(0, turn1Sent.length));

    expect(turn2Prefix).toBe(turn1Prefix);
    // Newly appended tail is compacted; prior region not re-expanded to full JSON
    const priorSearch = turn2Sent.find((m) => m.toolCallId === 'call-search');
    expect(priorSearch?.content).toContain('"_compacted":true');
    expect(priorSearch?.content).not.toBe(largeWebSearch);
    const fetch = turn2Sent.find((m) => m.toolCallId === 'call-fetch');
    expect(fetch?.content).toContain('"_compacted":true');
  });

  it('does not re-mutate already-compacted tool results on a later pass', () => {
    const session = historyWithToolTurn();
    const once = applyZeroCostCompaction(session);
    // Simulate a transform that already received compacted content (e.g. rare re-entry)
    const twice = applyZeroCostCompaction(once);
    expect(serializeMessages(twice)).toBe(serializeMessages(once));
  });

  it('microcompacts bash and read tool results (not only execute_command)', () => {
    const longOut = 'line\n'.repeat(400);
    const bashRaw = JSON.stringify({ exit: 0, output: longOut, truncated: false });
    const readRaw = longOut.repeat(2);
    expect(compactToolResult('bash', bashRaw)).toContain('"_compacted":true');
    expect(compactToolResult('bash', bashRaw)).toContain('output_tail');
    expect(compactToolResult('execute_command', bashRaw)).toContain('"_compacted":true');
    expect(compactToolResult('read', readRaw)).toContain('"_compacted":true');
    expect(compactToolResult('grep', Array.from({ length: 30 }, (_, i) => `f.ts:${i}:hit`).join('\n'))).toContain(
      '"_compacted":true',
    );
  });
});

describe('Pi cache-aware compactPiMessagesCacheAware multi-turn prefix', () => {
  function piUser(text: string): PiMessage {
    return {
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: 1,
    } as PiMessage;
  }

  function piAssistantWithCalls(
    calls: Array<{ id: string; name: string }>,
  ): PiMessage {
    return {
      role: 'assistant',
      content: calls.map((c) => ({
        type: 'toolCall',
        id: c.id,
        name: c.name,
        arguments: {},
      })),
      api: 'openai-completions',
      provider: 'openai',
      model: 'test',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse',
      timestamp: 2,
    } as PiMessage;
  }

  function piToolResult(id: string, name: string, text: string): PiMessage {
    return {
      role: 'toolResult',
      toolCallId: id,
      toolName: name,
      content: [{ type: 'text', text }],
      isError: false,
      timestamp: 3,
    } as PiMessage;
  }

  it('preserves compacted prefix when session refeeds originals and appends a turn', () => {
    const large = JSON.stringify({
      query: 'q',
      resultCount: 10,
      results: Array.from({ length: 10 }, (_, i) => ({
        title: `T${i}`,
        snippet: `S${i}`.repeat(40),
        url: `https://ex.com/${i}`,
      })),
    });

    const turn1 = [
      piUser('go'),
      piAssistantWithCalls([
        { id: 'e1', name: 'web_search' },
        { id: 's1', name: 'web_search' },
      ]),
      piToolResult('e1', 'web_search', '{}'),
      piToolResult('s1', 'web_search', large),
    ];

    const toolText = (m: PiMessage | undefined): string => {
      if (!m || m.role !== 'toolResult' || !Array.isArray(m.content)) return '';
      return m.content
        .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: string }).text) : ''))
        .join('');
    };

    const sent1 = compactPiMessagesCacheAware(turn1);
    expect(sent1.some((m) => m.role === 'toolResult' && m.toolCallId === 'e1')).toBe(false);
    const search1 = sent1.find((m) => m.role === 'toolResult' && m.toolCallId === 's1');
    const search1Text = toolText(search1);
    expect(search1Text).toContain('"_compacted":true');
    expect(search1Text.length).toBeLessThan(large.length);

    const turn2 = [
      ...turn1, // originals again
      piAssistantWithCalls([{ id: 'f1', name: 'web_fetch' }]),
      piToolResult(
        'f1',
        'web_fetch',
        JSON.stringify({
          url: 'https://ex.com/0',
          status: 200,
          content: 'body'.repeat(500),
          links: [],
        }),
      ),
    ];

    const sent2 = compactPiMessagesCacheAware(turn2);
    const prefix2 = serializePiMessages(sent2.slice(0, sent1.length));
    expect(prefix2).toBe(serializePiMessages(sent1));

    const search2 = sent2.find((m) => m.role === 'toolResult' && m.toolCallId === 's1');
    const search2Text = toolText(search2);
    expect(search2Text).toContain('"_compacted":true');
    expect(search2Text).toBe(search1Text);
    expect(search2Text).not.toBe(large);
  });
});
