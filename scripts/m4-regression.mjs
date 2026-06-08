import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

// M4.1 多轮对话回归：验证同一任务内追加用户输入后，后端带完整历史重跑循环，
// 上下文真实保留；并校验续聊端点的 404 / 409 / 400 边界。

const tempRoot = await mkdtemp(join(tmpdir(), 'aurevoy-m4-'));
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
process.env.AUREVOY_LLM_MODEL = 'm4-fixture-model';
process.env.AUREVOY_MCP_SERVERS_JSON = '';
// 压缩测试：小预算 + 近窗口=1，强制旧 assistant 内容被压缩
process.env.AUREVOY_CONTEXT_CHAR_BUDGET = '500';
process.env.AUREVOY_RECENT_MESSAGE_WINDOW = '1';
process.env.AUREVOY_COMPRESSED_MESSAGE_CHAR_CAP = '200';

await import('../apps/agent/dist/tools/builtins.js');
const { buildServer } = await import('../apps/agent/dist/server.js');

const app = await buildServer();
await app.listen({ host: '127.0.0.1', port: 0 });
const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

try {
  await caseMultiTurnContext();
  await caseContextCompression();
  await caseContinueNotFound();
  await caseContinueEmptyMessage();
  await caseContinueWhileRunning();

  console.log('M4 regression passed');
} finally {
  await app.close();
  await closeServer(llmFixture.server);
}

process.exit(0);

// 第一轮告知一个口令，第二轮追问口令；fixture 校验第二轮请求里带着第一轮历史。
async function caseMultiTurnContext() {
  const created = await postJson('/api/tasks', { goal: 'M4_TURN1 记住口令是 BLUE-42' });
  await drainStream(created.task.id);
  const afterTurn1 = await getJson(`/api/tasks/${created.task.id}`);
  assert(afterTurn1.status === 'completed', '第一轮未完成');
  assert(afterTurn1.messages.length === 2, `第一轮消息数应为 2，实际 ${afterTurn1.messages.length}`);

  const continued = await postJson(`/api/tasks/${created.task.id}/messages`, {
    message: 'M4_TURN2 刚才的口令是什么',
  });
  assert(
    continued.task.messages.length === 3,
    `续聊响应应含 3 条消息（含新 user），实际 ${continued.task.messages.length}`,
  );
  await drainStream(created.task.id);

  const afterTurn2 = await getJson(`/api/tasks/${created.task.id}`);
  assert(afterTurn2.status === 'completed', '第二轮未完成');
  assert(
    afterTurn2.messages.length === 4,
    `多轮后消息数应为 4，实际 ${afterTurn2.messages.length}`,
  );
  const roles = afterTurn2.messages.map((m) => m.role).join(',');
  assert(roles === 'user,assistant,user,assistant', `消息角色顺序异常：${roles}`);

  // fixture 在第二轮回复里回显它收到的历史长度，借此证明上下文被真实回灌
  const lastAssistant = afterTurn2.messages[3];
  const historyMatch = lastAssistant.content.match(/history=(\d+)/);
  assert(historyMatch, `第二轮模型回复缺少 history 标记：${lastAssistant.content}`);
  // 回灌历史至少包含 user1 + assistant1 + user2（可能再加一条 system 提示）
  assert(
    Number(historyMatch[1]) >= 3,
    `第二轮模型未收到完整历史，回复：${lastAssistant.content}`,
  );
  assert(
    lastAssistant.content.includes('BLUE-42'),
    `第二轮上下文未保留第一轮口令，回复：${lastAssistant.content}`,
  );
}

// M4.2 会话级短期记忆：历史超预算时压缩旧内容，保留用户约束与近窗口，且不破坏配对契约。
async function caseContextCompression() {
  const created = await postJson('/api/tasks', {
    goal: 'M4_BIG 约束:KEEP-CHINESE 始终用中文回答',
  });
  await drainStream(created.task.id);
  const afterTurn1 = await getJson(`/api/tasks/${created.task.id}`);
  // 真实历史不被压缩：第一轮大 assistant 内容应原样持久化
  const bigMsg = afterTurn1.messages.find((m) => m.role === 'assistant');
  assert(bigMsg && bigMsg.content.length > 2000, '第一轮大内容未被真实持久化（历史应完整）');

  await postJson(`/api/tasks/${created.task.id}/messages`, { message: 'M4_ASK 重复一下要求' });
  await drainStream(created.task.id);

  const afterTurn2 = await getJson(`/api/tasks/${created.task.id}`);
  const lastAssistant = afterTurn2.messages[afterTurn2.messages.length - 1];
  // fixture 回显它收到的（已压缩的）上下文情况
  assert(
    lastAssistant.content.includes('compressed=yes'),
    `旧大内容未被压缩后再喂给模型，回复：${lastAssistant.content}`,
  );
  assert(
    lastAssistant.content.includes('constraint=yes'),
    `用户约束未在压缩后保留，回复：${lastAssistant.content}`,
  );

  // 真实历史仍完整：大内容仍原样保存，未被压缩污染
  const bigStill = afterTurn2.messages.find(
    (m) => m.role === 'assistant' && m.content.length > 2000,
  );
  assert(bigStill, '压缩不应修改持久化的真实历史');

  // 压缩事件应留下可审计轨迹
  const tracesBody = await getJson(`/api/tasks/${created.task.id}/traces`);
  assert(
    tracesBody.traces.some(
      (t) => typeof t.summary === 'string' && t.summary.includes('上下文压缩'),
    ),
    '上下文压缩缺少可审计轨迹',
  );
}

