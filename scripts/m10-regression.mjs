// M10 本地自动化配方、调度、运行历史与幂等触发回归。
//
// 运行: node scripts/m10-regression.mjs
// 依赖: Agent 引擎已编译（npm run build）

import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const tempRoot = await mkdtemp(join(tmpdir(), 'aurevoy-m10-'));
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
process.env.AUREVOY_LLM_MODEL = 'm10-fixture-model';
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
    const options = { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: {} };
    if (body !== undefined) options.headers['Content-Type'] = 'application/json';
    const req = http.request(options, async (res) => {
      const raw = await readBody(res);
      let data = raw;
      try { data = JSON.parse(raw); } catch { /* 非 JSON 错误仍保留原文 */ }
      resolve({ status: res.statusCode, data });
    });
    req.on('error', reject);
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
}

const get = (path) => request('GET', path);
const post = (path, body) => request('POST', path, body);
const patch = (path, body) => request('PATCH', path, body);

function fixtureTask(id, automationId) {
  const now = new Date().toISOString();
  return {
    id,
    goal: 'M10 scheduled fixture',
    title: 'M10 scheduled fixture',
    status: 'pending',
    phase: 'initializing',
    plan: [],
    messages: [],
    artifacts: [],
    clarifications: [],
    pendingApprovals: [],
    checkpoints: [],
    budget: {},
    budgetUsage: { iterations: 0, toolCalls: 0, wallTimeMs: 0, outputBytes: 0 },
    lifetimeBudget: {},
    lifetimeUsage: { iterations: 0, toolCalls: 0, wallTimeMs: 0, outputBytes: 0 },
    tokenUsage: { available: false },
    automationId,
    executionMode: 'auto',
    autoModeState: { level: 'auto', autoApprovedCalls: 0, blockedByRules: 0, paused: false },
    createdAt: now,
    updatedAt: now,
  };
}

console.log('M10 本地自动化配方、调度与运行历史回归\n');

let app;
try {
  await import('../apps/agent/dist/tool/index.js').then((module) => module.initializeUnifiedToolFramework());
  const server = await import('../apps/agent/dist/server.js');
  const stores = await import('../apps/agent/dist/store/db.js');
  const { AutomationScheduler } = await import('../apps/agent/dist/automation/scheduler.js');
  app = await server.buildServer();
  await app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  console.log('--- 配方 CRUD 与约束 ---');
  const created = await post('/api/automations', {
    name: 'M10 daily review',
    goal: '检查项目中的新变化并给出摘要',
    cadence: 'daily',
    enabled: false,
  });
  assert(created.status === 201, '创建自动化配方应返回 201');
  assert(created.data.cadence === 'daily' && created.data.enabled === false, '配方应保存频率与启用状态');
  const listed = await get('/api/automations');
  assert(listed.status === 200 && listed.data.automations.length === 1, '列表应返回新配方');
  const enabled = await patch(`/api/automations/${created.data.id}`, { enabled: true });
  assert(enabled.status === 200 && enabled.data.nextRunAt, '启用定时配方应生成 nextRunAt');
  const invalid = await post('/api/automations', { name: 'bad', goal: 'bad', cadence: 'yearly' });
  assert(invalid.status === 400, '未知 cadence 应返回 400');

  console.log('--- 手动触发与重复运行门禁 ---');
  const started = await post(`/api/automations/${created.data.id}/run`);
  assert(started.status === 202, '立即运行应返回 202');
  assert(started.data.task?.automationId === created.data.id, '创建任务应记录 automationId 来源');
  const duplicate = await post(`/api/automations/${created.data.id}/run`);
  assert(duplicate.status === 409, '同一配方运行中再次触发应被拒绝');
  const runs = await get(`/api/automations/${created.data.id}/runs`);
  assert(runs.status === 200 && runs.data.runs.length === 1, '运行历史应记录一次触发');
  assert(runs.data.runs[0].taskId === started.data.task.id, '运行记录应关联创建的任务');

  console.log('--- 调度器 due、收敛与下一次运行 ---');
  const scheduledId = randomUUID();
  const now = new Date().toISOString();
  stores.automationStore.create({
    id: scheduledId,
    name: 'M10 scheduler fixture',
    goal: 'fixture',
    cadence: 'hourly',
    enabled: true,
    nextRunAt: new Date(0).toISOString(),
    runCount: 0,
    failureCount: 0,
    executionMode: 'auto',
    createdAt: now,
    updatedAt: now,
  });
  const scheduledTask = fixtureTask('m10-scheduled-task', scheduledId);
  const scheduler = new AutomationScheduler({
    createTask: () => {
      stores.taskStore.save(scheduledTask);
      return scheduledTask;
    },
    runTask: async () => {},
  });
  await scheduler.tick();
  const claimed = stores.automationStore.get(scheduledId);
  assert(claimed?.lastStatus === 'running' && claimed.runCount === 1, '到期配方应被调度且只占用一次');
  scheduledTask.status = 'completed';
  scheduledTask.phase = 'finalizing';
  scheduledTask.updatedAt = new Date().toISOString();
  stores.taskStore.save(scheduledTask);
  await scheduler.tick();
  const finished = stores.automationStore.get(scheduledId);
  const finishedRuns = stores.automationStore.listRuns(scheduledId);
  assert(finished?.lastStatus === 'completed', '终态任务应收敛为自动化成功');
  assert(Boolean(finished?.nextRunAt) && finishedRuns[0]?.status === 'completed', '成功后应生成下一次运行并收敛历史');

  console.log('--- 安全暂停 ---');
  const paused = await patch(`/api/automations/${created.data.id}`, { enabled: false });
  assert(paused.status === 200 && paused.data.enabled === false && !paused.data.nextRunAt, '暂停配方应清除下一次运行时间');
} finally {
  if (app) await app.close();
}

console.log(`\n======================`);
console.log(`通过: ${passed}, 失败: ${failed}`);
console.log(`结果: ${failed > 0 ? '❌ 部分失败' : '✅ 全部通过'}`);
process.exit(failed > 0 ? 1 : 0);
