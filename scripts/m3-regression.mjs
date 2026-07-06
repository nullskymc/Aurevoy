import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';

const rootDir = new URL('..', import.meta.url).pathname;
const tempRoot = await mkdtemp(join(tmpdir(), 'aurevoy-m3-'));
const workspaceDir = join(tempRoot, 'workspace');
const outsideDir = join(tempRoot, 'outside');
await mkdir(workspaceDir, { recursive: true });
await mkdir(outsideDir, { recursive: true });
await writeFile(join(workspaceDir, 'note.txt'), 'workspace note for read regression', 'utf8');
await writeFile(join(outsideDir, 'secret.txt'), 'outside secret', 'utf8');
await symlink(join(outsideDir, 'secret.txt'), join(workspaceDir, 'outside-link'));

const httpFixture = await startHttpFixture();
const llmFixture = await startLlmFixture(httpFixture.url);

process.env.AUREVOY_HOST = '127.0.0.1';
process.env.AUREVOY_PORT = '0';
process.env.AUREVOY_DB_PATH = join(tempRoot, 'aurevoy.sqlite');
process.env.AUREVOY_WORKSPACE_DIR = workspaceDir;
process.env.AUREVOY_LLM_PROVIDER = 'openai';
process.env.AUREVOY_LLM_API_KEY = 'test-key';
process.env.AUREVOY_LLM_BASE_URL = llmFixture.url;
process.env.AUREVOY_LLM_MODEL = 'm3-fixture-model';
process.env.AUREVOY_APPROVAL_TIMEOUT_MS = '120';
process.env.AUREVOY_HTTP_FETCH_PRIVATE_HOST_ALLOWLIST = '127.0.0.1';
process.env.AUREVOY_MCP_SERVERS_JSON = JSON.stringify({
  mcpServers: {
    fixture: {
      command: process.execPath,
      args: ['--input-type=module', '-e', mcpServerCode()],
      riskLevel: 'safe',
    },
  },
});

await import('../apps/agent/dist/tools/builtins.js');
const { buildServer } = await import('../apps/agent/dist/server.js');
const { closeMcpTools, initializeMcpTools } = await import('../apps/agent/dist/tools/mcp.js');

const mcpSummary = await initializeMcpTools();
const app = await buildServer();
await app.listen({ host: '127.0.0.1', port: 0 });
const address = app.server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
let projectId;

try {
  assert(mcpSummary.registeredTools > 0, 'MCP 工具未被注册');
  const tools = await getJson('/api/tools');
  assert(
    tools.some((tool) => tool.name === 'mcp_fixture_echo'),
    'MCP 工具目录缺少 mcp_fixture_echo',
  );

  const project = await postJson('/api/projects', { name: 'm3-regression', path: workspaceDir });
  projectId = project.id;

  await caseDirectAnswer();
  await caseReadFile();
  await caseWriteApproval();
  await caseHttpApproval();
  await caseMcpTool();
  await caseCancel();
  await caseTraversalDenied();
  await caseSymlinkDenied();
  await caseApprovalRejected();
  await caseApprovalTimeout();
  await caseIllegalUrl();
  await caseSandboxBoundary();
  await caseUnconfiguredProvider();

  console.log('M3 regression passed');
} finally {
  await closeMcpTools();
  await app.close();
  await closeServer(llmFixture.server);
  await closeServer(httpFixture.server);
}

process.exit(0);

async function caseDirectAnswer() {
  const result = await runTask('M3_DIRECT answer directly');
  assert(result.task.status === 'completed', '直接回答任务未完成');
  assertTrace(result.traces, 'llm', true, '直接回答缺少成功 LLM 轨迹');
  assertTrace(result.traces, 'done', true, '直接回答缺少 done 轨迹');

  const lateEvents = await streamExistingTask(result.task.id);
  assert(lateEvents.some((event) => event.type === 'task_created'), '迟到 SSE 缺少 task_created');
  assert(lateEvents.some((event) => event.type === 'phase'), '迟到 SSE 缺少 phase');
  assert(lateEvents.some((event) => event.type === 'done'), '迟到 SSE 缺少 done');
}

async function caseReadFile() {
  const result = await runTask('M3_READ read the workspace note');
  assert(result.task.status === 'completed', '读文件任务未完成');
  assertTrace(result.traces, 'tool_call', true, '读文件缺少 tool_call 轨迹');
  assertTrace(result.traces, 'tool_result', true, '读文件缺少成功 tool_result 轨迹');
}

