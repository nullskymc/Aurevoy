import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import pino from 'pino';

const LOOP_COUNT = 36;
const STREAM_TIMEOUT_MS = 60_000;
const tempRoot = await mkdtemp(join(tmpdir(), 'aurevoy-long-loop-'));
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
process.env.AUREVOY_LLM_MODEL = 'long-loop-fixture-model';
process.env.AUREVOY_LLM_PLANNING_ENABLED = 'false';
process.env.AUREVOY_MCP_SERVERS_JSON = '';
process.env.AUREVOY_ENABLE_COMMAND_EXECUTION = 'true';
process.env.AUREVOY_COMMAND_TIMEOUT_MS = '2000';
process.env.AUREVOY_COMMAND_OUTPUT_LIMIT_BYTES = '128';

await import('../apps/agent/dist/tool/index.js').then(m => m.initializeUnifiedToolFramework());
const { buildServer } = await import('../apps/agent/dist/server.js');
const {
  buildConversationViewModel,
} = await import('../packages/web-ui/dist/components/conversationWorkflow.js');

const app = await buildServer(pino({ level: 'silent' }));
await app.listen({ host: '127.0.0.1', port: 0 });
const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

try {
  const uninterrupted = await runUninterruptedTask();
  assertRealtimeEventOrder(uninterrupted.events);
  assertFinalTaskShape(uninterrupted.task);
  assertConversationWorkflow(uninterrupted.task.messages);

  const reconnected = await runReconnectedTask();
  assertFinalTaskShape(reconnected.task);
  assertReplayEquivalent(uninterrupted.task.messages, reconnected.task.messages);
  assertReconnectedStream(reconnected.events);

  console.log('Long-loop regression passed');
} finally {
  await app.close();
  await closeServer(llmFixture.server);
}

process.exit(0);

async function runUninterruptedTask() {
  const approved = new Set();
  const created = await postJson('/api/tasks', {
    goal: 'LONG_LOOP uninterrupted timing test',
    budget: { maxIterations: LOOP_COUNT + 8, maxToolCalls: LOOP_COUNT + 8 },
  });
  const events = await collectTaskStream(created.task.id, (event) => approveIfNeeded(created.task.id, event, approved));
  const task = await getJson(`/api/tasks/${created.task.id}`);
  return { task, events };
}

async function runReconnectedTask() {
  const approved = new Set();
  const created = await postJson('/api/tasks', {
    goal: 'LONG_LOOP reconnect replay test',
    budget: { maxIterations: LOOP_COUNT + 8, maxToolCalls: LOOP_COUNT + 8 },
  });

  const events = [];
  await collectTaskStreamUntil(
    created.task.id,
    events,
    (state) => state.toolMessageIds.size >= 10,
    (event) => approveIfNeeded(created.task.id, event, approved),
  );
  await delay(15);
  await collectTaskStreamUntil(
    created.task.id,
    events,
    (state) => state.toolMessageIds.size >= 24,
    (event) => approveIfNeeded(created.task.id, event, approved),
  );
  await delay(15);
  await collectTaskStreamUntil(
    created.task.id,
    events,
    (state) => state.done,
    (event) => approveIfNeeded(created.task.id, event, approved),
  );

  const task = await getJson(`/api/tasks/${created.task.id}`);
  return { task, events };
}

async function collectTaskStream(taskId, onEvent = async () => {}) {
  const events = [];
  await collectTaskStreamUntil(taskId, events, (state) => state.done, onEvent);
  return events;
}

