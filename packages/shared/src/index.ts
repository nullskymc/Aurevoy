/**
 * Aurevoy 前后端共享类型定义。
 *
 * 这里是桌面前端 (apps/desktop) 与 Agent 引擎 (apps/agent) 之间的契约。
 * 任何跨进程传输的数据结构都应定义在此，避免类型漂移。
 */

// ============================================================
// 基础枚举
// ============================================================

/** 任务的生命周期状态 */
export type TaskStatus =
  | 'pending' // 已创建，尚未开始
  | 'planning' // Agent 正在拆解计划
  | 'running' // 执行中
  | 'paused' // 暂停（等待用户输入等）
  | 'completed' // 成功完成
  | 'failed' // 失败
  | 'cancelled'; // 被用户取消

/** Agent runtime 的细粒度执行阶段；用于诊断、回放和 UI 解释。 */
export type TaskPhase =
  | 'initializing'
  | 'thinking'
  | 'calling_tool'
  | 'waiting_approval'
  | 'finalizing'
  | 'failed'
  | 'cancelled';

/** 对话消息的角色 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

// ============================================================
// 领域模型
// ============================================================

/** assistant 消息携带的一次工具调用请求（OpenAI tool_calls 格式） */
export interface MessageToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** 入参，原始 JSON 字符串（累积完成后再 JSON.parse） */
    arguments: string;
  };
}

/** 一条对话消息 */
export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string; // ISO 8601
  /** 仅 role='assistant'：本轮模型请求的工具调用 */
  toolCalls?: MessageToolCall[];
  /** 仅 role='tool'：该结果关联的 tool_call id */
  toolCallId?: string;
  /** DeepSeek 思考模式的 reasoning_content 透传；多轮须原样回传，否则 API 报 400 */
  reasoningContent?: string;
}

/** 计划中的一个步骤 */
export interface PlanStep {
  id: string;
  description: string;
  status: TaskStatus;
}

/** 一个用户任务（Agent 的工作单元） */
export interface Task {
  id: string;
  /** 用户用自然语言表达的原始目标 */
  goal: string;
  status: TaskStatus;
  /** 当前 runtime 阶段；已结束的历史任务保留最终阶段。 */
  phase: TaskPhase | null;
  /** Agent 拆解出的计划步骤 */
  plan: PlanStep[];
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// 工具层 (为 MCP 接入预留)
// ============================================================

/**
 * 工具风险等级，决定执行前是否需要用户审批。
 * - safe: 只读/无副作用，自动放行（如读时间、列目录）
 * - caution: 有副作用或访问外部资源，执行前需用户确认（如网络抓取、读文件）
 * - dangerous: 破坏性或高风险，执行前必须用户确认（如写文件、删除）
 */
export type ToolRiskLevel = 'safe' | 'caution' | 'dangerous';

/** 任务轨迹记录类型，用于审计、诊断和回放。 */
export type TaskTraceKind =
  | 'llm'
  | 'tool_call'
  | 'tool_result'
  | 'approval'
  | 'error'
  | 'done'
  | 'phase';

/** 运行错误分类，帮助判断失败来自配置、模型、工具、权限、超时、取消或解析。 */
export type TaskErrorCategory =
  | 'configuration'
  | 'model'
  | 'tool'
  | 'permission'
  | 'timeout'
  | 'cancelled'
  | 'parse'
  | 'unknown';

/** Provider 可返回的 token 与成本信息；当前不支持时显式为 null。 */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
}

/** 一条可持久回看的任务轨迹。 */
export interface TaskTraceEntry {
  id: string;
  taskId: string;
  kind: TaskTraceKind;
  phase: TaskPhase | null;
  iteration?: number;
  callId?: string;
  toolName?: string;
  riskLevel?: ToolRiskLevel;
  provider?: string;
  model?: string;
  finishReason?: string;
  tokenUsage: TokenUsage | null;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  ok?: boolean;
  errorCategory?: TaskErrorCategory;
  errorMessage?: string;
  summary?: string;
  data?: unknown;
}

/** 工具的元信息描述 */
export interface ToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema 描述入参 */
  inputSchema: Record<string, unknown>;
  /** 风险等级；缺省视为 'safe' */
  riskLevel?: ToolRiskLevel;
}

/** 一次工具调用 */
export interface ToolCall {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
}

/** 工具调用结果 */
export interface ToolResult {
  callId: string;
  ok: boolean;
  output?: unknown;
  error?: string;
}

// ============================================================
// Agent 事件流 (通过 SSE 推送给前端)
// ============================================================

/**
 * Agent 在执行任务过程中向前端流式推送的事件。
 * 前端据此实时渲染任务进度、思考、工具调用与最终输出。
 */
