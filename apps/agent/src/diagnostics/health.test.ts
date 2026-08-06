import { describe, expect, it } from 'vitest';
import { buildHealthDiagnostics } from './health.js';

describe('buildHealthDiagnostics', () => {
  it('keeps the contract ordered and derives the LLM readiness check', () => {
    const result = buildHealthDiagnostics({
      generatedAt: '2026-08-05T00:00:00.000Z',
      version: '0.7.0',
      uptimeMs: 42,
      llm: { state: 'no_credential', ready: false, provider: 'openai', model: 'fixture' },
      data: {
        dbPath: '/private/db',
        workspaceDir: '/private/workspace',
        cleanupPolicyDays: 30,
        counts: { tasks: 1, traces: 2, memories: 3, projects: 4 },
      },
      database: { status: 'ok', summary: 'SQLite quick check passed' },
      workspace: { status: 'ok', summary: 'Workspace directory is readable and writable' },
      embedding: { status: 'warning', summary: 'Embedding is disabled' },
      vectorStore: { status: 'ok', summary: 'sqlite-vec extension is loaded' },
      knowledgeBase: { status: 'warning', summary: 'No knowledge-base directory is configured' },
    });

    expect(result.version).toBe('0.7.0');
    expect(result.checks.map((check) => check.id)).toEqual([
      'llm', 'database', 'workspace', 'embedding', 'vector_store', 'knowledge_base',
    ]);
    expect(result.checks[0]).toMatchObject({ id: 'llm', status: 'warning', details: { state: 'no_credential' } });
  });
});
