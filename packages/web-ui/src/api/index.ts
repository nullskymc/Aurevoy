import {
  AGENT_DEFAULT_BASE_URL,
  type AgentEvent,
  type BranchTaskResponse,
  type ClarificationAnswerResponse,
  type CleanupDataResponse,
  type CompactTaskResponse,
  type ContinueTaskResponse,
  type CreateMemoryRequest,
  type CreateTaskResponse,
  type DataStatusResponse,
  type HealthResponse,
  type MemoryEntry,
  type MemoryListResponse,
  type McpStatusResponse,
  type MessageAttachment,
  type ModelListResponse,
  type OauthLoginRespondRequest,
  type OauthLoginStartRequest,
  type OauthLogoutRequest,
  type OauthSessionSnapshot,
  type ResumeTaskResponse,
  type RevertMode,
  type RevertTaskResponse,
  type SkillDescriptor,
  type SkillDetail,
  type SkillInstallResponse,
  type SkillUninstallResponse,
  type UnrevertTaskResponse,
  type RuntimeSettings,
  type Task,
  type TaskSummary,
  type TaskArtifact,
  type TaskArtifactContentResponse,
  type TokenUsageReport,
  type TaskTraceEntry,
  type TaskTraceListResponse,
  type ToolListResponse,
  type ToolDescriptor,
  type UpdateRuntimeSettingsRequest,
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

export function getBaseUrl(): string {
  return BASE_URL;
}

export function setBaseUrl(url: string): void {
  BASE_URL = url.replace(/\/+$/, '');
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(AGENT_URL_STORAGE_KEY, BASE_URL);
  }
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
  const res = await fetch(`${BASE_URL}/api/health`);
  if (!res.ok) throw new Error(`health check failed: ${res.status}`);
  return res.json();
}

export async function createTask(
  goal: string,
  projectId?: string,
  attachments?: MessageAttachment[],
  executionMode: "auto" | "plan" = "auto",
): Promise<CreateTaskResponse> {
  const res = await fetch(`${BASE_URL}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal, projectId, attachments, executionMode }),
  });
  if (!res.ok) await throwApiError(res, "create task failed");
  return res.json();
}

export async function listTasks(): Promise<TaskSummary[]> {
  const res = await fetch(`${BASE_URL}/api/tasks`);
  if (!res.ok) throw new Error(`list tasks failed: ${res.status}`);
  return res.json();
}

/** 恢复已暂停的 auto mode */
export async function resumeAutoMode(taskId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/auto-mode-resume`, { method: 'POST' });
  if (!res.ok) await throwApiError(res, "resume auto mode failed");
}

/** 读取单个任务的完整快照（含工具结果等持久化消息） */
export async function getTask(taskId: string): Promise<Task> {
  const res = await fetch(`${BASE_URL}/api/tasks/${taskId}`);
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

  const res = await fetch(`${BASE_URL}/api/workspace/read?${params.toString()}`);
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
  const res = await fetch(`${BASE_URL}/api/workspace/delete?${params.toString()}`, { method: "DELETE" });
  if (!res.ok) await throwApiError(res, "delete workspace path failed");
}

export async function renameWorkspacePath(options: {
  path: string;
  newName: string;
  taskId?: string;
  projectId?: string;
}): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/workspace/rename`, {
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
  const res = await fetch(`${BASE_URL}/api/workspace/copy`, {
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
): Promise<ContinueTaskResponse> {
  const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, attachments, executionMode }),
  });
  if (!res.ok) await throwApiError(res, "continue task failed");
  return res.json();
}

/** 恢复未完成、失败或已取消任务；后端从持久历史重新进入 Agent 循环 */
export async function resumeTask(taskId: string): Promise<ResumeTaskResponse> {
  const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/resume`, {
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
  const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/revert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId, mode }),
  });
  if (!res.ok) throw new Error(`revert task failed: ${res.status}`);
  return res.json();
}

/** 撤销上一次 revert（continue 尚未提交新消息时）；从归档恢复被截断消息 */
export async function unrevertTask(taskId: string): Promise<UnrevertTaskResponse> {
  const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/unrevert`, {
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
  const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/branch`, {
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
): Promise<CompactTaskResponse> {
  const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/compact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromMessageId, toMessageId }),
  });
  if (!res.ok) throw new Error(`compact task failed: ${res.status}`);
  return res.json();
}

export async function listTaskTraces(taskId: string): Promise<TaskTraceEntry[]> {
  const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/traces`);
  if (!res.ok) throw new Error(`list task traces failed: ${res.status}`);
  const body = (await res.json()) as TaskTraceListResponse;
  return body.traces;
}

/** 请求后端取消一个进行中的任务（中断其 LLM 流） */
export async function cancelTask(taskId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/cancel`, { method: 'POST' });
  if (!res.ok) await throwApiError(res, "cancel task failed");
}

