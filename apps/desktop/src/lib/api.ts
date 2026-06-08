import {
  AGENT_DEFAULT_BASE_URL,
  type AgentEvent,
  type CleanupDataResponse,
  type ContinueTaskResponse,
  type CreateMemoryRequest,
  type CreateTaskResponse,
  type DataStatusResponse,
  type HealthResponse,
  type MemoryEntry,
  type MemoryListResponse,
  type McpStatusResponse,
  type ResumeTaskResponse,
  type RuntimeSettings,
  type Task,
  type TaskTraceEntry,
  type TaskTraceListResponse,
  type ToolListResponse,
  type ToolDescriptor,
  type UpdateRuntimeSettingsRequest,
  type UpdateToolRequest,
  type UpdateMemoryRequest,
} from '@aurevoy/shared';

/** Agent 引擎地址（可通过 Vite 环境变量覆盖） */
const BASE_URL =
  (import.meta.env.VITE_AGENT_BASE_URL as string | undefined) ??
  AGENT_DEFAULT_BASE_URL;

export async function checkHealth(): Promise<HealthResponse> {
  const res = await fetch(`${BASE_URL}/api/health`);
  if (!res.ok) throw new Error(`health check failed: ${res.status}`);
  return res.json();
}

export async function createTask(goal: string): Promise<CreateTaskResponse> {
  const res = await fetch(`${BASE_URL}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal }),
  });
  if (!res.ok) throw new Error(`create task failed: ${res.status}`);
  return res.json();
}

export async function listTasks(): Promise<Task[]> {
  const res = await fetch(`${BASE_URL}/api/tasks`);
  if (!res.ok) throw new Error(`list tasks failed: ${res.status}`);
  return res.json();
}

/** 读取单个任务的完整快照（含工具结果等持久化消息） */
export async function getTask(taskId: string): Promise<Task> {
  const res = await fetch(`${BASE_URL}/api/tasks/${taskId}`);
  if (!res.ok) throw new Error(`get task failed: ${res.status}`);
  return res.json();
}

/** 在同一任务内追加一轮用户输入并继续执行（多轮对话） */
export async function continueTask(
  taskId: string,
  message: string,
): Promise<ContinueTaskResponse> {
  const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`continue task failed: ${res.status}`);
  return res.json();
}

/** 恢复未完成、失败或已取消任务；后端从持久历史重新进入 Agent 循环 */
export async function resumeTask(taskId: string): Promise<ResumeTaskResponse> {
  const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/resume`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`resume task failed: ${res.status}`);
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
  if (!res.ok) throw new Error(`cancel task failed: ${res.status}`);
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
  if (!res.ok) throw new Error(`approve tool call failed: ${res.status}`);
}

export async function listTools(): Promise<ToolDescriptor[]> {
  const res = await fetch(`${BASE_URL}/api/tools`);
  if (!res.ok) throw new Error(`list tools failed: ${res.status}`);
  const body = (await res.json()) as ToolDescriptor[] | ToolListResponse;
  return Array.isArray(body) ? body : body.tools;
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
  if (!res.ok) throw new Error(`update settings failed: ${res.status}`);
  return res.json();
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
