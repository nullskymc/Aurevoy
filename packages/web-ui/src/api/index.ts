import {
  AGENT_DEFAULT_BASE_URL,
  type Automation,
  type AutomationListResponse,
  type AutomationRun,
  type AutomationRunListResponse,
  type BranchTaskResponse,
  type ClarificationAnswerResponse,
  type CleanupDataResponse,
  type ClearTaskQueueResponse,
  type CompactTaskResponse,
  type ContinueTaskResponse,
  type CreateMemoryRequest,
  type CreateAutomationRequest,
  type CreateTaskResponse,
  type DataExportRequest,
  type DataStatusResponse,
  type BrowserRuntimeStatus,
  type BrowserRuntimeTestResponse,
  type HealthDiagnosticsResponse,
  type HealthResponse,
  type MemoryEntry,
  type MemoryListResponse,
  type McpStatusResponse,
  type McpConnectionTestResponse,
  type MessageAttachment,
  type ModelListResponse,
  type OauthLoginRespondRequest,
  type OauthLoginStartRequest,
  type OauthLogoutRequest,
  type OauthSessionSnapshot,
  type PiSessionTreeResponse,
  type PiSessionTreeNavigateResponse,
  type ResumeTaskResponse,
  type RunAutomationResponse,
  type TestAutomationResponse,
  type RevertMode,
  type RevertTaskResponse,
  type SkillDescriptor,
  type SkillDetail,
  type SkillInstallRequest,
  type SkillInstallResponse,
  type SkillUninstallResponse,
  type UnrevertTaskResponse,
  type RuntimeSettings,
  type Task,
  type TaskSummary,
  type TaskArtifact,
  type TaskArtifactContentResponse,
  type TaskObservabilityReport,
  type TokenUsageReport,
  type TaskTraceEntry,
  type TaskTraceListResponse,
  type ToolListResponse,
  type ToolDescriptor,
  type UpdateRuntimeSettingsRequest,
  type UpdateAutomationRequest,
  type UpdateTaskModelRequest,
  type UpdateTaskModelResponse,
  type UpdateToolRequest,
  type Project,
  type ProjectListResponse,
  type CreateProjectRequest,
  type UpdateProjectRequest,
  type UpdateMemoryRequest,
  type UpdateTaskArtifactRequest,
  type WorkspaceReadResponse,
} from '@aurevoy/shared';

/** Agent 引擎地址。优先级：localStorage > 运行时注入 > Vite 环境变量 > 默认值 */
const AGENT_URL_STORAGE_KEY = 'aurevoy.agentBaseUrl';

function resolveBaseUrl(): string {
  return (
    (typeof window !== 'undefined' ? window.localStorage.getItem(AGENT_URL_STORAGE_KEY) : null) ??
    (typeof globalThis !== 'undefined'
      ? (globalThis as unknown as Record<string, string | undefined>).__AUREVOY_AGENT_BASE_URL__
      : null) ??
    (import.meta.env.VITE_AGENT_BASE_URL as string | undefined) ??
    AGENT_DEFAULT_BASE_URL
  );
}

let BASE_URL = resolveBaseUrl();
let API_TOKEN: string | null = null;
let bootstrapPromise: Promise<void> | null = null;
const nativeFetch = globalThis.fetch.bind(globalThis);

export function getBaseUrl(): string {
  return BASE_URL;
}

export function setBaseUrl(url: string): void {
  const next = url.replace(/\/+$/, '');
  if (next !== BASE_URL) API_TOKEN = null;
  BASE_URL = next;
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(AGENT_URL_STORAGE_KEY, BASE_URL);
  }
}

/** 读取当前内存会话令牌；SSE 连接需要通过同一 Bearer 头鉴权。 */
export function getApiToken(): string | null {
  return API_TOKEN;
}

/** 从受信任前端 Origin 获取本次 Agent 启动对应的内存令牌。 */
export async function bootstrapApiSession(): Promise<void> {
  if (API_TOKEN) return;
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    const res = await nativeFetch(`${BASE_URL}/api/auth/bootstrap`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`API session bootstrap failed: ${res.status}`);
    const body = (await res.json()) as { token?: unknown };
    if (typeof body.token !== 'string' || body.token.length < 32) {
      throw new Error('API session bootstrap returned an invalid token');
    }
    API_TOKEN = body.token;
  })().finally(() => {
    bootstrapPromise = null;
  });
  return bootstrapPromise;
}

