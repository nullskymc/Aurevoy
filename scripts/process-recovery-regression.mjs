// 进程级恢复回归：真实启动 Agent，写入在途状态，强制退出后再重启检查 SQLite 状态。
// 运行: npm run regression:process-recovery

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import net from "node:net";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const token = "aurevoy-process-recovery-token";
const tempRoot = await mkdtemp(join(tmpdir(), "aurevoy-process-recovery-"));
const workspaceDir = join(tempRoot, "workspace");
const dbPath = join(tempRoot, "aurevoy.sqlite");
await mkdir(workspaceDir, { recursive: true });

let passed = 0;
let failed = 0;
let child;
let childLogs = "";

function assert(condition, message) {
  if (condition) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function makeTask(id, overrides = {}) {
  const now = "2026-08-07T00:00:00.000Z";
  return {
    id,
    goal: `进程恢复回归 ${id}`,
    title: `进程恢复回归 ${id}`,
    status: "running",
    phase: "calling_tool",
    plan: [{ id: "step-1", description: "等待恢复", status: "completed" }],
    messages: [],
    artifacts: [],
    fileChanges: [],
    clarifications: [],
    pendingApprovals: [],
    checkpoints: [],
    budget: {},
    budgetUsage: { iterations: 0, toolCalls: 0, wallTimeMs: 0, outputBytes: 0 },
    lifetimeBudget: {},
    lifetimeUsage: { iterations: 0, toolCalls: 0, wallTimeMs: 0, outputBytes: 0 },
    tokenUsage: { available: false },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function childEnvironment(port) {
  return {
    ...process.env,
    AUREVOY_API_TOKEN: token,
    AUREVOY_TEST_BOOTSTRAP: "1",
    AUREVOY_HOST: "127.0.0.1",
    AUREVOY_PORT: String(port),
    AUREVOY_DB_PATH: dbPath,
    AUREVOY_WORKSPACE_DIR: workspaceDir,
    AUREVOY_LLM_PROVIDER: "openai",
    AUREVOY_LLM_API_KEY: "process-recovery-test-key",
    AUREVOY_LLM_BASE_URL: "http://127.0.0.1:9/v1",
    AUREVOY_LLM_MODEL: "process-recovery-fixture",
    AUREVOY_MCP_SERVERS_JSON: "",
    AUREVOY_EMBEDDING_PROVIDER: "off",
    AUREVOY_SKILLS_USER_DIR: join(tempRoot, "skills", "user"),
    AUREVOY_SKILLS_BUILTIN_DIR: join(tempRoot, "skills", "builtin"),
    AUREVOY_LOG_PRETTY: "false",
  };
}

async function findFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function startAgent(port) {
  childLogs = "";
  child = spawn(process.execPath, [join(ROOT, "apps/agent/dist/index.js")], {
    cwd: ROOT,
    env: childEnvironment(port),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk) => {
    childLogs = `${childLogs}${chunk.toString()}`.slice(-8_000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  return child;
}

function waitForExit(processHandle) {
  return new Promise((resolve) => {
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
      resolve();
      return;
    }
    processHandle.once("exit", resolve);
  });
}

async function waitForHealth(baseUrl, processHandle, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Agent 子进程提前退出（${processHandle.exitCode}）\n${childLogs}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) return;
    } catch {
      // 监听尚未就绪，短暂重试。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Agent 子进程在 ${timeoutMs}ms 内未就绪\n${childLogs}`);
}

async function getTask(baseUrl, id) {
  const response = await fetch(`${baseUrl}/api/tasks/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  assert(response.ok, `${id} 任务详情应可在重启后读取`);
  return body;
}

async function getTraces(baseUrl, id) {
  const response = await fetch(`${baseUrl}/api/tasks/${id}/traces`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  assert(response.ok, `${id} 任务轨迹应可在重启后读取`);
  return Array.isArray(body) ? body : body.traces ?? [];
}

try {
  // 父进程也必须指向同一临时库；否则写入快照会污染用户默认数据库。
  process.env.AUREVOY_DB_PATH = dbPath;
  process.env.AUREVOY_WORKSPACE_DIR = workspaceDir;
  const { db, taskStore } = await import("../apps/agent/dist/store/db.js");
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  // 第一进程只负责建立真实服务；状态在服务运行期间写入，模拟进程被强制终止前的持久快照。
  startAgent(port);
  await waitForHealth(baseUrl, child);
  taskStore.save(makeTask("process-recovery-running"));
  taskStore.save(makeTask("process-recovery-approval", {
    status: "paused",
    phase: "waiting_approval",
    pendingApprovals: [{
      call: { id: "approval-call", toolName: "execute_command", args: { command: "npm test" } },
      riskLevel: "dangerous",
      createdAt: "2026-08-07T00:00:01.000Z",
    }],
  }));
  taskStore.save(makeTask("process-recovery-clarification", {
    status: "paused",
    phase: "waiting_clarification",
    clarifications: [{
      id: "clarification-1",
      question: "需要哪个目录？",
      callId: "question-call",
      status: "pending",
      createdAt: "2026-08-07T00:00:01.000Z",
    }],
  }));

  child.kill("SIGKILL");
  await waitForExit(child);
  assert(child.signalCode === "SIGKILL", "第一 Agent 进程应由 SIGKILL 强制终止");

  // 第二进程触发真实 buildServer 启动恢复逻辑，而不是直接调用恢复函数。
  startAgent(port);
  await waitForHealth(baseUrl, child);
  const running = await getTask(baseUrl, "process-recovery-running");
  const approval = await getTask(baseUrl, "process-recovery-approval");
  const clarification = await getTask(baseUrl, "process-recovery-clarification");
  const runningTraces = await getTraces(baseUrl, "process-recovery-running");

  assert(runningTraces.some((trace) => /重启后自动恢复|restart/i.test(String(trace.summary ?? ""))), "running 任务应留下进程重启恢复轨迹");
  assert(running.resumedAfterRestart === true, "running 任务应持久化重启恢复标记，刷新后仍可解释状态");
  assert(["pending", "planning", "running", "failed", "completed"].includes(running.status), "running 任务应收敛到可解释状态");
  assert(approval.status === "failed" && approval.phase === "failed", "等待审批任务重启后应保守标记为可手动恢复失败");
  assert(Array.isArray(approval.pendingApprovals) && approval.pendingApprovals.length === 0, "重启后不得保留过期审批句柄");
  assert(clarification.status === "failed" && clarification.phase === "failed", "等待澄清任务重启后应保守标记为可手动恢复失败");
} catch (error) {
  failed++;
  console.error(`  FAIL: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await waitForExit(child);
  }
  try {
    const { db } = await import("../apps/agent/dist/store/db.js");
    if (db.open) db.close();
  } catch {
    // 子进程启动失败时，父进程可能没有成功打开 SQLite。
  }
  await rm(tempRoot, { recursive: true, force: true });
}

console.log(`进程恢复回归：通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
