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
  | 'planning'
  | 'thinking'
  | 'calling_tool'
  | 'waiting_approval'
  | 'waiting_clarification'
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

/** 用户附加到消息的文件引用。Agent 运行在本机，通过路径直接读取文件内容。 */
export interface MessageAttachment {
  id: string;
  /** 文件名（含扩展名） */
  name: string;
  /** 本地文件绝对路径 */
  path: string;
  /** MIME 类型，如 text/typescript、image/png */
  mimeType: string;
  /** 文件大小（字节） */
  size: number;
  /** 附件类型；为图片等后续扩展预留 */
  type: 'file' | 'image';
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
  /** 用户消息携带的文件附件（路径引用）；Agent 据此注入文件上下文 */
  attachments?: MessageAttachment[];
}

/** 计划中的一个步骤 */
export interface PlanStep {
  id: string;
  description: string;
  status: TaskStatus;
  /** 该步骤预期使用的工具名称 */
  toolsExpected?: string[];
  /** 依赖的前置步骤 ID 列表 */
  dependsOn?: string[];
  /** 该步骤完成后是否有可验证的产出物 */
  verifiable?: boolean;
  /** 步骤来源：llm（由 LLM 生成）| heuristic（正则兜底）| resume（从 checkpoint 恢复） */
  source?: 'llm' | 'heuristic' | 'resume';
}

/** 侦查阶段产出：工作区关键信息摘要（P1 重构） */
export interface ScoutReport {
  /** 关键文件列表及其重要性说明 */
  keyFiles: Array<{ path: string; reason: string }>;
  /** 识别到的技术栈关键词 */
  techStack?: string[];
  /** 需要注意的约束与边界条件 */
  constraints: string[];
  /** 自然语言摘要 */
  summary: string;
  /** 侦查耗时（毫秒） */
  durationMs: number;
  /** 侦查使用的 LLM 轮次 */
  rounds: number;
}

/** LLM 生成的结构化计划（P1 重构） */
export interface GeneratedPlan {
  steps: Array<{
    description: string;
    toolsExpected?: string[];
    verifiable?: boolean;
    dependsOn?: string[];
  }>;
  /** 预估需要的 LLM 轮次 */
  estimatedIterations: number;
  /** 任务整体风险等级 */
  riskLevel: 'low' | 'medium' | 'high';
}

export type TaskArtifactType = 'text' | 'file' | 'diff' | 'url';
export type TaskArtifactStatus = 'draft' | 'confirmed' | 'applied' | 'rejected';

/** Agent 交付给用户确认、预览或落盘的任务产物。 */
export interface TaskArtifact {
  id: string;
  type: TaskArtifactType;
  name: string;
  content: string;
  mimeType?: string;
  sourceCallId?: string;
  status: TaskArtifactStatus;
  createdAt: string;
  appliedAt?: string;
  appliedPath?: string;
}

export type ClarificationStatus = 'pending' | 'answered' | 'timeout' | 'cancelled';

/** Agent 在信息不足时暂停任务并等待用户补充的结构化追问。 */
export interface ClarificationRequest {
  id: string;
  question: string;
  options?: string[];
  context?: string;
  callId: string;
  status: ClarificationStatus;
  answer?: string;
  createdAt: string;
  answeredAt?: string;
}

/** 单个任务的硬预算，超限后 runtime 必须可解释地暂停或失败。 */
export interface TaskBudget {
  maxIterations?: number;
  maxToolCalls?: number;
  maxWallTimeMs?: number;
  maxOutputBytes?: number;
}

/** 当前任务已经消耗的预算计数。 */
export interface BudgetUsage {
  iterations: number;
  toolCalls: number;
  wallTimeMs: number;
  outputBytes: number;
}

/** 任务级 token 汇总；不支持 usage 的 Provider 保持字段缺省而不是伪造。 */
export interface AggregatedTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  available: boolean;
  provider?: string;
  model?: string;
  updatedAt?: string;
}

