#!/usr/bin/env node

/**
 * 浏览器权限与审批 smoke：
 * - 两个真实 stdio MCP server 进程分别使用 read_only / submit profile；
 * - MCP fixture 内用 Puppeteer 访问本地页面，验证只读研究和表单提交；
 * - 任务通过 Agent HTTP API 创建，审批通过真实 pendingApprovals API 投递。
 *
 * 只使用本地页面与确定性模型，不访问公网，不把凭据写入配置或输出。
 */
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";

const ROOT = process.cwd();
const TOKEN = "aurevoy-browser-smoke-token-0123456789";
const tempRoot = await mkdtemp(join(tmpdir(), "aurevoy-browser-smoke-"));
const workspaceDir = join(tempRoot, "workspace");
const skillsDir = join(tempRoot, ".aurevoy", "skills");
await mkdir(workspaceDir, { recursive: true });
await mkdir(join(skillsDir, "browser"), { recursive: true });
await writeFile(
  join(skillsDir, "browser", "SKILL.md"),
  "---\nname: browser\ndescription: Local browser smoke fixture\n---\n\nUse the local browser MCP for this regression.\n",
  "utf8",
);

let formSubmitted = false;
let pageFixture;
let agentProcess;
let llmFixture;
let baseUrl;

try {
  pageFixture = await startPageFixture();
  llmFixture = await startLlmFixture(pageFixture.url);
  const agentPort = await freePort();
  baseUrl = `http://127.0.0.1:${agentPort}`;
  const childEnv = {
    ...process.env,
    AUREVOY_API_TOKEN: TOKEN,
    AUREVOY_HOST: "127.0.0.1",
    AUREVOY_PORT: String(agentPort),
    AUREVOY_DB_PATH: join(tempRoot, "aurevoy.sqlite"),
    AUREVOY_WORKSPACE_DIR: workspaceDir,
    AUREVOY_LLM_PROVIDER: "openai",
    AUREVOY_LLM_API_KEY: "browser-smoke-key",
    AUREVOY_LLM_BASE_URL: llmFixture.url,
    AUREVOY_LLM_MODEL: "browser-smoke-model",
    AUREVOY_LLM_PLANNING_ENABLED: "false",
    AUREVOY_EMBEDDING_PROVIDER: "off",
    AUREVOY_SKILLS_USER_DIR: skillsDir,
    AUREVOY_BROWSER_FIXTURE_ORIGIN: pageFixture.url,
    AUREVOY_MCP_SERVERS_JSON: JSON.stringify({
      mcpServers: {
        "browser-readonly": {
          command: process.execPath,
          args: ["--input-type=module", "-e", browserMcpServerCode()],
          enabled: true,
          browserPermissionProfile: "read_only",
          env: { AUREVOY_BROWSER_FIXTURE_ORIGIN: pageFixture.url },
        },
        "browser-submit": {
          command: process.execPath,
          args: ["--input-type=module", "-e", browserMcpServerCode()],
          enabled: true,
          browserPermissionProfile: "submit",
          env: { AUREVOY_BROWSER_FIXTURE_ORIGIN: pageFixture.url },
        },
      },
    }),
    AUREVOY_TEST_BOOTSTRAP: "1",
  };

  agentProcess = await startAgent(childEnv, baseUrl);
  console.log("[browser-smoke] Agent ready");
  await assertPermissionStatus();
  console.log("[browser-smoke] permission status ready");
  await runReadOnlyResearchSmoke();
  console.log("[browser-smoke] read-only flow passed");
  await runSubmitApprovalSmoke();

  console.log("Browser permission regression passed: read-only research + approved form flow");
} finally {
  await stopProcess(agentProcess);
  await closeServer(llmFixture?.server);
  await closeServer(pageFixture?.server);
  await rm(tempRoot, { recursive: true, force: true });
}

async function assertPermissionStatus() {
  const status = await getJson("/api/mcp/status");
  const readonly = status.servers.find((server) => server.name === "browser-readonly");
  const submit = status.servers.find((server) => server.name === "browser-submit");
  assert(readonly?.connected === true, "browser-readonly MCP 未连接");
  assert(readonly.registeredTools === 2, "read_only profile 未只注册导航/快照工具");
  assert(readonly.blockedTools === 1, "read_only profile 未拦截提交工具");
  assert(readonly.toolNames.includes("browser_navigate"), "只读 profile 缺少 browser_navigate");
  assert(readonly.toolNames.includes("browser_snapshot"), "只读 profile 缺少 browser_snapshot");
  assert(!readonly.toolNames.includes("browser_click"), "只读 profile 错误放开 browser_click");
  assert(submit?.connected === true, "browser-submit MCP 未连接");
  assert(submit.registeredTools === 3 && submit.blockedTools === 0, "submit profile 未逐级放开浏览器工具");
  assert(submit.toolRisks?.browser_click === "dangerous", "表单提交工具没有 dangerous 风险级别");

  const browserStatus = await getJson("/api/browser/status");
  assert(browserStatus.state === "ready", "浏览器运行时状态未进入 ready");
  assert(browserStatus.skillInstalled === true && browserStatus.skillEnabled === true, "浏览器 Skill 未按 smoke fixture 启用");

  const browserTest = await postJson("/api/browser/test", { serverName: "browser-readonly" });
  assert(browserTest.ok === true && browserTest.registeredTools === 2, "浏览器连接测试未复用只读 profile");
  assert(browserTest.blockedTools === 1, "浏览器连接测试未报告被 profile 拦截的工具");
}