/** 统一注入 Bearer；引擎重启导致 401 时只重新 bootstrap 并重试一次。 */
async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (!API_TOKEN && !url.endsWith('/api/auth/bootstrap')) {
    await bootstrapApiSession().catch(() => undefined);
  }
  const request = (token: string | null) => {
    const headers = new Headers(init?.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return nativeFetch(input, { ...init, headers });
  };
  const res = await request(API_TOKEN);
  if (res.status !== 401 || url.endsWith('/api/auth/bootstrap')) return res;
  API_TOKEN = null;
  await bootstrapApiSession();
  return request(API_TOKEN);
}

async function throwApiError(res: Response, fallback: string): Promise<never> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    const raw = body.error ?? body.message;
    if (typeof raw === "string") detail = raw;
  } catch {
    try {
      detail = await res.text();
    } catch {
      detail = "";
    }
  }
  throw new Error(detail ? `${fallback}: ${detail}` : `${fallback}: ${res.status}`);
}

export async function checkHealth(): Promise<HealthResponse> {
  const res = await apiFetch(`${BASE_URL}/api/health`);
  if (!res.ok) throw new Error(`health check failed: ${res.status}`);
  return res.json();
}

export async function getHealthDiagnostics(): Promise<HealthDiagnosticsResponse> {
  const res = await apiFetch(`${BASE_URL}/api/health/diagnostics`);
  if (!res.ok) await throwApiError(res, "health diagnostics failed");
  return res.json();
}

export async function createTask(
  goal: string,
  projectId?: string,
  attachments?: MessageAttachment[],
  executionMode: "auto" | "plan" = "auto",
): Promise<CreateTaskResponse> {
  const res = await apiFetch(`${BASE_URL}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal, projectId, attachments, executionMode }),
  });
  if (!res.ok) await throwApiError(res, "create task failed");
  return res.json();
}

export async function listTasks(): Promise<TaskSummary[]> {
  const res = await apiFetch(`${BASE_URL}/api/tasks`);
  if (!res.ok) throw new Error(`list tasks failed: ${res.status}`);
  return res.json();
}

/** 恢复已暂停的 auto mode */
export async function resumeAutoMode(taskId: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/api/tasks/${taskId}/auto-mode-resume`, { method: 'POST' });
  if (!res.ok) await throwApiError(res, "resume auto mode failed");
}

/** 读取单个任务的完整快照（含工具结果等持久化消息） */
export async function getTask(taskId: string): Promise<Task> {
  const res = await apiFetch(`${BASE_URL}/api/tasks/${taskId}`);
  if (!res.ok) await throwApiError(res, "get task failed");
  return res.json();
}

export async function readWorkspaceEntry(options: {
  path: string;
  taskId?: string;
  projectId?: string;
  offset?: number;
  limit?: number;
  /** 工作台预览：全量读取（不走 agent 工具分页截断） */
  full?: boolean;
}): Promise<WorkspaceReadResponse> {
  const params = new URLSearchParams();
  params.set("path", options.path);
  if (options.taskId) params.set("taskId", options.taskId);
  if (options.projectId) params.set("projectId", options.projectId);
  if (options.offset) params.set("offset", String(options.offset));
  if (options.limit) params.set("limit", String(options.limit));
  if (options.full) params.set("full", "1");

  const res = await apiFetch(`${BASE_URL}/api/workspace/read?${params.toString()}`);
  if (!res.ok) await throwApiError(res, "read workspace entry failed");
  return res.json();
}

export async function deleteWorkspacePath(options: {
  path: string;
  taskId?: string;
  projectId?: string;
}): Promise<void> {
  const params = new URLSearchParams();
  params.set("path", options.path);
  if (options.taskId) params.set("taskId", options.taskId);
  if (options.projectId) params.set("projectId", options.projectId);
  const res = await apiFetch(`${BASE_URL}/api/workspace/delete?${params.toString()}`, { method: "DELETE" });
  if (!res.ok) await throwApiError(res, "delete workspace path failed");
}

export async function renameWorkspacePath(options: {
  path: string;
  newName: string;
  taskId?: string;
  projectId?: string;
}): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/api/workspace/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!res.ok) await throwApiError(res, "rename workspace path failed");
}