/** 删除任务及其关联数据（轨迹、事件等） */
export async function deleteTask(taskId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/tasks/${taskId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`delete task failed: ${res.status}`);
}

/** 对一次工具调用做出审批决策（批准/拒绝） */
export async function approveToolCall(
  taskId: string,
  callId: string,
  approved: boolean,
): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/approvals`, {
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
  const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/clarifications/${clarificationId}`, {
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
  const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/artifacts/${artifactId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`update artifact failed: ${res.status}`);
  return res.json();
}

export async function getArtifactContent(taskId: string, artifactId: string): Promise<TaskArtifactContentResponse> {
  const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/artifacts/${artifactId}/content`);
  if (!res.ok) await throwApiError(res, "get artifact content failed");
  return res.json();
}

export async function listTools(): Promise<ToolDescriptor[]> {
  const res = await fetch(`${BASE_URL}/api/tools`);
  if (!res.ok) throw new Error(`list tools failed: ${res.status}`);
  const body = (await res.json()) as ToolDescriptor[] | ToolListResponse;
  return Array.isArray(body) ? body : body.tools;
}

export async function fetchSkills(): Promise<SkillDescriptor[]> {
  const res = await fetch(`${BASE_URL}/api/skills`);
  if (!res.ok) return [];
  const data = (await res.json()) as { skills: SkillDescriptor[] };
  return data.skills ?? [];
}

export async function fetchSkillDetail(name: string): Promise<SkillDetail> {
  const res = await fetch(`${BASE_URL}/api/skills/${encodeURIComponent(name)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? `fetch skill failed: ${res.status}`);
  }
  return res.json() as Promise<SkillDetail>;
}