export interface TaskCheckpoint {
  id: string;
  label: string;
  createdAt: string;
  stepId?: string;
  message?: string;
  data?: unknown;
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
  budget?: TaskBudget;
  budgetUsage?: BudgetUsage;
  artifacts?: TaskArtifact[];
  clarifications?: ClarificationRequest[];
  checkpoints?: TaskCheckpoint[];
  tokenUsage?: AggregatedTokenUsage;
  /** 最近一次 revert 归档的消息（Phase 2 unrevert 钩子） */
  archivedMessages?: Message[];
  /** 分支来源的父任务 ID（branch 功能） */
  parentTaskId?: string;
  /** 所属项目 ID（缺省为独立对话） */
  projectId?: string;
  /** P6: 文件快照列表（用于 Rewind 回滚文件）。 */
  fileSnapshots?: FileSnapshot[];
  /** Skill: 当前激活的 skill 名称列表（通常最多 1 个）。 */
  activeSkills?: string[];
  createdAt: string;
  updatedAt: string;
}

/** 一个项目（导入的文件夹） */
export interface Project {
  id: string;
  name: string;
  /** 绝对路径 */
  path: string;
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

/** 工具并行执行策略（P2 重构）。未声明时默认允许并行。 */
export interface ToolExecutionPolicy {
  /** 是否可以和其他 safe 工具在同一批次内并行执行。默认 true。 */
  parallelizable?: boolean;
  /** 同一轮内该工具必须在哪些工具之后执行（工具名列表）。 */
  waitsFor?: string[];
}

/** 工具的元信息描述 */
export interface ToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema 描述入参 */
  inputSchema: Record<string, unknown>;
  /** 风险等级；缺省视为 'safe' */
  riskLevel?: ToolRiskLevel;
  /** 当前是否启用；禁用工具不会提供给模型，也不能被执行。 */
  enabled?: boolean;
  /** 工具来源，用于工具管理与 MCP 诊断。 */
  source?: ToolSource;
  /** 并行执行策略（P2）。缺省允许并行。 */
  executionPolicy?: ToolExecutionPolicy;
  /** P6: 失败时给 LLM 的替代方案建议。 */
  fallback?: {
    /** 推荐的替代工具列表 */
    tools?: string[];
    /** 给 LLM 的具体建议 */
    message?: string;
  };
}

/** P6: 文件快照记录（用于 Rewind 回滚文件）。 */
export interface FileSnapshot {
  id: string;
  /** 相对工作区的文件路径 */
  path: string;
  /** 关联的 tool_call id */
  callId: string;
  createdAt: string;
}

export type ToolSource =
  | { type: 'builtin' }
  | { type: 'mcp'; serverName: string; originalName: string };

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
  | {
      type: 'clarification_request';
      taskId: string;
      clarification: ClarificationRequest;
    }
  | {
      type: 'clarification_resolved';
      taskId: string;
      clarification: ClarificationRequest;
    }
  | { type: 'artifact_created'; taskId: string; artifact: TaskArtifact }
  | { type: 'artifact_updated'; taskId: string; artifact: TaskArtifact }
  | { type: 'checkpoint_created'; taskId: string; checkpoint: TaskCheckpoint }
  | { type: 'budget_usage'; taskId: string; usage: BudgetUsage; budget?: TaskBudget }
  | { type: 'token_usage'; taskId: string; usage: AggregatedTokenUsage }
  | {
      type: 'reverted';
      taskId: string;
      messageId: string;
      removedCount: number;
      archivedCount: number;
    }
  | {
      type: 'unreverted';
      taskId: string;
      restoredCount: number;
    }
  | {
      type: 'branched';
      taskId: string;
      parentTaskId: string;
      messageId: string;
      messageCount: number;
    }
  | {
      type: 'compacted';
      taskId: string;
      originalCount: number;
      summaryLength: number;
    }
  | { type: 'scout_started'; taskId: string }
  | { type: 'scout_report'; taskId: string; report: ScoutReport }
  | { type: 'plan_generated'; taskId: string; plan: PlanStep[]; source: 'llm' | 'heuristic' }
  | { type: 'skill_activated'; taskId: string; skillName: string; allowedTools?: string[] }
  | { type: 'skill_deactivated'; taskId: string }
  | { type: 'done'; taskId: string; status: TaskStatus }
  | { type: 'error'; taskId: string; message: string }
  | { type: 'task_deleted'; taskId: string };

// ============================================================
// HTTP API 请求/响应
// ============================================================

/** POST /api/tasks — 创建并启动一个任务 */
export interface CreateTaskRequest {
  goal: string;
  budget?: TaskBudget;
  projectId?: string;
  attachments?: MessageAttachment[];
}

export interface CreateTaskResponse {
  task: Task;
  /** SSE 事件流地址，前端用它订阅该任务的实时输出 */
  streamUrl: string;
}