export async function copyWorkspacePath(options: {
  path: string;
  newName: string;
  taskId?: string;
  projectId?: string;
}): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/api/workspace/copy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!res.ok) await throwApiError(res, "copy workspace path failed");
}

/** 在同一任务内追加一轮用户输入并继续执行（多轮对话） */
export async function continueTask(
  taskId: string,
  message: string,
  attachments?: MessageAttachment[],
  executionMode: "auto" | "plan" = "auto",
  delivery?: "steering" | "follow_up",
): Promise<ContinueTaskResponse> {
  const res = await apiFetch(`${BASE_URL}/api/tasks/${taskId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, attachments, executionMode, delivery }),
  });
  if (!res.ok) await throwApiError(res, "continue task failed");
  return res.json();
}

/** 撤回仍在等待注入的运行中消息；已进入模型上下文的消息不可撤回。 */
export async function clearTaskQueue(
  taskId: string,
  kind: "steering" | "follow_up" | "all" = "all",
): Promise<ClearTaskQueueResponse> {
  const res = await apiFetch(`${BASE_URL}/api/tasks/${taskId}/queue/clear`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind }),
  });
  if (!res.ok) await throwApiError(res, "clear task queue failed");
  return res.json();
}

/** 恢复未完成、失败或已取消任务；后端从持久历史重新进入 Agent 循环 */
export async function resumeTask(taskId: string): Promise<ResumeTaskResponse> {
  const res = await apiFetch(`${BASE_URL}/api/tasks/${taskId}/resume`, {
    method: 'POST',
  });
  if (!res.ok) await throwApiError(res, "resume task failed");
  return res.json();
}

/** 编辑重试的截断步骤；前端确认内联编辑后调用，再立刻 continue 编辑稿 */
export async function revertTask(
  taskId: string,
  messageId: string,
  mode?: RevertMode,
): Promise<RevertTaskResponse> {
  const res = await apiFetch(`${BASE_URL}/api/tasks/${taskId}/revert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId, mode }),
  });
  if (!res.ok) throw new Error(`revert task failed: ${res.status}`);
  return res.json();
}

/** 撤销上一次 revert（continue 尚未提交新消息时）；从归档恢复被截断消息 */
export async function unrevertTask(taskId: string): Promise<UnrevertTaskResponse> {
  const res = await apiFetch(`${BASE_URL}/api/tasks/${taskId}/unrevert`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`unrevert task failed: ${res.status}`);
  return res.json();
}

/** 从指定消息处分支出一个新任务（非破坏性 fork） */
export async function branchTask(
  taskId: string,
  messageId: string,
  goal?: string,
): Promise<BranchTaskResponse> {
  const res = await apiFetch(`${BASE_URL}/api/tasks/${taskId}/branch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId, goal }),
  });
  if (!res.ok) throw new Error(`branch task failed: ${res.status}`);
  return res.json();
}

/** 将指定消息范围压缩为 LLM 摘要 */
export async function compactTask(
  taskId: string,
  fromMessageId?: string,
  toMessageId?: string,
  instructions?: string,
): Promise<CompactTaskResponse> {
  const res = await apiFetch(`${BASE_URL}/api/tasks/${taskId}/compact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromMessageId, toMessageId, instructions }),
  });
  if (!res.ok) throw new Error(`compact task failed: ${res.status}`);
  return res.json();
}

export async function listTaskTraces(taskId: string): Promise<TaskTraceEntry[]> {
  const res = await apiFetch(`${BASE_URL}/api/tasks/${taskId}/traces`);
  if (!res.ok) throw new Error(`list task traces failed: ${res.status}`);
  const body = (await res.json()) as TaskTraceListResponse;
  return body.traces;
}

export async function getTaskSessionTree(taskId: string): Promise<PiSessionTreeResponse> {
  const res = await apiFetch(`${BASE_URL}/api/tasks/${taskId}/session-tree`);
  if (!res.ok) throw new Error(`get task session tree failed: ${res.status}`);
  return res.json();
}