export type AgentEvent =
  | { type: 'task_created'; taskId: string; task: Task }
  | { type: 'status'; taskId: string; status: TaskStatus }
  | { type: 'phase'; taskId: string; phase: TaskPhase; detail?: string }
  | { type: 'plan'; taskId: string; plan: PlanStep[] }
  | { type: 'step_update'; taskId: string; step: PlanStep }
  | { type: 'token'; taskId: string; delta: string } // LLM 流式 token
  | { type: 'message'; taskId: string; message: Message } // 一条完整消息
  | { type: 'tool_call'; taskId: string; call: ToolCall }
  | { type: 'tool_result'; taskId: string; result: ToolResult }
  | {
      type: 'approval_request';
      taskId: string;
      call: ToolCall;
      riskLevel: ToolRiskLevel;
    } // 执行非 safe 工具前请求用户确认
  | { type: 'done'; taskId: string; status: TaskStatus }
  | { type: 'error'; taskId: string; message: string };

// ============================================================
// HTTP API 请求/响应
// ============================================================

/** POST /api/tasks — 创建并启动一个任务 */
export interface CreateTaskRequest {
  goal: string;
}

export interface CreateTaskResponse {
  task: Task;
  /** SSE 事件流地址，前端用它订阅该任务的实时输出 */
  streamUrl: string;
}

/** GET /api/health */
export interface HealthResponse {
  status: 'ok';
  version: string;
  uptimeMs: number;
  /** 当前生效的 LLM Provider 名（如 'openai:gpt-4o-mini'；未配置时为 'unconfigured'） */
  provider: string;
}

/** POST /api/tasks/:id/approvals — 对一次工具调用做出审批决策 */
export interface ApprovalDecisionRequest {
  /** 关联的 tool_call id（即 approval_request 事件里的 call.id） */
  callId: string;
  /** true=批准执行，false=拒绝 */
  approved: boolean;
}

export interface ApprovalDecisionResponse {
  taskId: string;
  callId: string;
  /** 决策是否被成功投递到等待中的循环（false 表示无对应待审批项） */
  delivered: boolean;
}

/** GET /api/tasks/:id/traces — 任务轨迹回看 */
export interface TaskTraceListResponse {
  taskId: string;
  traces: TaskTraceEntry[];
}

/**
 * POST /api/tasks/:id/messages — 在同一任务内追加一轮用户输入并继续执行。
 * 后端保留该任务的完整消息历史作为上下文重新进入 Agent 循环（多轮对话）。
 */
export interface ContinueTaskRequest {
  /** 用户的后续追问/补充 */
  message: string;
}

export interface ContinueTaskResponse {
  task: Task;
  /** SSE 事件流地址；前端用它订阅这一轮的实时输出（与首轮相同地址） */
  streamUrl: string;
}

// ============================================================
// 长期记忆 (M4.3)
// ============================================================

/** 长期记忆的分类，便于用户理解与筛选。 */
export type MemoryCategory =
  | 'preference' // 用户偏好（语气、格式、语言等）
  | 'directory' // 常用目录/路径
  | 'model' // 模型偏好
  | 'habit' // 工作习惯
  | 'fact' // 关于用户的长期事实
  | 'other';

/** 记忆来源：用户手动添加，或 agent 通过 remember 工具写入。 */
export type MemoryOrigin = 'user' | 'agent';

/** 一条长期记忆的来源信息（可解释性的核心：从哪来、何时、多确信）。 */
export interface MemorySource {
  origin: MemoryOrigin;
  /** 来源任务（agent 写入时记录是哪个任务产生的记忆） */
  taskId?: string;
  /** 来源任务的目标摘要，便于用户回溯 */
  taskGoal?: string;
  createdAt: string;
}

/**
 * 一条跨会话长期记忆。
 * 必须可查看、可编辑、可删除、可禁用；每条都记录来源与置信度，不做不可见黑盒。
 */
export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  /** 记忆内容（自然语言） */
  content: string;
  /** 置信度 0~1；用户手动添加默认 1，agent 写入按其判断 */
  confidence: number;
  /** 是否启用；禁用后不注入到 Agent 上下文，但仍保留可见可恢复 */
  enabled: boolean;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/memories — 用户手动新增一条记忆 */
export interface CreateMemoryRequest {
  content: string;
  category?: MemoryCategory;
  confidence?: number;
}

/** PATCH /api/memories/:id — 编辑/启停一条记忆 */
export interface UpdateMemoryRequest {
  content?: string;
  category?: MemoryCategory;
  confidence?: number;
  enabled?: boolean;
}

/** GET /api/memories — 记忆列表 */
export interface MemoryListResponse {
  memories: MemoryEntry[];
}

// ============================================================
// 运行时常量
// ============================================================

/** Agent 引擎默认监听地址 */
export const AGENT_DEFAULT_HOST = '127.0.0.1';
export const AGENT_DEFAULT_PORT = 8787;
export const AGENT_DEFAULT_BASE_URL = `http://${AGENT_DEFAULT_HOST}:${AGENT_DEFAULT_PORT}`;
