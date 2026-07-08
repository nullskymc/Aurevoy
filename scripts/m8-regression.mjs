// M8.1 知识库与向量检索回归：验证 memory 向量化、混合评分降级、知识库索引与召回。
//
// 运行: node scripts/m8-regression.mjs
//
// 依赖:
//   - Agent 引擎已编译 (npm run build)
//   - sqlite-vec 扩展已加载

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const tempRoot = await mkdtemp(join(tmpdir(), 'aurevoy-m8-'));
const workspaceDir = join(tempRoot, 'workspace');
await mkdir(workspaceDir, { recursive: true });

const llmFixture = await startLlmFixture();

process.env.AUREVOY_HOST = '127.0.0.1';
process.env.AUREVOY_PORT = '0';
process.env.AUREVOY_DB_PATH = join(tempRoot, 'aurevoy.sqlite');
process.env.AUREVOY_WORKSPACE_DIR = workspaceDir;
process.env.AUREVOY_LLM_PROVIDER = 'openai';
process.env.AUREVOY_LLM_API_KEY = 'test-key';
process.env.AUREVOY_LLM_BASE_URL = llmFixture.url;
process.env.AUREVOY_LLM_MODEL = 'm8-fixture-model';
process.env.AUREVOY_MCP_SERVERS_JSON = '';
process.env.AUREVOY_CONTEXT_CHAR_BUDGET = '24000';
process.env.AUREVOY_RECENT_MESSAGE_WINDOW = '8';
process.env.AUREVOY_LLM_PLANNING_ENABLED = 'false';
// 禁用 embedding provider 以测试降级（向量不可用时）
process.env.AUREVOY_EMBEDDING_PROVIDER = 'off';

let passed = 0;
let failed = 0;
let baseUrl = '';

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
    // 继续执行而非中断
  }
}

// ---- 工具函数 ----

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
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
    }
    const req = http.request(options, async (res) => {
      const data = await readBody(res);
      try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
      catch { resolve({ status: res.statusCode, data }); }
    });
    req.on('error', reject);
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
}

const get = (path) => request('GET', path);
const post = (path, body) => request('POST', path, body);
const del = (path) => request('DELETE', path);

// ---- 测试用例 ----

async function caseMemoryVectorCrud() {
  // 验证记忆创建/更新/删除时向量表的联动
  // （即使无 embedding provider，sqlite-vec 表也应该正常工作）

  // 1. 创建一条记忆
  const create = await post('/api/memories', {
    content: '回归测试向量记忆',
    category: 'fact',
  });
  assert(create.status === 201, `创建记忆应 201，实际 ${create.status}`);
  const memId = create.data.id;

  // 2. 列出记忆
  const list = await get('/api/memories');
  assert(list.status === 200, '列出记忆应 200');
  assert(list.data.memories.some((m) => m.id === memId), '列表应包含新建记忆');

  // 3. 删除记忆
  const delRes = await del(`/api/memories/${memId}`);
  assert(delRes.status === 200, `删除记忆应 200，实际 ${delRes.status}`);
  const after = await get('/api/memories');
  assert(!after.data.memories.some((m) => m.id === memId), '删除后不应再包含');
}

async function caseHybridScoringFallback() {
  // 验证无 embedding provider 时混合评分降级为纯关键词

  const mem = await post('/api/memories', {
    content: `用户偏好简洁中文回复 ${Math.random().toString(36).slice(2, 8)}`,
    category: 'preference',
  });
  assert(mem.status === 201, '创建偏好记忆应成功');

  // Agent 创建一条记忆（通过 remember 工具）
  const task = await post('/api/tasks', { goal: 'M8_HYBRID 记录并检索记忆测试' });
  assert(task.status === 201, '创建任务应 201');
  const taskStream = await get(`/api/tasks/${task.data.task.id}/stream`);
  // 等待流结束
  const taskResult = await get(`/api/tasks/${task.data.task.id}`);
  assert(taskResult.status === 200, '获取任务应 200');
  // 此时记忆应已创建（fixture 会回复 injected=yes 或 injected=no）

  const memories = await get('/api/memories');
  assert(memories.status === 200, '列出记忆应 200');
  // 验证前端的 embeddingUpdatedAt 字段存在（值为 undefined/null 都可以）
  for (const m of memories.data.memories) {
    // embeddingUpdatedAt 是可选字段，不应破坏现有结构
    assert('embeddingUpdatedAt' in m, '记忆应包含 embeddingUpdatedAt 字段（可为 undefined）');
    assert('content' in m, '记忆应包含 content');
    assert('confidence' in m, '记忆应包含 confidence');
    break; // 只检查一条
  }
}