export async function navigateTaskSessionTree(
  taskId: string,
  targetId: string,
  options?: { summarize?: boolean; customInstructions?: string },
): Promise<PiSessionTreeNavigateResponse> {
  const res = await apiFetch(`${BASE_URL}/api/tasks/${taskId}/session-tree/navigate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetId, ...options }),
  });
  if (!res.ok) await throwApiError(res, 'navigate task session tree failed');
  return res.json();
}

export async function setTaskSessionTreeLabel(
  taskId: string,
  targetId: string,
  label?: string,
): Promise<PiSessionTreeResponse> {
  const res = await apiFetch(
    `${BASE_URL}/api/tasks/${taskId}/session-tree/labels/${encodeURIComponent(targetId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    },
  );
  if (!res.ok) await throwApiError(res, "set task session tree label failed");
  return res.json();
}

/**
 * 会话内即时切换某个任务的模型 / 推理档（P1-2 模型粘性）。
 * 后端持久化到 task.modelSnapshot 并发布 model_updated；运行中的任务会同步到 harness。
 */
export async function updateTaskModel(
  taskId: string,
  patch: UpdateTaskModelRequest,
): Promise<UpdateTaskModelResponse> {
  const res = await apiFetch(`${BASE_URL}/api/tasks/${taskId}/model`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) await throwApiError(res, 'update task model failed');
  return res.json();
}

/** 请求后端取消一个进行中的任务（中断其 LLM 流） */
export async function cancelTask(taskId: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/api/tasks/${taskId}/cancel`, { method: 'POST' });
  if (!res.ok) await throwApiError(res, "cancel task failed");
}

/** 删除任务及其关联数据（轨迹、事件等） */
export async function deleteTask(taskId: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/api/tasks/${taskId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`delete task failed: ${res.status}`);
}

/** 对一次工具调用做出审批决策（批准/拒绝） */
export async function approveToolCall(
  taskId: string,
  callId: string,
  approved: boolean,
): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/api/tasks/${taskId}/approvals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callId, approved }),
  });
  if (!res.ok) await throwApiError(res, "approve tool call failed");
}

export async function answerClarification(
  taskId: string,
  clarificationId: string,
  answer: string,
): Promise<ClarificationAnswerResponse> {
  const res = await apiFetch(`${BASE_URL}/api/tasks/${taskId}/clarifications/${clarificationId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer }),
  });
  if (!res.ok) await throwApiError(res, "answer clarification failed");
  return res.json();
}

export async function updateArtifact(
  taskId: string,
  artifactId: string,
  body: UpdateTaskArtifactRequest,
): Promise<TaskArtifact> {
  const res = await apiFetch(`${BASE_URL}/api/tasks/${taskId}/artifacts/${artifactId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`update artifact failed: ${res.status}`);
  return res.json();
}

export async function getArtifactContent(taskId: string, artifactId: string): Promise<TaskArtifactContentResponse> {
  const res = await apiFetch(`${BASE_URL}/api/tasks/${taskId}/artifacts/${artifactId}/content`);
  if (!res.ok) await throwApiError(res, "get artifact content failed");
  return res.json();
}

export async function listTools(): Promise<ToolDescriptor[]> {
  const res = await apiFetch(`${BASE_URL}/api/tools`);
  if (!res.ok) throw new Error(`list tools failed: ${res.status}`);
  const body = (await res.json()) as ToolDescriptor[] | ToolListResponse;
  return Array.isArray(body) ? body : body.tools;
}

export async function fetchSkills(): Promise<SkillDescriptor[]> {
  const res = await apiFetch(`${BASE_URL}/api/skills`);
  if (!res.ok) return [];
  const data = (await res.json()) as { skills: SkillDescriptor[] };
  return data.skills ?? [];
}

export async function fetchSkillDetail(name: string): Promise<SkillDetail> {
  const res = await apiFetch(`${BASE_URL}/api/skills/${encodeURIComponent(name)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? `fetch skill failed: ${res.status}`);
  }
  return res.json() as Promise<SkillDetail>;
}

export async function toggleSkill(name: string, enabled: boolean): Promise<SkillDescriptor> {
  const res = await apiFetch(`${BASE_URL}/api/skills/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `toggle skill failed: ${res.status}`);
  }
  return res.json();
}

export async function reloadSkills(): Promise<SkillDescriptor[]> {
  const res = await apiFetch(`${BASE_URL}/api/skills/reload`, { method: 'POST' });
  if (!res.ok) throw new Error(`reload skills failed: ${res.status}`);
  const data = (await res.json()) as { skills: SkillDescriptor[] };
  return data.skills ?? [];
}

export async function installSkill(request: SkillInstallRequest): Promise<SkillInstallResponse> {
  const res = await apiFetch(`${BASE_URL}/api/skills/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `install failed: ${res.status}`);
  }
  return res.json();
}