async function collectTaskStreamUntil(taskId, events, shouldStop, onEvent = async () => {}) {
  const startedAt = Date.now();
  const res = await fetch(`${baseUrl}/api/tasks/${taskId}/stream`);
  assert(res.ok && res.body, `SSE 订阅失败: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const state = streamStateFromEvents(events);
  let buffer = '';

  for (;;) {
    if (Date.now() - startedAt >= STREAM_TIMEOUT_MS) {
      const task = await getJson(`/api/tasks/${taskId}`);
      const traces = await getJson(`/api/tasks/${taskId}/traces`);
      const recentTraces = traces.slice(-5).map((trace) => `${trace.kind}:${trace.phase}:${trace.summary ?? trace.errorMessage ?? ''}`);
      await reader.cancel().catch(() => {});
      throw new Error(
        `SSE 收流超时: ${taskId}; status=${task.status}; phase=${task.phase}; messages=${task.messages.length}; traces=${recentTraces.join(' | ')}`,
      );
    }
    const read = await Promise.race([
      reader.read(),
      delay(1000).then(() => ({ timeout: true })),
    ]);
    if ('timeout' in read) continue;
    const { done, value } = read;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const line = chunk.split('\n').find((item) => item.startsWith('data:'));
      if (!line) continue;
      const event = JSON.parse(line.slice('data:'.length).trim());
      events.push(event);
      applyStreamState(state, event);
      await onEvent(event);
      if (shouldStop(state)) {
        await reader.cancel().catch(() => {});
        return events;
      }
    }
  }
  return events;
}

async function approveIfNeeded(taskId, event, approved) {
  const pending =
    event.type === 'approval_request'
      ? [event.call]
      : event.type === 'task_created'
        ? (event.task.pendingApprovals ?? []).map((item) => item.call)
        : [];
  for (const call of pending) {
    if (approved.has(call.id)) continue;
    approved.add(call.id);
    await postJson(`/api/tasks/${taskId}/approvals`, {
      callId: call.id,
      approved: true,
    });
  }
}

function streamStateFromEvents(events) {
  const state = { done: false, toolMessageIds: new Set() };
  for (const event of events) applyStreamState(state, event);
  return state;
}

function applyStreamState(state, event) {
  if (event.type === 'done') state.done = true;
  if (event.type === 'message' && event.message?.role === 'tool' && event.message.toolCallId) {
    state.toolMessageIds.add(event.message.toolCallId);
  }
}

function assertRealtimeEventOrder(events) {
  for (let i = 1; i <= LOOP_COUNT; i += 1) {
    const callId = callIdForIteration(i);
    const tokenIndex = events.findIndex(
      (event) => event.type === 'token' && event.delta.includes(contentForIteration(i)),
    );
    const toolCallIndex = events.findIndex(
      (event) => event.type === 'tool_call' && event.call.id === callId,
    );
    const toolResultIndex = events.findIndex(
      (event) => event.type === 'tool_result' && event.result.callId === callId,
    );
    const toolMessageIndex = events.findIndex(
      (event) => event.type === 'message' && event.message.role === 'tool' && event.message.toolCallId === callId,
    );
    const assistantMessageIndex = events.findIndex(
      (event) =>
        event.type === 'message' &&
        event.message.role === 'assistant' &&
        event.message.toolCalls?.some((call) => call.id === callId),
    );

    assert(tokenIndex >= 0, `第 ${i} 轮缺少正文 token；事件摘要=${debugEventSummary(events)}`);
    assert(toolCallIndex >= 0, `第 ${i} 轮缺少 tool_call 事件`);
    assert(
      toolResultIndex >= 0,
      `第 ${i} 轮缺少 tool_result 事件；附近事件=${eventsAroundCall(events, callId).join(' > ')}；tool_result总数=${events.filter((event) => event.type === 'tool_result').length}；前5个=${events.filter((event) => event.type === 'tool_result').slice(0, 5).map((event) => event.result?.callId).join(',')}`,
    );
    assert(toolMessageIndex >= 0, `第 ${i} 轮缺少 tool message 事件`);
    assert(assistantMessageIndex >= 0, `第 ${i} 轮缺少 assistant tool_calls message`);
    assert(tokenIndex < toolCallIndex, `第 ${i} 轮 tool_call 早于正文 token`);
    assert(toolCallIndex < toolResultIndex, `第 ${i} 轮 tool_result 早于 tool_call`);
    assert(toolResultIndex < toolMessageIndex, `第 ${i} 轮 tool message 早于 tool_result`);
  }
}

function assertFinalTaskShape(task) {
  assert(task.status === 'completed', `长 loop 任务应完成，实际 ${task.status}`);
  const assistantToolMessages = task.messages.filter(
    (message) => message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0,
  );
  const toolMessages = task.messages.filter((message) => message.role === 'tool');
  assert(assistantToolMessages.length === LOOP_COUNT, `assistant tool_calls 数量异常: ${assistantToolMessages.length}`);
  assert(toolMessages.length === LOOP_COUNT, `tool message 数量异常: ${toolMessages.length}`);

  for (let i = 0; i < assistantToolMessages.length; i += 1) {
    const assistant = assistantToolMessages[i];
    assert(assistant.toolCalls.length === 1, `第 ${i + 1} 轮 assistant tool_calls 应只有 1 个`);
    const call = assistant.toolCalls[0];
    const next = task.messages[task.messages.indexOf(assistant) + 1];
    assert(next?.role === 'tool', `call ${call.id} 后缺少紧邻 tool message`);
    assert(next.toolCallId === call.id, `call ${call.id} 后的 toolCallId 不匹配`);
    assert(call.id === callIdForIteration(i + 1), `第 ${i + 1} 轮 call id 异常: ${call.id}`);
  }

  const roles = task.messages.map((message) => message.role);
  assert(roles[0] === 'user', `首条消息应为 user，实际 ${roles[0]}`);
  assert(roles.at(-1) === 'assistant', `末条消息应为 assistant final，实际 ${roles.at(-1)}`);
  assert(!task.messages.at(-1).toolCalls?.length, '最终 assistant 不应携带 tool_calls');
}

function eventsAroundCall(events, callId) {
  return events
    .filter((event) => {
      if (event.type === 'tool_call') return event.call.id === callId;
      if (event.type === 'tool_result') return event.result.callId === callId;
      if (event.type === 'message') {
        return event.message.toolCallId === callId || event.message.toolCalls?.some((call) => call.id === callId);
      }
      return false;
    })
    .map((event) => {
      if (event.type === 'message') return `${event.type}:${event.message.role}`;
      return event.type;
    });
}

function debugEventSummary(events) {
  const counts = new Map();
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  const firstEvents = events.slice(0, 20).map((event) => {
    if (event.type === 'token') return `token:${event.delta}`;
    if (event.type === 'message') return `message:${event.message.role}:${event.message.content?.slice(0, 30) ?? ''}`;
    if (event.type === 'tool_call') return `tool_call:${event.call.id}`;
    if (event.type === 'tool_result') return `tool_result:${event.result.callId}`;
    return event.type;
  });
  return `counts=${JSON.stringify(Object.fromEntries(counts))}; first=${firstEvents.join(' | ')}`;
}

function assertReplayEquivalent(fullMessages, replayMessages) {
  const full = normalizeMessages(fullMessages);
  const replay = normalizeMessages(replayMessages);
  assert(JSON.stringify(full) === JSON.stringify(replay), '断线重连后的最终消息结构与完整实时流不一致');
}

function assertReconnectedStream(events) {
  const taskCreatedCount = events.filter((event) => event.type === 'task_created').length;
  const statusCount = events.filter((event) => event.type === 'status').length;
  const toolMessageIds = new Set(
    events
      .filter((event) => event.type === 'message' && event.message.role === 'tool')
      .map((event) => event.message.toolCallId),
  );
  assert(taskCreatedCount >= 3, `断线重连应至少收到 3 次 task_created/snapshot，实际 ${taskCreatedCount}`);
  assert(statusCount >= 3, `断线重连应至少收到 3 次 status/snapshot，实际 ${statusCount}`);
  assert(toolMessageIds.size === LOOP_COUNT, `重连流未覆盖全部 tool message，实际 ${toolMessageIds.size}`);
}

function assertConversationWorkflow(messages) {
  const activeCallId = callIdForIteration(20);
  const previousCallId = callIdForIteration(19);
  const activeAssistantIndex = messages.findIndex(
    (message) => message.role === 'assistant' && message.toolCalls?.some((call) => call.id === activeCallId),
  );
  assert(activeAssistantIndex > 0, '缺少用于前端 live 隐藏测试的 assistant message');

  const activeText = contentForIteration(20);
  const partialMessages = messages.slice(0, activeAssistantIndex + 1);
  const partialView = buildConversationViewModel({
    messages: partialMessages,
    liveToolActivity: [{ id: activeCallId }],
    output: activeText,
    hasLiveTail: true,
  });
  const visibleAssistantCalls = partialView.turns
    .flatMap((turn) => turn.agentMessages)
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.toolCalls ?? [])
    .map((call) => call.id);

  assert(visibleAssistantCalls.includes(previousCallId), '前端 live 隐藏逻辑错误：已完成历史工具被隐藏');
  assert(!visibleAssistantCalls.includes(activeCallId), '前端 live 隐藏逻辑错误：当前 live 工具未隐藏');

  assert(partialView.liveOutput === activeText, '当前 assistant 仍隐藏时，不应压掉 live output');

  const completedSlice = messages.slice(0, activeAssistantIndex + 2);
  const completedView = buildConversationViewModel({
    messages: completedSlice,
    liveToolActivity: [],
    output: activeText,
    hasLiveTail: true,
  });
  assert(completedView.liveOutput === '', 'assistant 正文已进入历史区后，应压掉重复 live output');
}

function normalizeMessages(messages) {
  return messages.map((message) => ({
    role: message.role,
    content: normalizeContent(message.content),
    toolCallId: message.toolCallId,
    toolCalls: (message.toolCalls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })),
  }));
}

function normalizeContent(content) {
  if (typeof content !== 'string') return content;
  return content
    .replace(/LONG_LOOP (uninterrupted timing|reconnect replay) test/g, 'LONG_LOOP normalized test')
    .replace(/task_id=[0-9a-f-]+/gi, 'task_id=<id>');
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

async function startLlmFixture() {
  const requestCountByGoal = new Map();
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = JSON.parse(await readRequestBody(req));
    const userText = textFromMessageContent(
      body.messages.find((message) => message.role === 'user')?.content ?? '',
    );

    if (!userText.includes('LONG_LOOP')) {
      return sendFinal(res, `unexpected:${userText}`);
    }

    const nextIteration = (requestCountByGoal.get(userText) ?? 0) + 1;
    requestCountByGoal.set(userText, nextIteration);
    if (nextIteration <= LOOP_COUNT) {
      return sendLongLoopToolCall(res, nextIteration);
    }

    return sendFinal(res, `final: completed ${LOOP_COUNT} loops`);
  });
  await listen(server, 0);
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function sendLongLoopToolCall(res, iteration) {
  const callId = callIdForIteration(iteration);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  sendSse(res, { choices: [{ delta: { content: contentForIteration(iteration) } }] });
  await delay(2);
  sendSse(res, {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: callId,
              type: 'function',
              function: { name: 'bash', arguments: '' },
            },
          ],
        },
      },
    ],
  });
  await delay(2);
  sendSse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{' } }] } }] });
  await delay(2);
  sendSse(res, {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              function: {
                arguments: `"command":${JSON.stringify(process.execPath)},"args":["-e","console.log('loop-${String(iteration).padStart(2, '0')}')"]`,
              },
            },
          ],
        },
      },
    ],
  });
  await delay(2);
  sendSse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] });
  await delay(20);
  sendSse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  sendSse(res, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
  res.write('data: [DONE]\n\n');
  res.end();
}

function sendFinal(res, content) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  sendSse(res, { choices: [{ delta: { content } }] });
  sendSse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
  sendSse(res, { choices: [], usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 } });
  res.write('data: [DONE]\n\n');
  res.end();
}

function sendSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function textFromMessageContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && typeof block.text === 'string') return block.text;
        return '';
      })
      .join('\n');
  }
  return String(content ?? '');
}

async function readRequestBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

function callIdForIteration(iteration) {
  return `call_loop_${String(iteration).padStart(2, '0')}`;
}

function contentForIteration(iteration) {
  return `loop ${String(iteration).padStart(2, '0')} content before tool.`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