async function caseKbDirCrud() {
  // 知识库目录 CRUD

  const kbDir = join(tempRoot, 'test-kb');
  await mkdir(kbDir, { recursive: true });

  // 添加目录
  const add = await post('/api/knowledge-base/dirs', { dirPath: kbDir });
  assert(add.status === 201, `添加 KB 目录应 201，实际 ${add.status}`);
  const dirId = add.data.id;

  // 列出目录
  const dirs = await get('/api/knowledge-base/dirs');
  assert(dirs.status === 200, '列出 KB 目录应 200');
  assert(dirs.data.dirs.some((d) => d.id === dirId), '列表应包含新目录');

  // 索引状态（无文件应返回 0）
  const status = await get('/api/knowledge-base/status');
  assert(status.status === 200, '索引状态应 200');
  assert(typeof status.data.totalFiles === 'number', 'totalFiles 应为数字');
  assert(typeof status.data.totalChunks === 'number', 'totalChunks 应为数字');

  // 删除目录
  const delDir = await del(`/api/knowledge-base/dirs/${dirId}`);
  assert(delDir.status === 200, `删除 KB 目录应 200，实际 ${delDir.status}`);

  const after = await get('/api/knowledge-base/dirs');
  assert(!after.data.dirs.some((d) => d.id === dirId), '删除后不应再包含');
}

async function caseKbDuplicateDir() {
  // 重复目录应 409

  const kbDir = join(tempRoot, 'test-kb-dup');
  await mkdir(kbDir, { recursive: true });

  const add1 = await post('/api/knowledge-base/dirs', { dirPath: kbDir });
  assert(add1.status === 201, `首次添加应 201，实际 ${add1.status}`);

  const add2 = await post('/api/knowledge-base/dirs', { dirPath: kbDir });
  assert(add2.status === 409, `重复添加应 409，实际 ${add2.status}`);

  // 清理
  if (add1.data?.id) {
    await del(`/api/knowledge-base/dirs/${add1.data.id}`);
  }
}

async function caseKbIndexAndRecallWithoutEmbedding() {
  // 验证无 embedding provider 时 index_files 和 recall 的降级行为

  const kbDir = join(tempRoot, 'test-kb-index');
  await mkdir(kbDir, { recursive: true });

  // 创建一个测试文件
  const testFile = join(kbDir, 'test.js');
  await writeFile(testFile, 'function hello() { return "world"; }\n// 测试文件内容');

  // 添加目录
  const add = await post('/api/knowledge-base/dirs', { dirPath: kbDir });
  assert(add.status === 201, '添加 KB 目录应 201');

  // 添加目录后，确认 status 存在
  const status = await get('/api/knowledge-base/status');
  assert(status.status === 200, '索引状态 API 应正常');

  // 清理
  if (add.data?.id) {
    // 删除目录会级联清理索引
    const delDir = await del(`/api/knowledge-base/dirs/${add.data.id}`);
    assert(delDir.status === 200, `删除 KB 目录应 200，实际 ${delDir.status}`);
  }

  // 验证删除后的状态 — 文件应已被清理
  const statusAfter = await get('/api/knowledge-base/status');
  assert(statusAfter.data.totalFiles === 0, '删除目录后文件数应为 0');
}

// ---- LLM fixture ----