export async function toggleSkill(name: string, enabled: boolean): Promise<SkillDescriptor> {
  const res = await fetch(`${BASE_URL}/api/skills/${encodeURIComponent(name)}`, {
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
  const res = await fetch(`${BASE_URL}/api/skills/reload`, { method: 'POST' });
  if (!res.ok) throw new Error(`reload skills failed: ${res.status}`);
  const data = (await res.json()) as { skills: SkillDescriptor[] };
  return data.skills ?? [];
}

export async function installSkill(repoUrl: string): Promise<SkillInstallResponse> {
  const res = await fetch(`${BASE_URL}/api/skills/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoUrl }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `install failed: ${res.status}`);
  }
  return res.json();
}

export async function uninstallSkill(name: string): Promise<SkillUninstallResponse> {
  const res = await fetch(`${BASE_URL}/api/skills/${encodeURIComponent(name)}`, {
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
  const res = await fetch(`${BASE_URL}/api/tools/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`update tool failed: ${res.status}`);
  return res.json();
}

export async function getSettings(): Promise<RuntimeSettings> {
  const res = await fetch(`${BASE_URL}/api/settings`);
  if (!res.ok) throw new Error(`get settings failed: ${res.status}`);
  return res.json();
}

export async function updateSettings(
  body: UpdateRuntimeSettingsRequest,
): Promise<RuntimeSettings> {
  const res = await fetch(`${BASE_URL}/api/settings`, {
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
  const res = await fetch(`${BASE_URL}/api/settings/proxy/test`, {
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
  const res = await fetch(`${BASE_URL}/api/settings/models`);
  if (!res.ok) throw new Error(`list provider models failed: ${await readErrorMessage(res)}`);
  const body = (await res.json()) as ModelListResponse;
  return body.models;
}

export async function startOauthLogin(provider: string): Promise<OauthSessionSnapshot> {
  const res = await fetch(`${BASE_URL}/api/settings/llm/oauth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider } satisfies OauthLoginStartRequest),
  });
  if (!res.ok) throw new Error(`oauth login failed: ${await readErrorMessage(res)}`);
  return res.json() as Promise<OauthSessionSnapshot>;
}

export async function getOauthSession(sessionId: string): Promise<OauthSessionSnapshot> {
  const res = await fetch(`${BASE_URL}/api/settings/llm/oauth/session/${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error(`oauth session failed: ${await readErrorMessage(res)}`);
  return res.json() as Promise<OauthSessionSnapshot>;
}

export async function respondOauthSession(sessionId: string, value: string): Promise<OauthSessionSnapshot> {
  const res = await fetch(
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
  const res = await fetch(
    `${BASE_URL}/api/settings/llm/oauth/session/${encodeURIComponent(sessionId)}/cancel`,
    { method: 'POST' },
  );
  if (!res.ok) throw new Error(`oauth cancel failed: ${await readErrorMessage(res)}`);
  return res.json() as Promise<OauthSessionSnapshot>;
}

export async function logoutOauthProvider(provider: string): Promise<RuntimeSettings> {
  const res = await fetch(`${BASE_URL}/api/settings/llm/oauth/logout`, {
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
  const res = await fetch(`${BASE_URL}/api/mcp/status`);
  if (!res.ok) throw new Error(`get mcp status failed: ${res.status}`);
  return res.json();
}

export async function getDataStatus(): Promise<DataStatusResponse> {
  const res = await fetch(`${BASE_URL}/api/data`);
  if (!res.ok) throw new Error(`get data status failed: ${res.status}`);
  return res.json();
}

export async function getTokenUsageReport(): Promise<TokenUsageReport> {
  const res = await fetch(`${BASE_URL}/api/data/token-usage`);
  if (!res.ok) throw new Error(`get token usage report failed: ${res.status}`);
  return res.json();
}

export async function cleanupData(olderThanDays?: number): Promise<CleanupDataResponse> {
  const res = await fetch(`${BASE_URL}/api/data/cleanup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(olderThanDays == null ? {} : { olderThanDays }),
  });
  if (!res.ok) throw new Error(`cleanup data failed: ${res.status}`);
  return res.json();
}

// ===== 长期记忆 (M4.3) =====

export async function listMemories(): Promise<MemoryEntry[]> {
  const res = await fetch(`${BASE_URL}/api/memories`);
  if (!res.ok) throw new Error(`list memories failed: ${res.status}`);
  const body = (await res.json()) as MemoryListResponse;
  return body.memories;
}

export async function createMemory(body: CreateMemoryRequest): Promise<MemoryEntry> {
  const res = await fetch(`${BASE_URL}/api/memories`, {
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
  const res = await fetch(`${BASE_URL}/api/memories/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`update memory failed: ${res.status}`);
  return res.json();
}

export async function deleteMemory(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/memories/${id}`, { method: 'DELETE' });
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
  const res = await fetch(`${BASE_URL}/api/knowledge-base/dirs`);
  if (!res.ok) throw new Error(`list kb dirs failed: ${res.status}`);
  const body = (await res.json()) as { dirs: KbDir[] };
  return body.dirs;
}

export async function createKbDir(dirPath: string, recursive?: boolean): Promise<KbDir> {
  const res = await fetch(`${BASE_URL}/api/knowledge-base/dirs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dirPath, recursive }),
  });
  if (!res.ok) throw new Error(`create kb dir failed: ${res.status}`);
  return res.json();
}

export async function deleteKbDir(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/knowledge-base/dirs/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`delete kb dir failed: ${res.status}`);
}

export async function getKbStatus(): Promise<KbIndexStatus> {
  const res = await fetch(`${BASE_URL}/api/knowledge-base/status`);
  if (!res.ok) throw new Error(`get kb status failed: ${res.status}`);
  return res.json();
}

// ===== 项目 (Projects) =====

export async function listProjects(): Promise<Project[]> {
  const res = await fetch(`${BASE_URL}/api/projects`);
  if (!res.ok) throw new Error(`list projects failed: ${res.status}`);
  const body = (await res.json()) as ProjectListResponse;
  return body.projects;
}

export async function createProject(body: CreateProjectRequest): Promise<Project> {
  const res = await fetch(`${BASE_URL}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`create project failed: ${res.status}`);
  return res.json();
}

export async function updateProject(id: string, body: UpdateProjectRequest): Promise<Project> {
  const res = await fetch(`${BASE_URL}/api/projects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`update project failed: ${res.status}`);
  return res.json();
}

export async function deleteProject(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/projects/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`delete project failed: ${res.status}`);
}

/** 审批 Plan Agent 生成的执行计划 */
export async function approvePlan(
  taskId: string,
  approved: boolean,
  reason?: string,
): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/plan-approval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approved, reason }),
  });
  if (!res.ok) await throwApiError(res, "plan approval failed");
}

/**
 * 订阅某个任务的 SSE 事件流。
 * 返回一个 EventSource，调用方可在不需要时 close()。
 */
export function streamTask(
  taskId: string,
  onEvent: (event: AgentEvent) => void,
  onError?: (err: Event) => void,
): EventSource {
  const es = new EventSource(`${BASE_URL}/api/tasks/${taskId}/stream`);
  es.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data) as AgentEvent);
    } catch {
      // 忽略心跳/非 JSON 行
    }
  };
  es.onerror = (e) => {
    onError?.(e);
  };
  return es;
}
