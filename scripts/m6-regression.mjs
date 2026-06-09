import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const tempRoot = await mkdtemp(join(tmpdir(), 'aurevoy-m6-'));
const workspaceDir = join(tempRoot, 'workspace');
await mkdir(workspaceDir, { recursive: true });
await writeFile(join(workspaceDir, 'source.md'), '# Source\n\nAurevoy M6 fixture.', 'utf8');

const llmFixture = await startLlmFixture();

process.env.AUREVOY_HOST = '127.0.0.1';
process.env.AUREVOY_PORT = '0';
process.env.AUREVOY_DB_PATH = join(tempRoot, 'aurevoy.sqlite');
process.env.AUREVOY_WORKSPACE_DIR = workspaceDir;
process.env.AUREVOY_LLM_PROVIDER = 'openai';
process.env.AUREVOY_LLM_API_KEY = 'test-key';
process.env.AUREVOY_LLM_BASE_URL = llmFixture.url;
process.env.AUREVOY_LLM_MODEL = 'm6-fixture-model';
process.env.AUREVOY_APPROVAL_TIMEOUT_MS = '120';
process.env.AUREVOY_ENABLE_COMMAND_EXECUTION = 'true';
process.env.AUREVOY_COMMAND_TIMEOUT_MS = '2000';
process.env.AUREVOY_COMMAND_OUTPUT_LIMIT_BYTES = '64';

await import('../apps/agent/dist/tools/builtins.js');
const { buildServer } = await import('../apps/agent/dist/server.js');

const app = await buildServer();
await app.listen({ host: '127.0.0.1', port: 0 });
const address = app.server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  await caseAskUserAndResume();
  await caseAskUserTimeout();
  await caseCreateArtifact();
  await caseConfirmArtifact();
  await caseRejectArtifact();
  await caseBudgetExceeded();
  await caseTokenUsageRecorded();
  await caseExecuteCommand();
  await caseExecuteCommandSandbox();

  console.log('M6 regression passed');
} finally {
  await app.close();
  await closeServer(llmFixture.server);
}

process.exit(0);

async function caseAskUserAndResume() {
  const created = await postJson('/api/tasks', { goal: 'M6_ASK_USER ask for missing path' });
  const events = await collectTaskStream(created.task.id, async (event) => {
    if (event.type === 'clarification_request') {
      await postJson(`/api/tasks/${created.task.id}/clarifications/${event.clarification.id}`, {
        answer: 'docs/SUMMARY.md',
      });
    }
  });
  const task = await getJson(`/api/tasks/${created.task.id}`);
  assert(task.status === 'completed', '追问回复后任务未完成');
  assert(events.some((event) => event.type === 'clarification_request'), '缺少 clarification_request');
  assert(events.some((event) => event.type === 'clarification_resolved'), '缺少 clarification_resolved');
  assert(task.clarifications?.[0]?.answer === 'docs/SUMMARY.md', '追问答案未持久化');
}

async function caseAskUserTimeout() {
  const result = await runTask('M6_ASK_TIMEOUT do not answer');
  assert(result.task.status === 'completed', '追问超时任务应由模型降级完成');
  assert(result.task.clarifications?.[0]?.status === 'timeout', '追问超时状态未持久化');
}

async function caseCreateArtifact() {
  const result = await runTask('M6_ARTIFACT create draft artifact');
  const artifact = result.task.artifacts?.[0];
  assert(artifact?.status === 'draft', 'artifact 草稿未创建');
  assert(artifact.content.includes('M6 report'), 'artifact 内容不正确');
}

async function caseConfirmArtifact() {
  const result = await runTask('M6_ARTIFACT create draft for confirm');
  const artifact = result.task.artifacts?.[0];
  assert(artifact, '确认用 artifact 未创建');
  const updated = await patchJson(`/api/tasks/${result.task.id}/artifacts/${artifact.id}`, { status: 'confirmed' });
  assert(updated.status === 'confirmed', 'artifact 未确认');
}

async function caseRejectArtifact() {
  const result = await runTask('M6_ARTIFACT create draft for reject');
  const artifact = result.task.artifacts?.[0];
  assert(artifact, '拒绝用 artifact 未创建');
  const updated = await patchJson(`/api/tasks/${result.task.id}/artifacts/${artifact.id}`, { status: 'rejected' });
  assert(updated.status === 'rejected', 'artifact 未拒绝');
}

async function caseBudgetExceeded() {
  const created = await postJson('/api/tasks', {
    goal: 'M6_BUDGET exceed iteration',
    budget: { maxIterations: 1 },
  });
  await collectTaskStream(created.task.id);
  const task = await getJson(`/api/tasks/${created.task.id}`);
  const traces = await getTraces(created.task.id);
  assert(task.status === 'failed', '预算超限未失败');
  assert(traces.some((trace) => trace.errorMessage?.includes('预算超限')), '预算超限缺少 trace');
}