async function runReadOnlyResearchSmoke() {
  const created = await postJson("/api/tasks", { goal: "BROWSER_READONLY_SMOKE 读取本地研究页" });
  const taskId = created.task.id;
  const observed = await driveTask(taskId);
  assert(observed.status === "completed", "只读研究任务未完成");
  assert(observed.approvals.some((item) => item.toolName === "mcp_browser-readonly_browser_navigate" && item.riskLevel === "safe"), "导航没有经过显式审批记录");
  assert(observed.approvals.some((item) => item.toolName === "mcp_browser-readonly_browser_snapshot" && item.riskLevel === "safe"), "快照没有经过显式审批记录");
  assert(observed.task.messages.some((message) => message.role === "tool" && message.toolCallId === "e2e-browser-read-nav" && message.content.includes("/research")), "只读导航没有返回本地研究页路径");
  assert(observed.task.messages.some((message) => message.role === "tool" && message.content.includes("Aurevoy local research")), "只读研究没有读取真实本地页面内容");
}

async function runSubmitApprovalSmoke() {
  const created = await postJson("/api/tasks", { goal: "BROWSER_SUBMIT_SMOKE 提交本地表单" });
  const taskId = created.task.id;
  const observed = await driveTask(taskId);
  assert(observed.status === "completed", "表单提交任务未完成");
  assert(observed.approvals.some((item) => item.toolName === "mcp_browser-submit_browser_click" && item.riskLevel === "dangerous"), "表单提交没有以 dangerous 工具进入审批");
  assert(formSubmitted, "浏览器 fixture 没有实际完成表单提交");
}

async function driveTask(taskId) {
  const deadline = Date.now() + 60_000;
  const approved = new Set();
  const approvals = [];
  let lastStatus;
  while (Date.now() < deadline) {
    const task = await getJson(`/api/tasks/${taskId}`);
    if (task.status !== lastStatus) {
      lastStatus = task.status;
      console.log(`[browser-smoke] ${taskId}: ${task.status}`);
    }
    for (const pending of task.pendingApprovals ?? []) {
      const callId = pending.call.id;
      approvals.push({
        callId,
        toolName: pending.call.toolName,
        riskLevel: pending.riskLevel,
      });
      if (approved.has(callId)) continue;
      console.log(`[browser-smoke] approving ${pending.call.toolName}`);
      const decision = await postJson(`/api/tasks/${taskId}/approvals`, { callId, approved: true });
      assert(decision.delivered === true, `审批没有投递到浏览器调用：${pending.call.toolName}`);
      approved.add(callId);
    }
    if (["completed", "failed", "cancelled"].includes(task.status)) {
      return { status: task.status, task, approvals };
    }
    await delay(120);
  }
  throw new Error(`浏览器 smoke 任务超时：${taskId}`);
}

async function startAgent(childEnv, url) {
  const child = spawn(process.execPath, [join(ROOT, "apps", "agent", "dist", "index.js")], {
    cwd: ROOT,
    env: childEnv,
    stdio: "ignore",
  });
  await waitForHttp(`${url}/api/health`, child);
  const settings = await fetch(`${url}/api/settings`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!settings.ok) throw new Error(`读取 smoke settings 失败：${settings.status}`);
  const response = await fetch(`${url}/api/settings`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      llm: {
        provider: "openai",
        baseUrl: llmFixture.url,
        model: "browser-smoke-model",
        availableModels: ["browser-smoke-model"],
        enabledModels: ["browser-smoke-model"],
        apiKey: "browser-smoke-key",
      },
    }),
  });
  if (!response.ok) throw new Error(`写入 smoke settings 失败：${response.status}`);
  return child;
}