async function caseWriteApproval() {
  const result = await runTask('M3_WRITE_APPROVE write approved file', { approve: true });
  assert(result.task.status === 'completed', '写文件审批任务未完成');
  assertTrace(result.traces, 'approval', true, '写文件缺少审批通过轨迹');
  const content = await readFile(join(workspaceDir, 'approved.txt'), 'utf8');
  assert(content.includes('approved write'), '写文件审批未产生真实文件');
}

async function caseHttpApproval() {
  const result = await runTask('M3_HTTP_APPROVE fetch approved url', { approve: true });
  assert(result.task.status === 'completed', 'HTTP 审批任务未完成');
  assertTrace(result.traces, 'approval', true, 'HTTP 缺少审批通过轨迹');
  assertTrace(result.traces, 'tool_result', true, 'HTTP 缺少成功工具结果轨迹');
}

async function caseMcpTool() {
  const result = await runTask('M3_MCP call mcp echo tool');
  assert(result.task.status === 'completed', 'MCP 工具任务未完成');
  assert(
    result.traces.some((trace) => trace.toolName === 'mcp_fixture_echo' && trace.kind === 'tool_result'),
    'MCP 工具缺少 tool_result 轨迹',
  );
}

async function caseCancel() {
  const created = await postJson('/api/tasks', { goal: 'M3_CANCEL long running generation' });
  let cancelSent = false;
  const events = await collectTaskStream(created.task.id, async (event) => {
    if (!cancelSent && event.type === 'phase' && event.phase === 'thinking') {
      cancelSent = true;
      await fetch(`${baseUrl}/api/tasks/${created.task.id}/cancel`, { method: 'POST' });
    }
  });
  assert(events.some((event) => event.type === 'done' && event.status === 'cancelled'), '取消任务未进入 done(cancelled)');
  const traces = await getTraces(created.task.id);
  assertTrace(traces, 'done', false, '取消任务缺少失败 done 轨迹');
}

async function caseTraversalDenied() {
  const result = await runTask('M3_TRAVERSAL try directory traversal');
  assertTrace(result.traces, 'tool_result', false, '目录穿越缺少失败工具轨迹');
  assert(
    result.traces.some((trace) => trace.errorMessage?.includes('路径越界')),
    '目录穿越错误未被记录',
  );
}

async function caseSymlinkDenied() {
  const result = await runTask('M3_SYMLINK try symlink escape');
  assertTrace(result.traces, 'tool_result', false, 'symlink 越界缺少失败工具轨迹');
  assert(
    result.traces.some((trace) => trace.errorMessage?.includes('符号链接')),
    'symlink 越界错误未被记录',
  );
}

async function caseApprovalRejected() {
  const result = await runTask('M3_WRITE_REJECT reject write', { approve: false });
  assertTrace(result.traces, 'approval', false, '审批拒绝缺少失败审批轨迹');
  assert(
    result.traces.some((trace) => trace.errorCategory === 'permission'),
    '审批拒绝缺少 permission 分类',
  );
}

async function caseApprovalTimeout() {
  const result = await runTask('M3_APPROVAL_TIMEOUT let approval expire', { approve: 'timeout' });
  assertTrace(result.traces, 'approval', false, '审批超时缺少失败审批轨迹');
  assert(
    result.traces.some((trace) => trace.errorCategory === 'permission'),
    '审批超时缺少 permission 分类',
  );
}

async function caseIllegalUrl() {
  const result = await runTask('M3_BAD_URL fetch illegal url', { approve: true });
  assertTrace(result.traces, 'tool_result', false, '非法 URL 缺少失败工具轨迹');
  assert(
    result.traces.some((trace) => trace.errorMessage?.includes('只允许 http/https')),
    '非法 URL 错误未被记录',
  );
}

async function caseUnconfiguredProvider() {
  const code = `
    process.env.AUREVOY_DB_PATH = ${JSON.stringify(join(tempRoot, 'unconfigured.sqlite'))};
    process.env.AUREVOY_WORKSPACE_DIR = ${JSON.stringify(workspaceDir)};
    process.env.AUREVOY_LLM_API_KEY = '';
    const { createTask, runTask } = await import(${JSON.stringify(new URL('../apps/agent/dist/agent/loop.js', import.meta.url).href)});
    const { taskStore, traceStore } = await import(${JSON.stringify(new URL('../apps/agent/dist/store/db.js', import.meta.url).href)});
    const task = createTask('M3_UNCONFIGURED provider');
    await runTask(task);
    const saved = taskStore.get(task.id);
    const traces = traceStore.list(task.id);
    console.log(JSON.stringify({ status: saved.status, hasConfigError: traces.some((t) => t.errorCategory === 'configuration') }));
  `;
  const output = await runNode(code, {
    ...process.env,
    AUREVOY_LLM_API_KEY: '',
    AUREVOY_MCP_SERVERS_JSON: '',
    AUREVOY_LOG_LEVEL: 'error',
  });
  const result = JSON.parse(output);
  assert(result.status === 'failed', '未配置 Key 未进入 failed');
  assert(result.hasConfigError, '未配置 Key 缺少 configuration 轨迹分类');
}

