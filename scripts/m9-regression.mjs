// M9 健康诊断、脱敏数据导出与数据清理回归。
//
// 运行: node scripts/m9-regression.mjs
// 依赖: Agent 引擎已编译（npm run build）

import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const tempRoot = await mkdtemp(join(tmpdir(), 'aurevoy-m9-'));
const workspaceDir = join(tempRoot, 'workspace');
await mkdir(workspaceDir, { recursive: true });

process.env.AUREVOY_HOST = '127.0.0.1';
process.env.AUREVOY_TEST_BOOTSTRAP = '1';
process.env.AUREVOY_PORT = '0';
process.env.AUREVOY_DB_PATH = join(tempRoot, 'aurevoy.sqlite');
process.env.AUREVOY_WORKSPACE_DIR = workspaceDir;
process.env.AUREVOY_LLM_PROVIDER = 'openai';
process.env.AUREVOY_LLM_API_KEY = 'test-key';
process.env.AUREVOY_LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.AUREVOY_LLM_MODEL = 'm9-fixture-model';
process.env.AUREVOY_MCP_SERVERS_JSON = '';
process.env.AUREVOY_EMBEDDING_PROVIDER = 'off';
process.env.AUREVOY_SKILLS_USER_DIR = join(tempRoot, '.aurevoy', 'skills');
process.env.AUREVOY_SKILLS_BUILTIN_DIR = join(tempRoot, 'skills', 'builtin');

let passed = 0;
let failed = 0;
let baseUrl = '';

function assert(condition, message) {
  if (condition) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

async function request(method, path, body) {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const options = { method, hostname: url.hostname, port: url.port, path: url.pathname, headers: {} };
    if (body !== undefined) options.headers['Content-Type'] = 'application/json';
    const req = http.request(options, async (res) => {
      const raw = await readBody(res);
      let data = raw;
      try { data = JSON.parse(raw); } catch { /* export response is still JSON in practice */ }
      resolve({ status: res.statusCode, data, headers: res.headers });
    });
    req.on('error', reject);
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
}

const get = (path) => request('GET', path);
const post = (path, body) => request('POST', path, body);

console.log('M9 健康诊断、脱敏导出与数据清理回归\n');

let app;
try {
  await import('../apps/agent/dist/tool/index.js').then((module) => module.initializeUnifiedToolFramework());
  const server = await import('../apps/agent/dist/server.js');
  const stores = await import('../apps/agent/dist/store/db.js');
  app = await server.buildServer();
  await app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  const oldTask = {
    id: 'm9-old-task',
    goal: 'M9 export fixture',
    title: 'M9 export fixture',
    status: 'completed',
    phase: 'finalizing',
    plan: [],
    messages: [{
      id: 'm9-message',
      role: 'assistant',
      content: 'safe message body',
      createdAt: '2026-01-01T00:00:00.000Z',
      imageParts: [{
        id: 'm9-image',
        name: 'private.png',
        mimeType: 'image/png',
        size: 10,
        dataUrl: 'data:image/png;base64,should-not-export',
      }],
      toolCalls: [{
        id: 'm9-call',
        type: 'function',
        function: { name: 'read', arguments: '{"secret":"should-not-export"}' },
      }],
    }],
    archivedMessages: [],
    createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
  };
  stores.taskStore.save(oldTask);
  stores.traceStore.append({
    id: 'm9-trace', taskId: oldTask.id, kind: 'done', phase: 'finalizing', tokenUsage: null,
    startedAt: oldTask.updatedAt, endedAt: oldTask.updatedAt, ok: true,
  });
  stores.piSessionTreeStore.save(oldTask.id, {
    version: 1, entries: [], messageCount: 1, messageIds: ['m9-message'], messageLinks: [],
  });

  console.log('--- 健康诊断契约 ---');
  const health = await get('/api/health');
  assert(health.status === 200, '基础 health 应返回 200');
  assert(health.data.version === '0.6.15', 'health 应返回当前迭代版本而非历史硬编码版本');

  const diagnostics = await get('/api/health/diagnostics');
  assert(diagnostics.status === 200, 'health diagnostics 应返回 200');
  assert(diagnostics.data.checks?.length === 6, '诊断应覆盖 6 个本地运行时检查');
  assert(diagnostics.data.checks?.some((item) => item.id === 'database' && item.status === 'ok'), 'SQLite quick check 应通过');
  assert(diagnostics.data.checks?.some((item) => item.id === 'embedding' && item.status === 'warning'), 'embedding off 应明确标为降级');

  console.log('--- 脱敏数据导出 ---');
  const exportMeta = await post('/api/data/export', {});
  assert(exportMeta.status === 200, '默认数据导出应返回 200');
  assert(exportMeta.headers['content-disposition']?.includes('aurevoy-data-'), '导出应提供稳定的下载文件名');
  assert(exportMeta.data.tasks?.[0]?.messages === undefined, '默认导出不应包含任务消息正文');
  assert(exportMeta.data.tasks?.[0]?.messageCount === 1, '默认导出应保留消息计数');
  assert(JSON.stringify(exportMeta.data).includes('redactions'), '导出应包含脱敏边界清单');

  const exportFull = await post('/api/data/export', { includeTaskMessages: true });
  const fullMessage = exportFull.data.tasks?.[0]?.messages?.[0];
  assert(fullMessage?.content === 'safe message body', '显式开启后应导出消息正文');
  assert(JSON.stringify(exportFull.data).includes('should-not-export') === false, '图片 data URL 与工具参数不得进入导出');
  assert(fullMessage?.toolCalls?.[0]?.name === 'read', '导出应保留工具调用元数据');

  console.log('--- 清理边界与级联资源 ---');
  const invalidCleanup = await post('/api/data/cleanup', { olderThanDays: 0 });
  assert(invalidCleanup.status === 400, '非法保留天数应返回 400');
  const cleanup = await post('/api/data/cleanup', { olderThanDays: 1 });
  assert(cleanup.status === 200, '合法清理应返回 200');
  assert(cleanup.data.deletedTasks === 1, '应清理旧终态任务');
  assert(cleanup.data.deletedTraces === 1, '应清理任务轨迹');
  assert(cleanup.data.deletedMessageParts === 1, '应清理独立图片分片');
  assert(cleanup.data.deletedSessionTrees === 1, '应清理 Pi 会话树快照');
  const dataAfter = await get('/api/data');
  assert(dataAfter.data.counts.tasks === 0, '清理后任务计数应归零');
} finally {
  if (app) await app.close();
}

console.log(`\n======================`);
console.log(`通过: ${passed}, 失败: ${failed}`);
console.log(`结果: ${failed > 0 ? '❌ 部分失败' : '✅ 全部通过'}`);
process.exit(failed > 0 ? 1 : 0);