async function startPageFixture() {
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/research") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><body><main><h1>Aurevoy local research</h1><p>Deterministic browser smoke page.</p></main></body></html>");
      return;
    }
    if (request.method === "GET" && request.url === "/form") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><body><form id=\"local-form\" onsubmit=\"event.preventDefault(); fetch('/submit', {method:'POST'}).then(() => { document.body.innerText = 'Submitted locally'; });\"><input aria-label=\"note\" value=\"local\"><button id=\"submit\" type=\"submit\">Submit local form</button></form></body></html>");
      return;
    }
    if (request.method === "POST" && request.url === "/submit") {
      formSubmitted = true;
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><body><main><h1>Submitted locally</h1></main></body></html>");
      return;
    }
    response.writeHead(404).end();
  });
  await listen(server, 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("本地浏览器页面 fixture 未取得端口");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function startLlmFixture(pageUrl) {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(await readRequestBody(request));
    const messages = body.messages ?? [];
    const userText = messages
      .filter((message) => message.role === "user")
      .map((message) => messageText(message.content))
      .join("\n");
    if (messages.some((message) => message.role === "user" && messageText(message.content).includes("<completion_gate>"))) {
      sendFinal(response, "<!-- aurevoy:completion=complete -->");
      return;
    }
    const hasTool = (id) => messages.some((message) => message.role === "tool" && message.tool_call_id === id);

    if (userText.includes("BROWSER_READONLY_SMOKE")) {
      if (!hasTool("e2e-browser-read-nav")) {
        sendToolCall(response, "e2e-browser-read-nav", "mcp_browser-readonly_browser_navigate", { url: `${pageUrl}/research` });
        return;
      }
      if (!hasTool("e2e-browser-read-snapshot")) {
        sendToolCall(response, "e2e-browser-read-snapshot", "mcp_browser-readonly_browser_snapshot", {});
        return;
      }
      sendFinal(response, "已读取本地研究页。");
      return;
    }

    if (userText.includes("BROWSER_SUBMIT_SMOKE")) {
      if (!hasTool("e2e-browser-submit-nav")) {
        sendToolCall(response, "e2e-browser-submit-nav", "mcp_browser-submit_browser_navigate", { url: `${pageUrl}/form` });
        return;
      }
      if (!hasTool("e2e-browser-submit-click")) {
        sendToolCall(response, "e2e-browser-submit-click", "mcp_browser-submit_browser_click", { selector: "#submit" });
        return;
      }
      sendFinal(response, "已提交本地表单。");
      return;
    }
    sendFinal(response, "fixture complete");
  });
  await listen(server, 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("LLM fixture 未取得端口");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function browserMcpServerCode() {
  return `
    import puppeteer from 'puppeteer';
    import { Server } from '@modelcontextprotocol/sdk/server/index.js';
    import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
    import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
    const origin = process.env.AUREVOY_BROWSER_FIXTURE_ORIGIN;
    const server = new Server({ name: 'aurevoy-browser-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
    let browser;
    let page;
    async function ensurePage() {
      if (page) return page;
      browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      page = await browser.newPage();
      await page.setViewport({ width: 1024, height: 768 });
      return page;
    }
    const tools = [
      { name: 'browser_navigate', description: 'Navigate to a local research or form page.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
      { name: 'browser_snapshot', description: 'Read the current page text.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      { name: 'browser_click', description: 'Submit or click a page control.', inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'], additionalProperties: false } },
    ];
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = request.params.arguments ?? {};
      const current = await ensurePage();
      if (name === 'browser_navigate') {
        const target = new URL(String(args.url ?? ''), origin);
        if (target.origin !== new URL(origin).origin) throw new Error('fixture only accepts local page origin');
        await current.goto(target.toString(), { waitUntil: 'domcontentloaded' });
        return { content: [{ type: 'text', text: 'navigated ' + target.pathname }] };
      }
      if (name === 'browser_snapshot') {
        const text = await current.evaluate(() => document.body?.innerText ?? '');
        return { content: [{ type: 'text', text }] };
      }
      if (name === 'browser_click') {
        // 通过页面内真实 DOM click 触发表单 fetch；不把页面导航等待和 MCP 调用绑定在一起。
        await current.evaluate((selector) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement)) throw new Error('selector not found: ' + selector);
          element.click();
        }, String(args.selector ?? ''));
        await new Promise((resolve) => setTimeout(resolve, 200));
        let bodyText = '';
        try { bodyText = await current.evaluate(() => document.body?.innerText ?? ''); } catch { /* 页面仍在切换，提交状态由 fixture 服务器记录。 */ }
        return { content: [{ type: 'text', text: bodyText || 'clicked ' + String(args.selector ?? '') }] };
      }
      throw new Error('unknown browser fixture tool: ' + name);
    });
    process.on('SIGTERM', async () => { await browser?.close().catch(() => {}); process.exit(0); });
    await server.connect(new StdioServerTransport());
  `;
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return response.json();
}

async function postJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function waitForHttp(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`Agent 提前退出：${child.exitCode}`);
    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
      if (response.status < 500) return;
    } catch {
      // Agent 尚未绑定端口，继续轮询。
    }
    await delay(100);
  }
  throw new Error(`等待 Agent 就绪超时：${url}`);
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法取得临时端口");
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function readRequestBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : "")).join("\n");
}

function sendToolCall(response, id, name, args) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  sendSse(response, { choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
  sendSse(response, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  sendSse(response, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } });
  response.write("data: [DONE]\n\n");
  response.end();
}

function sendFinal(response, content) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  sendSse(response, { choices: [{ delta: { content } }] });
  sendSse(response, { choices: [{ delta: {}, finish_reason: "stop" }] });
  sendSse(response, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } });
  response.write("data: [DONE]\n\n");
  response.end();
}

function sendSse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
