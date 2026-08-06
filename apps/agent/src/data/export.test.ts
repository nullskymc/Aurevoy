import { describe, expect, it } from 'vitest';
import type { RuntimeSettings, Task } from '@aurevoy/shared';
import { buildDataExportPayload } from './export.js';

function makeSettings(): RuntimeSettings {
  return {
    llm: {
      provider: 'openai',
      baseUrl: 'https://gateway.example/?token=secret-key',
      model: 'fixture-model',
      availableModels: ['fixture-model'],
      enabledModels: ['fixture-model'],
      imageInputModels: [],
      temperature: 0.7,
      timeoutMs: 120000,
      maxTokens: 8192,
      apiKeyConfigured: true,
      oauthConfigured: false,
      providers: [{
        provider: 'openai',
        baseUrl: 'https://gateway.example/?token=secret-key',
        model: 'fixture-model',
        availableModels: ['fixture-model'],
        enabledModels: ['fixture-model'],
        imageInputModels: [],
        apiKeyConfigured: true,
        oauthConfigured: false,
      }],
      providerCatalog: [],
    },
    workspaceDir: '/Users/example/private-workspace',
    commandExecutionEnabled: false,
    mcpServersJson: '{"headers":{"Authorization":"secret-key"}}',
    cleanupPolicyDays: 30,
    autoModeLevel: 'auto',
    autoModeSafetyEnabled: true,
    agentThinkingLevel: 'off',
    agentToolExecution: 'parallel',
    agentCacheRetention: 'long',
    agentAutoCompact: true,
    autoResumeInterruptedTasks: true,
    memoryRecallEnabled: true,
    kbRecallEnabled: true,
    budget: {
      run: { maxIterations: 10, maxToolCalls: 20, maxWallTimeMs: 1000, maxOutputBytes: 1000 },
      lifetime: { maxIterations: 100, maxToolCalls: 200, maxWallTimeMs: 10000, maxOutputBytes: 10000 },
    },
    dbPath: '/Users/example/private.sqlite',
    embedding: { provider: 'openai', model: 'embed-model', baseUrl: 'http://secret-host', apiKeyConfigured: true },
    pythonPath: '/private/python',
    search: { preferNative: false, provider: 'custom', baseUrl: 'http://secret-search', apiKeyConfigured: true },
    logging: { level: 'info', logFile: '/private/logs/aurevoy.log' },
    proxy: { enabled: true, url: 'http://user:password@proxy.example', noProxy: 'localhost' },
  };
}

function makeTask(): Task {
  return {
    id: 'task-1',
    goal: 'Diagnose the private project',
    title: 'Diagnose the private project',
    status: 'completed',
    phase: 'finalizing',
    plan: [],
    messages: [{
      id: 'message-1',
      role: 'assistant',
      content: 'A useful answer',
      createdAt: '2026-08-05T00:00:00.000Z',
      toolCalls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'read', arguments: '{"secret":"tool-secret"}', summary: 'read a file' },
      }],
      attachments: [{
        id: 'attachment-1',
        name: 'private.txt',
        path: '/Users/example/private.txt',
        mimeType: 'text/plain',
        size: 10,
        type: 'file',
        dataUrl: 'data:text/plain;base64,c2VjcmV0',
      }],
      imageParts: [{
        id: 'image-1',
        name: 'private.png',
        mimeType: 'image/png',
        size: 20,
        dataUrl: 'data:image/png;base64,secret-image',
      }],
      contentBlocks: [{
        id: 'block-1',
        type: 'file_reference',
        content: '/Users/example/private.txt',
        props: { html: '<script>secret</script>' },
      }],
    }],
    archivedMessages: [],
    artifacts: [{
      id: 'artifact-1',
      type: 'file',
      name: 'report.txt',
      content: 'private artifact body',
      appliedPath: '/Users/example/report.txt',
      status: 'applied',
      createdAt: '2026-08-05T00:00:00.000Z',
    }],
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
  };
}

describe('buildDataExportPayload', () => {
  it('projects sensitive runtime and filesystem fields out of the default export', () => {
    const payload = buildDataExportPayload({
      appVersion: '0.7.0',
      exportedAt: '2026-08-05T00:00:00.000Z',
      settings: makeSettings(),
      projects: [{ id: 'project-1', name: 'Private', path: '/Users/example/project', createdAt: 'now', updatedAt: 'now' }],
      memories: [],
      tasks: [makeTask()],
      kbDirs: [{ id: 'kb-1', dirPath: '/Users/example/docs', recursive: true, enabled: true, createdAt: 'now', updatedAt: 'now' }],
      kbStatus: { totalFiles: 1, totalChunks: 2, lastIndexed: 'now' },
      includeTaskMessages: false,
    });

    const serialized = JSON.stringify(payload);
    expect(payload.tasks[0].messages).toBeUndefined();
    expect(payload.projects[0]).not.toHaveProperty('path');
    expect(payload.knowledgeBase.dirs[0]).not.toHaveProperty('dirPath');
    expect(payload.settings).not.toHaveProperty('mcpServersJson');
    expect(payload.settings).not.toHaveProperty('dbPath');
    expect(serialized).not.toContain('secret-key');
    expect(serialized).not.toContain('private-workspace');
    expect(serialized).not.toContain('tool-secret');
    expect(serialized).not.toContain('secret-image');
  });

  it('includes message text while retaining only safe attachment and tool metadata when opted in', () => {
    const payload = buildDataExportPayload({
      appVersion: '0.7.0',
      exportedAt: '2026-08-05T00:00:00.000Z',
      settings: makeSettings(),
      projects: [],
      memories: [],
      tasks: [makeTask()],
      kbDirs: [],
      kbStatus: { totalFiles: 0, totalChunks: 0, lastIndexed: null },
      includeTaskMessages: true,
    });
    const message = payload.tasks[0].messages?.[0];

    expect(message?.content).toBe('A useful answer');
    expect(message?.attachments?.[0]).toEqual({
      id: 'attachment-1', name: 'private.txt', mimeType: 'text/plain', size: 10, type: 'file',
    });
    expect(message?.toolCalls?.[0]).toEqual({ id: 'call-1', name: 'read', summary: 'read a file', providerExecuted: undefined });
    expect(message?.contentBlocks?.[0]).toEqual({ id: 'block-1', type: 'file_reference' });
    expect(payload.tasks[0].artifacts[0]).not.toHaveProperty('content');
    expect(payload.tasks[0].artifacts[0]).not.toHaveProperty('appliedPath');
  });
});