export async function uninstallSkill(name: string): Promise<SkillUninstallResponse> {
  const res = await apiFetch(`${BASE_URL}/api/skills/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `uninstall failed: ${res.status}`);
  }
  return res.json();
}

export async function updateTool(
  name: string,
  body: UpdateToolRequest,
): Promise<ToolDescriptor> {
  const res = await apiFetch(`${BASE_URL}/api/tools/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`update tool failed: ${res.status}`);
  return res.json();
}

export async function getSettings(): Promise<RuntimeSettings> {
  const res = await apiFetch(`${BASE_URL}/api/settings`);
  if (!res.ok) throw new Error(`get settings failed: ${res.status}`);
  return res.json();
}

export async function updateSettings(
  body: UpdateRuntimeSettingsRequest,
): Promise<RuntimeSettings> {
  const res = await apiFetch(`${BASE_URL}/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`update settings failed: ${await readErrorMessage(res)}`);
  return res.json();
}

/** 探测 agent 出站网络（使用当前已保存并生效的代理配置） */
export async function testOutboundProxy(probeUrl?: string): Promise<{
  ok: boolean;
  status?: number;
  latencyMs: number;
  error?: string;
  viaProxy?: string | null;
  proxyEnabled?: boolean;
  bodySnippet?: string;
}> {
  const res = await apiFetch(`${BASE_URL}/api/settings/proxy/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(probeUrl ? { probeUrl } : {}),
  });
  if (!res.ok) {
    const message = await readErrorMessage(res);
    return { ok: false, latencyMs: 0, error: message };
  }
  return res.json() as Promise<{
    ok: boolean;
    status?: number;
    latencyMs: number;
    error?: string;
    viaProxy?: string | null;
    proxyEnabled?: boolean;
    bodySnippet?: string;
  }>;
}

export async function listProviderModels(): Promise<string[]> {
  const res = await apiFetch(`${BASE_URL}/api/settings/models`);
  if (!res.ok) throw new Error(`list provider models failed: ${await readErrorMessage(res)}`);
  const body = (await res.json()) as ModelListResponse;
  return body.models;
}

export async function startOauthLogin(provider: string): Promise<OauthSessionSnapshot> {
  const res = await apiFetch(`${BASE_URL}/api/settings/llm/oauth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider } satisfies OauthLoginStartRequest),
  });
  if (!res.ok) throw new Error(`oauth login failed: ${await readErrorMessage(res)}`);
  return res.json() as Promise<OauthSessionSnapshot>;
}

export async function getOauthSession(sessionId: string): Promise<OauthSessionSnapshot> {
  const res = await apiFetch(`${BASE_URL}/api/settings/llm/oauth/session/${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error(`oauth session failed: ${await readErrorMessage(res)}`);
  return res.json() as Promise<OauthSessionSnapshot>;
}

export async function respondOauthSession(sessionId: string, value: string): Promise<OauthSessionSnapshot> {
  const res = await apiFetch(
    `${BASE_URL}/api/settings/llm/oauth/session/${encodeURIComponent(sessionId)}/respond`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value } satisfies OauthLoginRespondRequest),
    },
  );
  if (!res.ok) throw new Error(`oauth respond failed: ${await readErrorMessage(res)}`);
  return res.json() as Promise<OauthSessionSnapshot>;
}

export async function cancelOauthSession(sessionId: string): Promise<OauthSessionSnapshot> {
  const res = await apiFetch(
    `${BASE_URL}/api/settings/llm/oauth/session/${encodeURIComponent(sessionId)}/cancel`,
    { method: 'POST' },
  );
  if (!res.ok) throw new Error(`oauth cancel failed: ${await readErrorMessage(res)}`);
  return res.json() as Promise<OauthSessionSnapshot>;
}