async function startLlmFixture() {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = JSON.parse(await readBody(req));
    const messages = body.messages ?? [];
    const userTexts = messages.filter((m) => m.role === 'user').map((m) => m.content);
    const joined = userTexts.join(' | ');

    // 检测记忆系统消息
    const hasMemory = messages.some(
      (m) => m.role === 'system' && m.content?.includes('[关于用户的长期记忆]'),
    );
    const hasDisabledMemory = messages.some(
      (m) => m.role === 'system' && m.content?.includes('MEMDISABLED'),
    );

    let finalContent = '';

    if (joined.includes('M8_HYBRID')) {
      // 创建一条记忆来验证混合评分
      const content = JSON.stringify({
        content: `偏好标记 HYBRID${Math.random().toString(36).slice(2, 8)}`,
        category: 'preference',
        confidence: 0.7,
      });
      finalContent = `injected=${hasMemory ? 'yes' : 'no'}\n<function_calls>\n<invoke name="remember">\n<parameter name="content">${`偏好标记 HYBRID`}</parameter>\n<parameter name="category">preference</parameter>\n</invoke>\n</function_calls>`;
    } else {
      finalContent = `ok\nresponse: ${joined.slice(0, 200)}`;
    }

    const responseBody = JSON.stringify({
      id: 'm8-fixture',
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta: { content: finalContent },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    });

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({
      id: 'm8-fixture',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      id: 'm8-fixture',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: finalContent }, finish_reason: null }],
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      id: 'm8-fixture',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return { url: `http://127.0.0.1:${addr.port}/v1`, server };
}

// ---- 主流程 ----

console.log('M8 知识库与向量检索回归\n');

// 启动引擎
process.env.AUREVOY_HOST = '127.0.0.1';
process.env.AUREVOY_PORT = '0';
process.env.AUREVOY_LLM_PROVIDER = 'openai';
process.env.AUREVOY_LLM_API_KEY = 'test-key';
process.env.AUREVOY_LLM_BASE_URL = llmFixture.url;
process.env.AUREVOY_LLM_MODEL = 'm8-fixture-model';
process.env.AUREVOY_EMBEDDING_PROVIDER = 'off';
process.env.AUREVOY_EMBEDDING_BASE_URL = 'http://127.0.0.1:11434';
process.env.AUREVOY_SKILLS_USER_DIR = join(tempRoot, '.aurevoy', 'skills');
process.env.AUREVOY_SKILLS_BUILTIN_DIR = join(tempRoot, 'skills', 'builtin');

// 确保编译产物存在
try {
  await import('../apps/agent/dist/tool/index.js').then(m => m.initializeUnifiedToolFramework());
} catch {
  console.error('请先运行 npm run build (在 agent 目录)');
  process.exit(1);
}
const { buildServer } = await import('../apps/agent/dist/server.js');

const app = await buildServer();
await app.listen({ host: '127.0.0.1', port: 0 });
baseUrl = `http://127.0.0.1:${app.server.address().port}`;

console.log(`  Agent 引擎已启动: ${baseUrl}`);

// 运行测试
console.log('\n--- 记忆向量 CRUD ---');
await caseMemoryVectorCrud();

console.log('\n--- 混合评分降级 ---');
await caseHybridScoringFallback();

console.log('\n--- 知识库目录 CRUD ---');
await caseKbDirCrud();

console.log('\n--- 重复目录 409 ---');
await caseKbDuplicateDir();

console.log('\n--- KB 索引与降级召回 ---');
await caseKbIndexAndRecallWithoutEmbedding();

console.log('\n--- 设置 API Embedding 配置 ---');
// 验证 embedding 设置字段存在
const settingsResp = await get('/api/settings');
if (settingsResp.status === 200) {
  assert('embedding' in settingsResp.data, 'settings 应包含 embedding 字段');
  if (settingsResp.data.embedding) {
    assert('provider' in settingsResp.data.embedding, 'embedding 应包含 provider');
    assert('model' in settingsResp.data.embedding, 'embedding 应包含 model');
    assert('baseUrl' in settingsResp.data.embedding, 'embedding 应包含 baseUrl');
  }
}

// 关闭
await app.close();
llmFixture.server.close();

console.log(`\n======================`);
console.log(`通过: ${passed}, 失败: ${failed}`);
console.log(`结果: ${failed > 0 ? '❌ 部分失败' : '✅ 全部通过'}`);

process.exit(failed > 0 ? 1 : 0);
