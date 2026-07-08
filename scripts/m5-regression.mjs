import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';

const tempRoot = await mkdtemp(join(tmpdir(), 'aurevoy-m5-'));
const workspaceDir = join(tempRoot, 'workspace-a');
const nextWorkspaceDir = join(tempRoot, 'workspace-b');
await mkdir(workspaceDir, { recursive: true });
await mkdir(nextWorkspaceDir, { recursive: true });
await writeFile(join(nextWorkspaceDir, 'note.txt'), 'M5_WORKSPACE_OK', 'utf8');

const llmFixture = await startLlmFixture();

process.env.AUREVOY_HOST = '127.0.0.1';
process.env.AUREVOY_PORT = '0';
process.env.AUREVOY_DB_PATH = join(tempRoot, 'aurevoy.sqlite');
process.env.AUREVOY_WORKSPACE_DIR = workspaceDir;
process.env.AUREVOY_LLM_PROVIDER = 'openai';
process.env.AUREVOY_LLM_API_KEY = 'test-key';
process.env.AUREVOY_LLM_BASE_URL = llmFixture.url;
process.env.AUREVOY_LLM_MODEL = 'm5-initial-model';
process.env.AUREVOY_MCP_SERVERS_JSON = '';

await import('../apps/agent/dist/tool/index.js').then(m => m.initializeUnifiedToolFramework());
const { taskStore } = await import('../apps/agent/dist/store/db.js');
seedOldTask(taskStore);
const { buildServer } = await import('../apps/agent/dist/server.js');

const app = await buildServer();
await app.listen({ host: '127.0.0.1', port: 0 });
const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

try {
  await caseSettingsAffectProviderAndWorkspace();
  await caseToolToggleAffectsModelTools();
  await caseDataStatusAndCleanup();
  await caseMcpSettingsValidationAndStatus();
  console.log('M5 regression passed');
} finally {
  await app.close();
  await closeServer(llmFixture.server);
}

process.exit(0);

async function caseSettingsAffectProviderAndWorkspace() {
  const settings = await getJson('/api/settings');
  assert(settings.llm.apiKeyConfigured, '环境 API Key 应显示为已配置');

  const updated = await patchJson('/api/settings', {
    llm: {
      baseUrl: llmFixture.url,
      model: 'm5-updated-model',
      apiKey: 'new-test-key',
      temperature: 0.2,
      timeoutMs: 30000,
    },
    workspaceDir: nextWorkspaceDir,
    cleanupPolicyDays: 30,
    mcpServersJson: '',
  });
  assert(updated.llm.model === 'm5-updated-model', '设置响应应返回新模型');
  assert(updated.workspaceDir === nextWorkspaceDir, '设置响应应返回新工作区');

  const project = await postJson('/api/projects', { name: 'm5-regression', path: nextWorkspaceDir });
  const projectId = project.id;

  const created = await postJson('/api/tasks', { goal: 'M5_READ_WORKSPACE 读取 note.txt', projectId });
  await drainStream(created.task.id);
  const task = await getJson(`/api/tasks/${created.task.id}`);
  const last = task.messages[task.messages.length - 1];
  assert(last.content.includes('model=m5-updated-model'), `Provider 未使用新模型：${last.content}`);
  assert(last.content.includes('M5_WORKSPACE_OK'), `文件工具未使用新工作区：${last.content}`);
}

async function caseToolToggleAffectsModelTools() {
  const disabled = await patchJson('/api/tools/list_directory', { enabled: false });
  assert(disabled.enabled === false, '工具停用响应应为 enabled=false');

  const tools = await getJson('/api/tools');
  const listDirectory = tools.find((tool) => tool.name === 'list_directory');
  assert(listDirectory && listDirectory.enabled === false, '工具列表应展示停用状态');

  const created = await postJson('/api/tasks', { goal: 'M5_TOOL_DISABLED 检查工具目录' });
  await drainStream(created.task.id);
  const task = await getJson(`/api/tasks/${created.task.id}`);
  const last = task.messages[task.messages.length - 1];
  assert(last.content.includes('disabled=yes'), `停用工具仍被提供给模型：${last.content}`);
}