/** POST /api/projects — 导入文件夹创建项目 */
export interface CreateProjectRequest {
  /** 项目名称；缺省取目录 basename */
  name?: string;
  /** 文件夹绝对路径 */
  path: string;
}

/** PATCH /api/projects/:id — 更新项目 */
export interface UpdateProjectRequest {
  name?: string;
}

/** GET /api/projects */
export interface ProjectListResponse {
  projects: Project[];
}

/** GET /api/health */
export interface HealthResponse {
  status: 'ok';
  version: string;
  uptimeMs: number;
  /** 当前生效的 LLM Provider 名（如 'openai:gpt-4o-mini'；未配置时为 'unconfigured'） */
  provider: string;
  /** Agent 上下文字符预算（用于前端展示当前上下文使用率） */
  contextCharBudget?: number;
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

/** POST /api/tasks/:id/clarifications/:clarificationId — 回复一次 Agent 追问 */
export interface ClarificationAnswerRequest {
  answer: string;
}

export interface ClarificationAnswerResponse {
  taskId: string;
  clarificationId: string;
  delivered: boolean;
}

/** GET /api/tasks/:id/artifacts */
export interface TaskArtifactListResponse {
  taskId: string;
  artifacts: TaskArtifact[];
}

/** GET /api/tasks/:id/artifacts/:artifactId/content */
export interface TaskArtifactContentResponse {
  taskId: string;
  artifactId: string;
  content: string;
  mimeType?: string;
}

/** PATCH /api/tasks/:id/artifacts/:artifactId */
export interface UpdateTaskArtifactRequest {
  status?: Extract<TaskArtifactStatus, 'confirmed' | 'rejected'>;
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
  attachments?: MessageAttachment[];
}

export interface ContinueTaskResponse {
  task: Task;
  /** SSE 事件流地址；前端用它订阅这一轮的实时输出（与首轮相同地址） */
  streamUrl: string;
}

/**
 * POST /api/tasks/:id/resume — 恢复一个未完成、失败或已取消任务。
 *
 * 后端会先把重启/取消/失败造成的悬空工具调用补成可解释工具结果，
 * 再用该任务的真实历史重新进入 Agent 循环。
 */
export interface ResumeTaskResponse {
  task: Task;
  streamUrl: string;
}

/** 编辑重跑的恢复模式。 */
export type RevertMode =
  | 'code_and_conv' // 截断对话 + 清除 checkpoint/artifact/plan
  | 'conv_only'; // 仅截断对话，保留 plan/checkpoint/artifact（文件改动没问题，只想重新推理）

/**
 * POST /api/tasks/:id/revert — 编辑重跑（Claude Code Rewind，Phase 1：对话截断语义）。
 *
 * 把 messageId 及其之后的所有消息从活跃历史移除，任务回到该消息发送前的状态。
 * 不回滚已落盘文件。返回被移除首条消息内容，供前端回填编辑框；随后前端再调用
 * continue 端点把编辑后的文本作为该点的新输入，带上下文重新生成。
 */
export interface RevertTaskRequest {
  /** 要截断到的目标消息 id（该消息及其之后都会被移除） */
  messageId: string;
  /** 恢复模式；Phase 1 仅支持 'code_and_conv' */
  mode?: RevertMode;
}

export interface RevertTaskResponse {
  task: Task;
  /** 被移除的目标消息内容（user 消息时有值），供前端回填编辑框 */
  removedContent: string | null;
  /** 被移除的目标消息 id */
  removedMessageId: string | null;
  /** 被移除的消息总数（含目标消息及其之后的所有消息） */
  removedCount: number;
}

/**
 * POST /api/tasks/:id/unrevert — 撤销上一次 revert。
 *
 * 从 archivedMessages 恢复被截断的消息到活跃历史。
 * 仅在没有新的 continue 操作时可用（即 revert 后尚未提交编辑）。
 */
export interface UnrevertTaskResponse {
  task: Task;
  /** 恢复的消息数量 */
  restoredCount: number;
}

/**
 * POST /api/tasks/:id/branch — 从指定消息处分支出一个新任务。
 *
 * 克隆父任务到目标消息（含）为止的所有消息，生成全新 task ID，
 * 新任务独立演进，原任务不受影响。
 */
export interface BranchTaskRequest {
  /** 分支点的消息 id（该消息包含在新任务中） */
  messageId: string;
  /** 可选的新目标描述；缺省沿用父任务 goal */
  goal?: string;
}

export interface BranchTaskResponse {
  task: Task;
  streamUrl: string;
}

/**
 * POST /api/tasks/:id/compact — 将指定消息范围压缩为 LLM 生成的摘要。
 *
 * 替换原消息为一条 system 摘要消息，释放上下文窗口空间。
 * 不截断对话，仅压缩旧消息。
 */
export interface CompactTaskRequest {
  /** 压缩起始消息 id（含）；缺省则从第一条消息开始 */
  fromMessageId?: string;
  /** 压缩结束消息 id（含）；缺省则到最后一条消息 */
  toMessageId?: string;
}

export interface CompactTaskResponse {
  task: Task;
  /** 被压缩的原始消息数 */
  originalCount: number;
  /** 生成的摘要字符数 */
  summaryLength: number;
}

/** DELETE /api/tasks/:id — 删除任务及其关联数据 */
export interface DeleteTaskResponse {
  taskId: string;
  deleted: boolean;
}

// ============================================================
// Skill (技能模块)
// ============================================================

/** GET /api/skills */
export interface SkillListResponse {
  skills: SkillDescriptor[];
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
  /** P5: URL slug，用于 [[link]] 引用 */
  nameSlug?: string;
  /** P5: 为什么记录这条记忆 */
  why?: string;
  /** P5: 什么情况下应该使用这条记忆 */
  howToApply?: string;
  /** P5: 关联的记忆 ID 列表 */
  linkedMemoryIds?: string[];
}

/** Skill: 暴露给前端的 skill 摘要（不含 body）。 */
export interface SkillDescriptor {
  name: string;
  description: string;
  allowedTools?: string[];
  version?: string;
  sourceDir: 'builtin' | 'user' | 'workspace';
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
// M5 设置、工具管理与数据管理
// ============================================================

export interface RuntimeSettings {
  llm: {
    provider: 'openai';
    baseUrl: string;
    model: string;
    /** 最近一次手动从当前 Provider 获取到的完整模型列表。 */
    availableModels: string[];
    /** 用户勾选后允许出现在主界面模型菜单中的模型列表。 */
    enabledModels: string[];
    temperature: number;
    timeoutMs: number;
    apiKeyConfigured: boolean;
  };
  workspaceDir: string;
  commandExecutionEnabled: boolean;
  /** 自动批准的工具名列表 —— 开启后跳过审批直接执行 */
  autoApprovedTools: string[];
  mcpServersJson: string;
  cleanupPolicyDays: number;
  dbPath: string;
}

export interface UpdateRuntimeSettingsRequest {
  llm?: Partial<{
    provider: 'openai';
    baseUrl: string;
    model: string;
    availableModels: string[];
    enabledModels: string[];
    temperature: number;
    timeoutMs: number;
    /** 写入新 Key；留空字段表示不修改，空字符串表示清除。响应永不回显。 */
    apiKey: string;
  }>;
  workspaceDir?: string;
  commandExecutionEnabled?: boolean;
  autoApprovedTools?: string[];
  mcpServersJson?: string;
  cleanupPolicyDays?: number;
}

export interface ModelListResponse {
  models: string[];
}

export interface ToolListResponse {
  tools: ToolDescriptor[];
}

export interface UpdateToolRequest {
  enabled: boolean;
}

export interface McpServerStatus {
  name: string;
  enabled: boolean;
  connected: boolean;
  registeredTools: number;
  error?: string;
}

export interface McpStatusResponse {
  servers: McpServerStatus[];
}

export interface DataStatusResponse {
  dbPath: string;
  workspaceDir: string;
  cleanupPolicyDays: number;
  counts: {
    tasks: number;
    traces: number;
    memories: number;
    projects: number;
  };
}

export interface CleanupDataRequest {
  /** 清理多少天以前的终态任务；不填则使用当前设置里的 cleanupPolicyDays。 */
  olderThanDays?: number;
}

export interface CleanupDataResponse {
  deletedTasks: number;
  deletedTraces: number;
}

// ============================================================
// 运行时常量
// ============================================================

/** Agent 引擎默认监听地址 */
export const AGENT_DEFAULT_HOST = '127.0.0.1';
export const AGENT_DEFAULT_PORT = 8787;
export const AGENT_DEFAULT_BASE_URL = `http://${AGENT_DEFAULT_HOST}:${AGENT_DEFAULT_PORT}`;