export async function logoutOauthProvider(provider: string): Promise<RuntimeSettings> {
  const res = await apiFetch(`${BASE_URL}/api/settings/llm/oauth/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider } satisfies OauthLogoutRequest),
  });
  if (!res.ok) throw new Error(`oauth logout failed: ${await readErrorMessage(res)}`);
  return res.json() as Promise<RuntimeSettings>;
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim()) {
      return `${res.status}: ${body.error}`;
    }
  } catch {
    // Fall through to the status code when the backend did not return JSON.
  }
  return String(res.status);
}

export async function getMcpStatus(): Promise<McpStatusResponse> {
  const res = await apiFetch(`${BASE_URL}/api/mcp/status`);
  if (!res.ok) throw new Error(`get mcp status failed: ${res.status}`);
  return res.json();
}

/** 读取 browser Skill 与 Playwright MCP 的脱敏运行时状态。 */
export async function getBrowserRuntimeStatus(): Promise<BrowserRuntimeStatus> {
  const res = await apiFetch(`${BASE_URL}/api/browser/status`);
  if (!res.ok) throw new Error(`get browser runtime status failed: ${res.status}`);
  return res.json();
}

/** 只测试已配置的浏览器 MCP；不修改配置、不注册工具。 */
export async function testBrowserRuntime(serverName?: string): Promise<BrowserRuntimeTestResponse> {
  const res = await apiFetch(`${BASE_URL}/api/browser/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(serverName ? { serverName } : {}),
  });
  if (!res.ok) await throwApiError(res, "test browser runtime failed");
  return res.json();
}

/** 只测试一次 MCP 连接并枚举工具，不保存或注册配置。 */
export async function testMcpConnection(server: Record<string, unknown>): Promise<McpConnectionTestResponse> {
  const res = await apiFetch(`${BASE_URL}/api/mcp/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ server }),
  });
  if (!res.ok) await throwApiError(res, "test mcp connection failed");
  return res.json();
}

export async function getDataStatus(): Promise<DataStatusResponse> {
  const res = await apiFetch(`${BASE_URL}/api/data`);
  if (!res.ok) throw new Error(`get data status failed: ${res.status}`);
  return res.json();
}

export async function downloadDataExport(
  includeTaskMessages = false,
): Promise<{ filename: string; size: number }> {
  const body: DataExportRequest = { includeTaskMessages };
  const res = await apiFetch(`${BASE_URL}/api/data/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwApiError(res, "export data failed");

  const blob = await res.blob();
  const header = res.headers.get('content-disposition') ?? '';
  const match = header.match(/filename="([^"]+)"/i);
  const filename = match?.[1] ?? `aurevoy-data-${new Date().toISOString().slice(0, 10)}.json`;

  // 内置 WebView 与普通浏览器都走同一下载路径；无 document 的单测环境仍返回 Blob 大小。
  if (typeof document !== 'undefined') {
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
  return { filename, size: blob.size };
}

export async function downloadDatabaseBackup(): Promise<{ filename: string; size: number }> {
  const res = await apiFetch(`${BASE_URL}/api/data/database-backup`, { method: 'POST' });
  if (!res.ok) await throwApiError(res, "backup database failed");
  const blob = await res.blob();
  const header = res.headers.get('content-disposition') ?? '';
  const match = header.match(/filename="([^"]+)"/i);
  const filename = match?.[1] ?? `aurevoy-backup-${new Date().toISOString().slice(0, 10)}.sqlite`;
  if (typeof document !== 'undefined') {
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
  return { filename, size: blob.size };
}

export async function getTokenUsageReport(): Promise<TokenUsageReport> {
  const res = await apiFetch(`${BASE_URL}/api/data/token-usage`);
  if (!res.ok) throw new Error(`get token usage report failed: ${res.status}`);
  return res.json();
}

export async function getTaskObservabilityReport(): Promise<TaskObservabilityReport> {
  const res = await apiFetch(`${BASE_URL}/api/data/task-metrics`);
  if (!res.ok) throw new Error(`get task observability report failed: ${res.status}`);
  return res.json();
}

export async function cleanupData(olderThanDays?: number): Promise<CleanupDataResponse> {
  const res = await apiFetch(`${BASE_URL}/api/data/cleanup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(olderThanDays == null ? {} : { olderThanDays }),
  });
  if (!res.ok) throw new Error(`cleanup data failed: ${res.status}`);
  return res.json();
}

// ===== 长期记忆 (M4.3) =====

export async function listMemories(): Promise<MemoryEntry[]> {
  const res = await apiFetch(`${BASE_URL}/api/memories`);
  if (!res.ok) throw new Error(`list memories failed: ${res.status}`);
  const body = (await res.json()) as MemoryListResponse;
  return body.memories;
}

export async function createMemory(body: CreateMemoryRequest): Promise<MemoryEntry> {
  const res = await apiFetch(`${BASE_URL}/api/memories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`create memory failed: ${res.status}`);
  return res.json();
}

export async function updateMemory(
  id: string,
  body: UpdateMemoryRequest,
): Promise<MemoryEntry> {
  const res = await apiFetch(`${BASE_URL}/api/memories/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`update memory failed: ${res.status}`);
  return res.json();
}

export async function deleteMemory(id: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/api/memories/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`delete memory failed: ${res.status}`);
}

// ===== 知识库 (M8) =====

export interface KbDir {
  id: string;
  dirPath: string;
  recursive: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KbIndexStatus {
  totalFiles: number;
  totalChunks: number;
  lastIndexed: string | null;
}

export async function listKbDirs(): Promise<KbDir[]> {
  const res = await apiFetch(`${BASE_URL}/api/knowledge-base/dirs`);
  if (!res.ok) throw new Error(`list kb dirs failed: ${res.status}`);
  const body = (await res.json()) as { dirs: KbDir[] };
  return body.dirs;
}

export async function createKbDir(dirPath: string, recursive?: boolean): Promise<KbDir> {
  const res = await apiFetch(`${BASE_URL}/api/knowledge-base/dirs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dirPath, recursive }),
  });
  if (!res.ok) throw new Error(`create kb dir failed: ${res.status}`);
  return res.json();
}