async function caseSandboxBoundary() {
  const { commandExecutor } = await import('../apps/agent/dist/sandbox/command-executor.js');
  assert(commandExecutor.policy.enabled === false, '命令执行器默认未关闭');
  let rejected = false;
  try {
    await commandExecutor.execute({ command: 'node', args: ['--version'] });
  } catch (err) {
    rejected = err instanceof Error && err.message.includes('命令执行默认关闭');
  }
  assert(rejected, '禁用命令执行器没有拒绝执行');
}

async function runTask(goal, options = {}) {
  const body = { goal };
  if (projectId) body.projectId = projectId;
  const created = await postJson('/api/tasks', body);
  await collectTaskStream(created.task.id, async (event) => {
    if (event.type !== 'approval_request') return;
    if (options.approve === 'timeout') return;
    const approved = options.approve !== false;
    await postJson(`/api/tasks/${created.task.id}/approvals`, {
      callId: event.call.id,
      approved,
    });
  });
  const task = await getJson(`/api/tasks/${created.task.id}`);
  const traces = await getTraces(created.task.id);
  return { task, traces };
}

async function streamExistingTask(taskId) {
  return collectTaskStream(taskId);
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

async function startHttpFixture() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('http fixture body');
  });
  await listen(server, 0);
  return { server, url: `http://127.0.0.1:${server.address().port}/fixture` };
}

async function startLlmFixture(httpUrl) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = JSON.parse(await readRequestBody(req));
    const userMessage = body.messages.find((message) => message.role === 'user');
    const rawUserContent = userMessage?.content ?? '';
    const userText = Array.isArray(rawUserContent)
      ? rawUserContent.map((block) => (typeof block === 'object' && block !== null ? block.text ?? '' : '')).join('')
      : String(rawUserContent);
    const hasToolResult = body.messages.some((message) => message.role === 'tool');

    if (userText.includes('M3_CANCEL')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const timer = setInterval(() => sendSse(res, { choices: [{ delta: { content: '.' } }] }), 50);
      req.on('close', () => clearInterval(timer));
      return;
    }

    if (!hasToolResult) {
      const tool = chooseTool(userText, httpUrl);
      if (tool) {
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
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sendSse(res, { choices: [{ delta: { content: `final:${userText}` } }] });
    sendSse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await listen(server, 0);
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function chooseTool(userText, httpUrl) {
  if (userText.includes('M3_READ')) return { id: 'call_read', name: 'read', args: { path: 'note.txt' } };
  if (userText.includes('M3_WRITE_APPROVE')) {
    return { id: 'call_write_ok', name: 'write', args: { path: 'approved.txt', content: 'approved write' } };
  }
  if (userText.includes('M3_HTTP_APPROVE')) return { id: 'call_http', name: 'web_fetch', args: { url: httpUrl } };
  if (userText.includes('M3_MCP')) return { id: 'call_mcp', name: 'mcp_fixture_echo', args: { text: 'hello' } };
  if (userText.includes('M3_TRAVERSAL')) return { id: 'call_traversal', name: 'open_file', args: { path: '../outside/secret.txt' } };
  if (userText.includes('M3_SYMLINK')) return { id: 'call_symlink', name: 'open_file', args: { path: 'outside-link' } };
  if (userText.includes('M3_WRITE_REJECT')) {
    return { id: 'call_write_reject', name: 'write', args: { path: 'rejected.txt', content: 'must not write' } };
  }
  if (userText.includes('M3_APPROVAL_TIMEOUT')) {
    return { id: 'call_write_timeout', name: 'write', args: { path: 'timeout.txt', content: 'must time out' } };
  }
  if (userText.includes('M3_BAD_URL')) return { id: 'call_bad_url', name: 'web_fetch', args: { url: 'file:///etc/passwd' } };
  return null;
}

function mcpServerCode() {
  return `
    import { Server } from '@modelcontextprotocol/sdk/server/index.js';
    import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
    import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
    const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{
        name: 'echo',
        description: 'Echo text for regression',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false }
      }]
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => ({
      content: [{ type: 'text', text: 'echo:' + String(request.params.arguments?.text ?? '') }]
    }));
    await server.connect(new StdioServerTransport());
  `;
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

function runNode(code, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: rootDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`node subprocess failed ${code}: ${stderr}`));
    });
  });
}

function assertTrace(traces, kind, ok, message) {
  assert(traces.some((trace) => trace.kind === kind && trace.ok === ok), message);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