async function caseContinueNotFound() {
  const res = await rawPost('/api/tasks/does-not-exist/messages', { message: 'hi' });
  assert(res.status === 404, `不存在任务续聊应 404，实际 ${res.status}`);
}

async function caseContinueEmptyMessage() {
  const created = await postJson('/api/tasks', { goal: 'M4_TURN1 任意目标' });
  await drainStream(created.task.id);
  const res = await rawPost(`/api/tasks/${created.task.id}/messages`, { message: '   ' });
  assert(res.status === 400, `空消息续聊应 400，实际 ${res.status}`);
}

async function caseContinueWhileRunning() {
  const created = await postJson('/api/tasks', { goal: 'M4_HANG 持续生成不结束' });
  // 不消费完流，任务仍在运行；此时续聊应 409
  await waitForPhase(created.task.id, 'thinking');
  const res = await rawPost(`/api/tasks/${created.task.id}/messages`, { message: '追问' });
  assert(res.status === 409, `运行中续聊应 409，实际 ${res.status}`);
  await fetch(`${baseUrl}/api/tasks/${created.task.id}/cancel`, { method: 'POST' });
}

// ---------------- LLM fixture ----------------

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

    // 持续生成（用于 409 运行中测试）
    if (joined.includes('M4_HANG')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const timer = setInterval(() => sse(res, { choices: [{ delta: { content: '.' } }] }), 40);
      req.on('close', () => clearInterval(timer));
      return;
    }

    let content;
    if (joined.includes('M4_ASK')) {
      // 第二轮：校验旧的大 assistant 内容是否被压缩、用户约束是否逐字保留
      const bigAssistant = messages.find(
        (m) => m.role === 'assistant' && String(m.content).length > 0,
      );
      const wasCompressed =
        !!bigAssistant &&
        String(bigAssistant.content).length < 1000 &&
        String(bigAssistant.content).includes('上下文压缩');
      const constraintKept = messages.some((m) => String(m.content).includes('KEEP-CHINESE'));
      content = `final: compressed=${wasCompressed ? 'yes' : 'no'} constraint=${constraintKept ? 'yes' : 'no'}`;
    } else if (joined.includes('M4_BIG')) {
      // 第一轮：产出一段大文本，撑高历史体积
      content = 'BIGDATA ' + 'X'.repeat(3000);
    } else if (joined.includes('M4_TURN2')) {
      // 回显收到的历史消息数与是否包含第一轮口令，证明上下文被回灌
      const hasSecret = messages.some((m) => String(m.content).includes('BLUE-42'));
      content = `final: history=${messages.length} secret=${hasSecret ? 'BLUE-42' : 'none'}`;
    } else {
      content = `final: ${userTexts[userTexts.length - 1] ?? ''}`;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sse(res, { choices: [{ delta: { content } }] });
    sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await listen(server, 0);
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

// ---------------- helpers ----------------

async function drainStream(taskId, onEvent = async () => {}) {
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
      await onEvent(event);
      if (event.type === 'done') {
        await reader.cancel().catch(() => {});
        return;
      }
    }
  }
}

async function waitForPhase(taskId, phase) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`等待 phase=${phase} 超时`)), 5000);
    drainStream(taskId, async (event) => {
      if (event.type === 'phase' && event.phase === phase) {
        clearTimeout(timeout);
        resolve();
      }
    }).catch(() => {});
  });
}

async function getJson(path) {
  const res = await fetch(`${baseUrl}${path}`);
  assert(res.ok, `GET ${path} failed: ${res.status}`);
  return res.json();
}

async function postJson(path, body) {
  const res = await rawPost(path, body);
  assert(res.ok, `POST ${path} failed: ${res.status}`);
  return res.json();
}

function rawPost(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
