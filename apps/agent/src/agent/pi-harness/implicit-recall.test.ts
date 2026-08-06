import { describe, expect, it, vi } from 'vitest';
import type { MemorySystemMessage } from '../context.js';
import {
  buildImplicitRecallPrompt,
  formatImplicitRecallSections,
  selectImplicitRecallQuery,
} from './implicit-recall.js';

function memoryResult(content: string, citationCount = 1): MemorySystemMessage {
  return {
    message: content ? {
      id: 'memory-system',
      role: 'system',
      content,
      createdAt: '2026-08-05T00:00:00.000Z',
    } : null,
    citations: Array.from({ length: citationCount }, (_, index) => ({
      sourceId: `memory-${index}`,
      sourceType: 'memory' as const,
      content: `memory-${index}`,
      score: 1,
    })),
  };
}

function kbResult(content: string, count = 1) {
  const results = Array.from({ length: count }, (_, index) => ({
    chunkId: `chunk-${index}`,
    filePath: `/workspace/doc-${index}.md`,
    content,
    score: 0.9,
    chunkIndex: index,
  }));
  return {
    results,
    citations: results.map((result) => ({
      sourceId: result.chunkId,
      sourceType: 'kb_chunk' as const,
      content: result.content,
      score: result.score,
      filePath: result.filePath,
      chunkIndex: result.chunkIndex,
    })),
  };
}

describe('implicit recall orchestration', () => {
  it('prefers the latest user message and runs enabled sources independently', async () => {
    const memoryRecall = vi.fn(async (query: string) => memoryResult(`[记忆] ${query}`));
    const kbRecall = vi.fn(async (query: string, topK: number) => kbResult(`[KB] ${query} (${topK})`));
    const sources: string[] = [];

    const prompt = await buildImplicitRecallPrompt(
      {
        goal: '原始目标',
        messages: [
          { role: 'user', content: '第一条', id: 'u1', createdAt: '' },
          { role: 'assistant', content: '回答', id: 'a1', createdAt: '' },
          { role: 'user', content: '  最新问题  ', id: 'u2', createdAt: '' },
        ],
      },
      {
        memoryEnabled: true,
        kbEnabled: true,
        memoryRecall,
        kbRecall,
        onSource: ({ source }) => sources.push(source),
      },
    );

    expect(memoryRecall).toHaveBeenCalledWith('最新问题');
    expect(kbRecall).toHaveBeenCalledWith('最新问题', 4);
    expect(prompt).toContain('[记忆] 最新问题');
    expect(prompt).toContain('[相关知识库片段]');
    expect(sources).toEqual(['memory', 'knowledge_base']);
  });

  it('keeps the other source when one source fails', async () => {
    const errors: string[] = [];
    const prompt = await buildImplicitRecallPrompt(
      { goal: 'goal', messages: [] },
      {
        memoryEnabled: true,
        kbEnabled: true,
        memoryRecall: async () => { throw new Error('embedding unavailable'); },
        kbRecall: async () => kbResult('可用知识'),
        onError: ({ source }) => errors.push(source),
      },
    );

    expect(errors).toEqual(['memory']);
    expect(prompt).toContain('可用知识');
  });

  it('does not exceed the shared character budget across sections', () => {
    const prompt = formatImplicitRecallSections(['记忆'.repeat(100), 'KB'.repeat(100)], 25);
    expect(prompt.length).toBeLessThanOrEqual(25);
    expect(prompt).toBe('记忆'.repeat(12) + '记');
  });

  it('returns no prompt when both sources are disabled or the query is empty', async () => {
    const memoryRecall = vi.fn(async () => memoryResult('unexpected'));
    const kbRecall = vi.fn(async () => kbResult('unexpected'));
    const task = { goal: '   ', messages: [] };

    await expect(buildImplicitRecallPrompt(task, {
      memoryEnabled: false,
      kbEnabled: false,
      memoryRecall,
      kbRecall,
    })).resolves.toBe('');
    expect(memoryRecall).not.toHaveBeenCalled();
    expect(kbRecall).not.toHaveBeenCalled();
    expect(selectImplicitRecallQuery(task)).toBe('');
  });
});
