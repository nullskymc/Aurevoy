#!/usr/bin/env node

/**
 * 真实 Web UI 轨迹回归。
 *
 * 这不是组件 harness：脚本同时启动构建后的 Agent、Vite React 页面和
 * 一个确定性 LLM HTTP fixture，再通过 Puppeteer 走用户可见的输入、审批、
 * 文件链接和工作台。fixture 只替代外部模型网络，不替代 Aurevoy 的执行链路。
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const WEB_ROOT = join(ROOT, "packages", "web-ui");
const TOKEN = "aurevoy-ui-e2e-token-0123456789abcdef";
const args = process.argv.slice(2);
const keepTemp = args.includes("--keep-temp");
const tempRoot = await mkdtemp(join(tmpdir(), "aurevoy-ui-e2e-"));
const workspaceDir = join(tempRoot, "workspace");
await mkdir(workspaceDir, { recursive: true });
await mkdir(join(workspaceDir, "research"), { recursive: true });
await mkdir(join(workspaceDir, "src"), { recursive: true });

// 1x1 PNG；文件由 fixture 预置，Agent 仍通过真实 workspace read 读取并展示。
await writeFile(
  join(workspaceDir, "plot.png"),
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
);
await writeFile(
  join(workspaceDir, "dashboard.html"),
  "<!doctype html><html><body><main><h1 id=\"e2e-dashboard\">Aurevoy dashboard</h1><button>Local interaction</button></main></body></html>",
  "utf8",
);

const llmFixture = await startLlmFixture();
const agentPort = await freePort();
const uiPort = await freePort();
const agentUrl = `http://127.0.0.1:${agentPort}`;
const uiUrl = `http://127.0.0.1:${uiPort}`;
const env = {
  ...process.env,
  AUREVOY_API_TOKEN: TOKEN,
  AUREVOY_HOST: "127.0.0.1",
  AUREVOY_PORT: String(agentPort),
  AUREVOY_DB_PATH: join(tempRoot, "aurevoy.sqlite"),
  AUREVOY_WORKSPACE_DIR: workspaceDir,
  AUREVOY_LLM_PROVIDER: "openai",
  AUREVOY_LLM_API_KEY: "ui-e2e-key",
  AUREVOY_LLM_BASE_URL: llmFixture.url,
  AUREVOY_LLM_MODEL: "ui-e2e-fixture-model",
  AUREVOY_LLM_PLANNING_ENABLED: "false",
  AUREVOY_EMBEDDING_PROVIDER: "off",
  AUREVOY_MCP_SERVERS_JSON: "",
  AUREVOY_SKILLS_USER_DIR: join(tempRoot, ".aurevoy", "skills"),
  AUREVOY_CORS_ORIGINS: `${uiUrl},http://localhost:${uiPort}`,
  AUREVOY_TEST_BOOTSTRAP: "1",
};

let agentProcess;
let uiProcess;
let browser;
let page;
let researchTaskId;
let projectId;
const report = {
  generatedAt: new Date().toISOString(),
  uiUrl,
  agentUrl,
  workspaceDir,
  trajectories: [],
};

try {
  agentProcess = await startAgent(env, agentUrl);
  const project = await postJson("/api/projects", { name: "ui-e2e-workspace", path: workspaceDir });
  projectId = project.id;
  uiProcess = await startWebUi(uiPort);

  const { default: puppeteer } = await import("puppeteer");
  const executablePath = process.env.AUREVOY_BROWSER_EXECUTABLE?.trim() || undefined;
  browser = await puppeteer.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  // api/index.ts 在模块加载时读取 localStorage；提前注入才能让 bootstrap 指向临时 Agent。
  await page.evaluateOnNewDocument((baseUrl) => {
    window.localStorage.setItem("aurevoy.agentBaseUrl", baseUrl);
  }, agentUrl);
  await page.goto(uiUrl, { waitUntil: "networkidle2", timeout: 30_000 });
  await page.waitForSelector("textarea", { timeout: 30_000 });

  researchTaskId = await runResearchTrajectory();
  await runMultiFileTrajectory();
  await runMediaHtmlTrajectory();
  await verifyRefreshAndRestartRecovery(researchTaskId);

  report.trajectories.push({
    name: "research-report",
    status: "passed",
    taskId: researchTaskId,
    assertion: "UI 创建任务 → write 审批 → Markdown 文件链接 → 工作台预览",
  });
  report.trajectories.push({
    name: "multi-file-modification",
    status: "passed",
    assertion: "UI 创建任务 → 两次文件审批 → 两个文件链接复用同一工作台 tab bar",
  });
  report.trajectories.push({
    name: "image-html-artifacts",
    status: "passed",
    assertion: "UI 创建任务 → 真实 workspace PNG/HTML 文件块 → 图片与 sandbox HTML 预览",
  });
  report.recovery = {
    status: "passed",
    assertion: "刷新并重启 Agent 后重新选择任务，文件链接与工作台 tab 可恢复",
  };
  console.log(JSON.stringify(report, null, 2));
  console.log("UI E2E regression passed: 3 trajectories + refresh/restart recovery");
} finally {
  await browser?.close().catch(() => {});
  await stopProcess(uiProcess);
  await stopProcess(agentProcess);
  await closeServer(llmFixture.server);
  if (!keepTemp) await rm(tempRoot, { recursive: true, force: true });
}

async function runResearchTrajectory() {
  console.log("[ui-e2e] research trajectory: start");
  await openNewChat(true);
  const goal = "E2E_RESEARCH_REPORT 生成一份本地研究报告";
  await submitGoal(goal);
  const taskId = await driveTaskUntilTerminal(goal);
  await openWorkspaceFileFromConversation("research/report.md");
  await page.waitForSelector(".file-viewer-markdown", { timeout: 10_000 });
  const previewText = await page.$eval(".file-viewer-markdown", (element) => element.textContent ?? "");
  assert(previewText.includes("Research report"), "研究报告工作台预览缺少真实文件内容");
  return taskId;
}

async function runMultiFileTrajectory() {
  console.log("[ui-e2e] multi-file trajectory: start");
  await openNewChat(true);
  const goal = "E2E_MULTI_FILE 修改多个文件并给出链接";
  await submitGoal(goal);
  await driveTaskUntilTerminal(goal);
  await openWorkspaceFileFromConversation("src/one.md");
  await openWorkspaceFileFromConversation("src/two.md");
  const tabNames = await page.$$eval(".workbench-tab-name", (elements) => elements.map((element) => element.textContent?.trim() ?? ""));
  assert(tabNames.includes("one.md") && tabNames.includes("two.md"), "多文件修改没有在同一工作台 tab bar 中保留两个文件");
}

async function runMediaHtmlTrajectory() {
  console.log("[ui-e2e] image/html trajectory: start");
  await openNewChat(true);
  const goal = "E2E_MEDIA_HTML 打开图片和 HTML 产物";
  await submitGoal(goal);
  await driveTaskUntilTerminal(goal);
  await openWorkspaceFileFromConversation("plot.png");
  await page.waitForSelector(".file-viewer-image", { timeout: 10_000 });
  await openWorkspaceFileFromConversation("dashboard.html");
  await page.waitForSelector("iframe.file-viewer-html-frame", { timeout: 10_000 });
  const frameTitle = await page.$eval("iframe.file-viewer-html-frame", (element) => element.getAttribute("title"));
  assert(frameTitle?.endsWith("dashboard.html") === true, "HTML 产物没有进入隔离预览 iframe");
}

async function verifyRefreshAndRestartRecovery(taskId) {
  console.log("[ui-e2e] refresh/restart recovery: start");
  // 先确认当前页面已有 research tab，再刷新页面并从真实侧栏重新选择任务。
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForSelector("textarea", { timeout: 30_000 });
  await selectTaskById(taskId);
  await ensureWorkbenchOpen();
  await activateWorkbenchTab("report.md");
  assert(await hasTabNamed("report.md"), "刷新后没有恢复工作台 tab");

  // 关闭并重新启动同一个 Agent 进程，验证 SQLite 任务与前端 token bootstrap 均可恢复。
  await stopProcess(agentProcess);
  agentProcess = await startAgent(env, agentUrl);
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForSelector("textarea", { timeout: 30_000 });
  await selectTaskById(taskId);
  await ensureWorkbenchOpen();
  await activateWorkbenchTab("report.md");
  assert(await hasTabNamed("report.md"), "Agent 重启后没有恢复工作台 tab");
  await page.waitForSelector(".file-viewer-markdown", { timeout: 10_000 });
}

async function openNewChat(projectChat = false) {
  console.log("[ui-e2e] new chat: click");
  await page.evaluate(() => {
    const button = document.querySelector(".sidebar-nav-primary .sidebar-action");
    if (!(button instanceof HTMLElement)) throw new Error("新对话按钮不存在");
    button.click();
  });
  console.log("[ui-e2e] new chat: clicked");
  await page.waitForFunction(() => !document.querySelector(".conversation"), { timeout: 5_000 }).catch(() => undefined);
  console.log("[ui-e2e] new chat: cleared");
  await page.evaluate(() => {
    const button = document.querySelector('button[aria-label="隐藏工作台"]');
    if (button instanceof HTMLElement) button.click();
  });
  if (projectChat) {
    await page.waitForFunction(
      (path) => [...document.querySelectorAll(".drawer-header")].some((element) => element.getAttribute("title") === path),
      { timeout: 15_000 },
      workspaceDir,
    );
    await page.evaluate((path) => {
      const header = [...document.querySelectorAll(".drawer-header")].find((element) => element.getAttribute("title") === path);
      const row = header?.closest(".drawer-header-row")?.parentElement;
      const newChat = row?.querySelector("button.drawer-action");
      if (!(newChat instanceof HTMLElement)) throw new Error("项目新对话按钮不存在");
      newChat.click();
    }, workspaceDir);
  }
  console.log("[ui-e2e] new chat: ready");
}

async function submitGoal(goal) {
  console.log(`[ui-e2e] submit: ${goal}`);
  await page.waitForSelector("textarea", { timeout: 10_000 });
  await page.evaluate((value) => {
    const textarea = document.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("Composer textarea 不存在");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  }, goal);
  console.log(`[ui-e2e] input filled: ${goal}`);
  await page.waitForSelector(".composer-send:not([disabled])", { timeout: 10_000 });
  await page.evaluate(() => {
    const button = document.querySelector(".composer-send");
    if (!(button instanceof HTMLElement)) throw new Error("发送按钮不存在");
    button.click();
  });
  console.log(`[ui-e2e] send clicked: ${goal}`);
  await waitForTaskSummary(goal);
  console.log(`[ui-e2e] task created: ${goal}`);
}

async function driveTaskUntilTerminal(goal) {
  const deadline = Date.now() + 60_000;
  let taskId;
  let lastStatus;
  while (Date.now() < deadline) {
    const summary = await findTaskSummary(goal);
    if (summary) taskId = summary.id;
    const approval = await page.$(".approval-card-btn--allow");
    if (approval) {
      await approval.click();
    }
    if (taskId) {
      const task = await getJson(`/api/tasks/${taskId}`);
      if (task.status !== lastStatus) {
        lastStatus = task.status;
        console.log(`[ui-e2e] ${goal}: ${task.status}`);
      }
      if (["completed", "failed", "cancelled"].includes(task.status)) {
        assert(task.status === "completed", `${goal} 任务未完成：${task.status}`);
        return taskId;
      }
    }
    await delay(120);
  }
  throw new Error(`等待 UI 任务完成超时：${goal}`);
}

async function openWorkspaceFileFromConversation(path) {
  await page.waitForFunction(
    (expected) => [...document.querySelectorAll(".content-block.is-file, .markdown-path-chip, .markdown-file-link")]
      .some((element) => (element.getAttribute("title") ?? element.getAttribute("data-path") ?? element.textContent ?? "").includes(expected)),
    { timeout: 15_000 },
    path,
  );
  const clicked = await page.evaluate((expected) => {
    const elements = [...document.querySelectorAll(".content-block.is-file, .markdown-path-chip, .markdown-file-link")];
    const target = elements.find((element) => {
      const value = element.getAttribute("title") ?? element.getAttribute("data-path") ?? element.textContent ?? "";
      return value.includes(expected);
    });
    if (!(target instanceof HTMLElement)) return false;
    target.click();
    return true;
  }, path);
  assert(clicked, `没有找到文件链接：${path}`);
  await page.waitForFunction(
    (expected) => [...document.querySelectorAll(".workbench-tab-name")].some((element) => element.textContent?.trim() === expected.split(/[\\/]/).pop()),
    { timeout: 10_000 },
    path,
  );
}

async function selectTaskById(taskId) {
  const task = await getJson(`/api/tasks/${taskId}`);
  await page.waitForFunction(
    (goal) => [...document.querySelectorAll(".conv-item")].some((element) => element.title === goal),
    { timeout: 15_000 },
    task.goal,
  );
  await page.evaluate((expected) => {
    const target = [...document.querySelectorAll(".conv-item")].find((element) => element.title === expected);
    target?.click();
  }, task.goal);
  await page.waitForSelector(".conversation", { timeout: 15_000 });
}

async function hasTabNamed(name) {
  return page.evaluate((expected) => [...document.querySelectorAll(".workbench-tab-name")].some((element) => element.textContent?.trim() === expected), name);
}

async function ensureWorkbenchOpen() {
  await page.waitForFunction(() => {
    const workbench = document.querySelector('.workbench');
    return workbench?.getAttribute('data-open') === 'true'
      || document.querySelector('button[aria-label="显示工作台"]') !== null;
  }, { timeout: 10_000 });
  const showButton = await page.$('button[aria-label="显示工作台"]');
  if (showButton) await showButton.click();
  await page.waitForFunction(() => document.querySelector('.workbench[data-open="true"]') !== null, { timeout: 10_000 });
}

async function activateWorkbenchTab(name) {
  await page.waitForFunction(
    (expected) => [...document.querySelectorAll('.workbench-tab-name')].some((element) => element.textContent?.trim() === expected),
    { timeout: 10_000 },
    name,
  );
  await page.evaluate((expected) => {
    const tabName = [...document.querySelectorAll('.workbench-tab-name')]
      .find((element) => element.textContent?.trim() === expected);
    if (!(tabName instanceof HTMLElement)) throw new Error(`工作台 tab 不存在：${expected}`);
    tabName.click();
  }, name);
}

async function waitForTaskSummary(goal) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await findTaskSummary(goal)) return;
    await delay(100);
  }
  throw new Error(`UI 创建任务后未出现在任务列表：${goal}`);
}

async function findTaskSummary(goal) {
  const tasks = await getJson("/api/tasks");
  return tasks.find((task) => task.goal === goal);
}

async function getJson(path) {
  const response = await fetch(`${agentUrl}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return response.json();
}

async function postJson(path, body) {
  const response = await fetch(`${agentUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return response.json();
}

async function startAgent(childEnv, baseUrl) {
  const child = spawn(process.execPath, [join(ROOT, "apps", "agent", "dist", "index.js")], {
    cwd: ROOT,
    env: childEnv,
    stdio: "ignore",
  });
  await waitForHttp(`${baseUrl}/api/health`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  }, child);
  // 启动恢复会从临时 SQLite 读取 provider 槽位；显式写入 fixture，确保 UI
  // 走到“可发送”而不是停在未配置模型的 SetupPanel。
  const settingsResponse = await fetch(`${baseUrl}/api/settings`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      llm: {
        provider: "openai",
        baseUrl: llmFixture.url,
        model: "ui-e2e-fixture-model",
        availableModels: ["ui-e2e-fixture-model"],
        enabledModels: ["ui-e2e-fixture-model"],
        apiKey: "ui-e2e-key",
      },
    }),
  });
  if (!settingsResponse.ok) throw new Error(`UI E2E fixture settings failed: ${settingsResponse.status}`);
  return child;
}

async function startWebUi(port) {
  const child = spawn(process.execPath, [join(ROOT, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(port)], {
    cwd: WEB_ROOT,
    env: process.env,
    stdio: "ignore",
  });
  await waitForHttp(`http://127.0.0.1:${port}/`, {}, child);
  return child;
}

async function waitForHttp(url, init, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`服务进程提前退出：${url} (${child.exitCode})`);
    }
    try {
      const response = await fetch(url, init);
      if (response.status < 500) return;
    } catch {
      // 服务尚未绑定端口，继续短暂轮询。
    }
    await delay(100);
  }
  throw new Error(`等待服务就绪超时：${url}`);
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法取得临时端口");
  const port = address.port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

async function startLlmFixture() {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }
    const body = JSON.parse(await readRequestBody(request));
    const messages = body.messages ?? [];
    const userText = messages.filter((message) => message.role === "user").map((message) => messageText(message.content)).join("\n");
    const latestUserText = messages.filter((message) => message.role === "user").at(-1);
    const latestText = messageText(latestUserText?.content);
    if (latestText.includes("<completion_gate>")) {
      sendFinal(response, "<!-- aurevoy:completion=complete -->");
      return;
    }

    const hasTool = (id) => messages.some((message) => message.role === "tool" && message.tool_call_id === id);
    if (userText.includes("E2E_RESEARCH_REPORT") && !hasTool("e2e-research-write")) {
      sendToolCall(response, "e2e-research-write", "write", {
        path: "research/report.md",
        content: "# Research report\n\nThis report was created through the real Aurevoy UI E2E path.\n",
      });
      return;
    }
    if (userText.includes("E2E_RESEARCH_REPORT")) {
      sendFinal(response, "完成：[research/report.md](research/report.md)");
      return;
    }
    if (userText.includes("E2E_MULTI_FILE")) {
      if (!hasTool("e2e-multi-write-one")) {
        sendToolCall(response, "e2e-multi-write-one", "write", { path: "src/one.md", content: "# One\n" });
        return;
      }
      if (!hasTool("e2e-multi-write-two")) {
        sendToolCall(response, "e2e-multi-write-two", "write", { path: "src/two.md", content: "# Two\n" });
        return;
      }
      sendFinal(response, "完成：[src/one.md](src/one.md) [src/two.md](src/two.md)");
      return;
    }
    if (userText.includes("E2E_MEDIA_HTML")) {
      if (!hasTool("e2e-media-image")) {
        sendToolCall(response, "e2e-media-image", "attach_content", {
          type: "file_reference",
          content: "plot.png",
          name: "plot.png",
          mimeType: "image/png",
        });
        return;
      }
      if (!hasTool("e2e-media-html")) {
        sendToolCall(response, "e2e-media-html", "attach_content", {
          type: "file_reference",
          content: "dashboard.html",
          name: "dashboard.html",
          mimeType: "text/html",
        });
        return;
      }
      sendFinal(response, "已生成图片与 HTML 产物。");
      return;
    }
    sendFinal(response, "fixture complete");
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : "")).join("\n");
}

function sendToolCall(response, id, name, args) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  sendSse(response, {
    choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
  });
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

async function readRequestBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function closeServer(server) {
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  await new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