async function caseDataStatusAndCleanup() {
  const before = await getJson('/api/data');
  assert(before.counts.tasks >= 1, '数据状态应包含任务计数');
  assert(before.workspaceDir === nextWorkspaceDir, '数据状态应反映当前工作区');

  const cleaned = await postJson('/api/data/cleanup', { olderThanDays: 30 });
  assert(cleaned.deletedTasks >= 1, '清理应删除预置的旧终态任务');
  assert(cleaned.deletedTraces === 0, '预置任务没有轨迹，清理轨迹数应为 0');
}

async function caseMcpSettingsValidationAndStatus() {
  const invalid = await rawPatch('/api/settings', { mcpServersJson: '{bad json' });
  assert(invalid.status === 400, `非法 MCP JSON 应 400，实际 ${invalid.status}`);

  await patchJson('/api/settings', {
    mcpServersJson: JSON.stringify({
      mcpServers: {
        disabledFixture: {
          command: 'node',
          args: ['missing.js'],
          enabled: false,
        },
      },
    }),
  });
  const status = await getJson('/api/mcp/status');
  const server = status.servers.find((item) => item.name === 'disabledFixture');
  assert(server && server.enabled === false && server.connected === false, 'MCP 状态应显示停用 server');
}

async function startLlmFixture() {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = JSON.parse(await readBody(req));
    const messages = body.messages ?? [];
    const userText = messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .join(' | ');
    const hasToolResult = messages.some((message) => message.role === 'tool');

    if (userText.includes('M5_READ_WORKSPACE') && !hasToolResult) {
      writeSseToolCall(res, {
        id: 'call_read_note',
        name: 'read_file',
        args: { path: 'note.txt' },
      });
      return;
    }

    let content;
    if (userText.includes('M5_READ_WORKSPACE')) {
      const toolText = messages
        .filter((message) => message.role === 'tool')
        .map((message) => message.content)
        .join('\n');
      content = `final: model=${body.model} workspace=${toolText.includes('M5_WORKSPACE_OK') ? 'M5_WORKSPACE_OK' : 'missing'}`;
    } else if (userText.includes('M5_TOOL_DISABLED')) {
      const toolNames = (body.tools ?? []).map((tool) => tool.function?.name).join(',');
      content = `final: disabled=${toolNames.includes('list_directory') ? 'no' : 'yes'}`;
    } else {
      content = `final: model=${body.model}`;
    }

    writeSseText(res, content);
  });
  await listen(server, 0);
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function writeSseToolCall(res, call) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  sse(res, {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        },
      },
    ],
  });
  sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  res.write('data: [DONE]\n\n');
  res.end();
}

function writeSseText(res, content) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  sse(res, { choices: [{ delta: { content } }] });
  sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
  res.write('data: [DONE]\n\n');
  res.end();
}

async function drainStream(taskId) {
  const res = await fetch(`${baseUrl}/api/tasks/${taskId}/stream`);
  assert(res.ok && res.body, `SSE 订阅失败: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const line = chunk.split('\n').find((item) => item.startsWith('data:'));
      if (!line) continue;
      const event = JSON.parse(line.slice('data:'.length).trim());
      if (event.type === 'done') {
        await reader.cancel().catch(() => {});
        return;
      }
    }
  }
}

async function getJson(path) {
  const res = await fetch(`${baseUrl}${path}`);
  assert(res.ok, `GET ${path} failed: ${res.status}`);
  return res.json();
}

async function postJson(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert(res.ok, `POST ${path} failed: ${res.status}`);
  return res.json();
}

async function patchJson(path, body) {
  const res = await rawPatch(path, body);
  assert(res.ok, `PATCH ${path} failed: ${res.status}`);
  return res.json();
}

function rawPatch(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

function listen(server, port) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
}

function closeServer(server) {
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 500);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function seedOldTask(store) {
  const old = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
  store.save({
    id: randomUUID(),
    goal: 'M5_OLD_TASK',
    status: 'completed',
    phase: 'finalizing',
    plan: [],
    messages: [
      {
        id: randomUUID(),
        role: 'user',
        content: 'M5_OLD_TASK',
        createdAt: old,
      },
    ],
    createdAt: old,
    updatedAt: old,
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