export async function deleteKbDir(id: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/api/knowledge-base/dirs/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`delete kb dir failed: ${res.status}`);
}

export async function getKbStatus(): Promise<KbIndexStatus> {
  const res = await apiFetch(`${BASE_URL}/api/knowledge-base/status`);
  if (!res.ok) throw new Error(`get kb status failed: ${res.status}`);
  return res.json();
}

// ===== 项目 (Projects) =====

export async function listProjects(): Promise<Project[]> {
  const res = await apiFetch(`${BASE_URL}/api/projects`);
  if (!res.ok) throw new Error(`list projects failed: ${res.status}`);
  const body = (await res.json()) as ProjectListResponse;
  return body.projects;
}

export async function createProject(body: CreateProjectRequest): Promise<Project> {
  const res = await apiFetch(`${BASE_URL}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`create project failed: ${res.status}`);
  return res.json();
}

export async function updateProject(id: string, body: UpdateProjectRequest): Promise<Project> {
  const res = await apiFetch(`${BASE_URL}/api/projects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`update project failed: ${res.status}`);
  return res.json();
}

export async function deleteProject(id: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/api/projects/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`delete project failed: ${res.status}`);
}

// ===== 自动化任务 (Automations) =====

export async function listAutomations(): Promise<Automation[]> {
  const res = await apiFetch(`${BASE_URL}/api/automations`);
  if (!res.ok) throw new Error(`list automations failed: ${res.status}`);
  const body = (await res.json()) as AutomationListResponse;
  return body.automations;
}

export async function createAutomation(body: CreateAutomationRequest): Promise<Automation> {
  const res = await apiFetch(`${BASE_URL}/api/automations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`create automation failed: ${res.status}`);
  return res.json();
}

export async function updateAutomation(id: string, body: UpdateAutomationRequest): Promise<Automation> {
  const res = await apiFetch(`${BASE_URL}/api/automations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`update automation failed: ${res.status}`);
  return res.json();
}

export async function deleteAutomation(id: string): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/api/automations/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`delete automation failed: ${res.status}`);
}

export async function listAutomationRuns(id: string, limit = 30): Promise<AutomationRun[]> {
  const res = await apiFetch(`${BASE_URL}/api/automations/${encodeURIComponent(id)}/runs?limit=${limit}`);
  if (!res.ok) throw new Error(`list automation runs failed: ${res.status}`);
  const body = (await res.json()) as AutomationRunListResponse;
  return body.runs;
}

export async function runAutomation(id: string): Promise<RunAutomationResponse> {
  const res = await apiFetch(`${BASE_URL}/api/automations/${encodeURIComponent(id)}/run`, { method: 'POST' });
  if (!res.ok) throw new Error(`run automation failed: ${res.status}`);
  return res.json();
}

export async function testAutomation(body: CreateAutomationRequest): Promise<TestAutomationResponse> {
  const res = await apiFetch(`${BASE_URL}/api/automations/test-run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`test automation failed: ${res.status}`);
  return res.json();
}