async function caseTokenUsageRecorded() {
  const result = await runTask('M6_USAGE record token usage');
  assert(result.task.tokenUsage?.available === true, 'token usage 未记录为可用');
  assert(result.task.tokenUsage.totalTokens >= 10, 'token usage total 不正确');
  assert(result.traces.some((trace) => trace.kind === 'llm' && trace.tokenUsage?.totalTokens), 'LLM trace 缺少 usage');
}

async function caseExecuteCommand() {
  const result = await runTask('M6_COMMAND execute echo', { approve: true });
  assert(result.task.status === 'completed', '命令执行任务未完成');
  assert(
    result.traces.some((trace) => trace.toolName === 'execute_command' && trace.ok === true),
    '命令执行缺少成功 trace',
  );
}

async function caseExecuteCommandSandbox() {
  const result = await runTask('M6_COMMAND_SANDBOX reject outside cwd', { approve: true });
  assert(
    result.traces.some((trace) => trace.toolName === 'execute_command' && trace.ok === false),
    '命令 cwd 越界缺少失败 trace',
  );
}

async function runTask(goal, options = {}) {
  const created = await postJson('/api/tasks', { goal });
  await collectTaskStream(created.task.id, async (event) => {
    if (event.type !== 'approval_request') return;
    if (options.approve === 'timeout') return;
    await postJson(`/api/tasks/${created.task.id}/approvals`, {
      callId: event.call.id,
      approved: options.approve !== false,
    });
  });
  const task = await getJson(`/api/tasks/${created.task.id}`);
  const traces = await getTraces(created.task.id);
  return { task, traces };
}

async function collectTaskStream(taskId, onEvent = async () => {}) {
  const res = await fetch(`${baseUrl}/api/tasks/${taskId}/stream`);
  assert(res.ok && res.body, `SSE 订阅失败: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
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
      events.push(event);
      await onEvent(event);
      if (event.type === 'done') {
        await reader.cancel().catch(() => {});
        return events;
      }
    }
  }
  return events;
}

async function getTraces(taskId) {
  const body = await getJson(`/api/tasks/${taskId}/traces`);
  return body.traces;
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
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert(res.ok, `PATCH ${path} failed: ${res.status}`);
  return res.json();
}

async function startLlmFixture() {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = JSON.parse(await readRequestBody(req));
    const userText = body.messages.find((message) => message.role === 'user')?.content ?? '';
    const toolMessages = body.messages.filter((message) => message.role === 'tool');
    const hasToolResult = toolMessages.length > 0;

    if (!hasToolResult) {
      const tool = chooseFirstTool(userText);
      if (tool) return sendToolCall(res, tool);
    }

    if (userText.includes('M6_BUDGET') && hasToolResult) {
      return sendToolCall(res, {
        id: 'call_budget_again',
        name: 'get_current_time',
        args: {},
      });
    }

    return sendFinal(res, `final:${userText}`, { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 });
  });
  await listen(server, 0);
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function chooseFirstTool(userText) {
  if (userText.includes('M6_ASK')) {
    return {
      id: 'call_ask',
      name: 'ask_user',
      args: { question: '保存到哪个路径？', context: '需要写入路径才能继续。' },
    };
  }
  if (userText.includes('M6_ARTIFACT')) {
    return {
      id: 'call_artifact',
      name: 'create_artifact',
      args: { name: 'SUMMARY.md', content: '# M6 report\n\nGenerated artifact.', type: 'file', mimeType: 'text/markdown' },
    };
  }
  if (userText.includes('M6_BUDGET')) {
    return { id: 'call_budget', name: 'get_current_time', args: {} };
  }
  if (userText.includes('M6_COMMAND_SANDBOX')) {
    return { id: 'call_cmd_sandbox', name: 'execute_command', args: { command: process.execPath, args: ['--version'], cwd: '..' } };
  }
  if (userText.includes('M6_COMMAND')) {
    return { id: 'call_cmd', name: 'execute_command', args: { command: process.execPath, args: ['-e', 'console.log("hello")'] } };
  }
  return null;
}

function sendToolCall(res, tool) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  sendSse(res, {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: tool.id,
              type: 'function',
              function: { name: tool.name, arguments: JSON.stringify(tool.args) },
            },
          ],
        },
      },
    ],
  });
  sendSse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  sendSse(res, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
  res.write('data: [DONE]\n\n');
  res.end();
}

function sendFinal(res, content, usage) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  sendSse(res, { choices: [{ delta: { content } }] });
  sendSse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
  sendSse(res, { choices: [], usage });
  res.write('data: [DONE]\n\n');
  res.end();
}

function sendSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function readRequestBody(req) {
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
