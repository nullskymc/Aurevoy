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
  /** 本轮或任务寿命预算触顶，等待用户续跑 / 扩容。 */
  | 'waiting_budget'
  /** Agent 已停止，但完成门禁未确认原始目标已经满足；允许用户续跑。 */
  | 'waiting_completion'
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
  /** true 表示工具由 Provider 托管执行，不能在恢复上下文时交给本地执行器重放。 */
  providerExecuted?: boolean;
  function: {
    /** 该工具调用关联的计划步骤 ID；前端 timeline 按此分组 */
    planStepId?: string;
    /** 后端生成的人类可读调用摘要；前端优先展示，避免按参数结构猜测 */
    summary?: string;
    name: string;
    /** 入参，原始 JSON 字符串（累积完成后再 JSON.parse） */
    arguments: string;
  };
}

/** 用户附加到消息的文件引用。图片会先上传到引擎，再以引擎管理的路径持久化。 */
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
  /**
   * 仅图片上传请求使用的 data URL；引擎落盘后会移除此字段，避免图片内容写进任务 JSON。
   * 支持 image/png、image/jpeg、image/gif、image/webp。
   */
  dataUrl?: string;
}

/** 对话消息内联图片。它是消息内容，不是工作区文件，也不会授予工具读取路径。 */
export interface MessageImagePart {
  id: string;
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  size: number;
  /** 已校验的 data URL；对话渲染与模型视觉输入共享这一份内容。 */
  dataUrl: string;
}

/** Agent 主动发送到对话框的富内容块类型 */
export type ContentBlockType = 'file_reference' | 'image' | 'link' | 'ui';

/** 对话内 UI 仅支持隔离 canvas，避免 Agent 接触宿主 DOM 或应用 API。 */
export type UiComponentKind = 'canvas';

/** sandbox canvas 的受控输入；HTML/CSS/JS 都只在 iframe 内运行。 */
export interface UiCanvasProps {
  title?: string;
  description?: string;
  /** 初始状态由 Agent 提供，脚本可通过 window.aurevoy.state 读取。 */
  state?: Record<string, string | number | boolean | null>;
  /** iframe body 的 HTML 片段。 */
  html: string;
  /** 仅限内联样式。 */
  css?: string;
  /** 仅限 iframe 内执行的交互脚本；静态片段可省略。 */
  script?: string;
}

/** Agent 主动附加到消息的富内容块，可嵌入对话中呈现为文件、图片、链接或隔离 UI。 */
export interface ContentBlock {
  id: string;
  type: ContentBlockType;
  /** file_reference / image / link: 路径或 URL；ui: 纯文本降级摘要。 */
  content: string;
  /** 显示名称（可选） */
  name?: string;
  mimeType?: string;
  size?: number;
  /** type=ui 时的渲染类型和受控属性。 */
  kind?: UiComponentKind;
  props?: UiCanvasProps;
  fallbackText?: string;
}

/** 一条对话消息 */
export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string; // ISO 8601
  /** 仅 role='assistant'：Runtime 生成的结构化失败说明，不应当作为 LLM 正文渲染。 */
  failure?: {
    message: string;
    category: TaskErrorCategory;
  };
  /** 仅 role='assistant'：本轮模型请求的工具调用 */
  toolCalls?: MessageToolCall[];
  /** 仅 role='tool'：该结果关联的 tool_call id */
  toolCallId?: string;
  /** Provider 托管工具的调用/结果记录；用于历史渲染并阻止本地重复执行。 */
  providerExecuted?: boolean;
  /** 用户消息携带的文件附件（路径引用）；Agent 据此注入文件上下文 */
  attachments?: MessageAttachment[];
  /** 用户消息中的图片内容块；不可作为文件工具的输入路径。 */
  imageParts?: MessageImagePart[];
  /** 运行中追加用户消息时的 Pi 队列投递方式。首轮/非运行中消息为空。 */
  delivery?: 'steering' | 'follow_up';
  /** Agent 主动附加的富内容块（文件/图片/链接/UI），由交付工具生成 */
  contentBlocks?: ContentBlock[];
}

/** 计划中的一个步骤 */
export type PlanStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused'
  | 'proposed'
  /** Blocked on external/user input; remains incomplete until unblocked or cancelled */
  | 'blocked';

export interface PlanStep {
  id: string;
  description: string;
  status: PlanStepStatus;
  /** 该步骤预期使用的工具名称 */
  toolsExpected?: string[];
  /** 依赖的前置步骤 ID 列表 */
  dependsOn?: string[];
  /** 该步骤完成后是否有可验证的产出物 */
  verifiable?: boolean;
  /** 步骤来源：llm（由 LLM 生成）| heuristic（正则兜底）| resume（从 checkpoint 恢复） */
  source?: 'llm' | 'heuristic' | 'resume';
  /** Optional blocker detail when status is blocked/paused */
  blockedReason?: string;
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

/**
 * 执行预算上限（run 级或 lifetime 级共用同一形状）。
 * - run：单次 harness 执行（用户发言 / resume 开启的一轮工作）
 * - lifetime：任务全生命周期累计（跨续聊与多次 resume）
 * 触顶后 runtime 可解释地暂停（waiting_budget），而非直接失败。
 */
export interface TaskBudget {
  maxIterations?: number;
  maxToolCalls?: number;
  maxWallTimeMs?: number;
  maxOutputBytes?: number;
}

/** 预算消耗计数；run 与 lifetime 各持一份。 */
export interface BudgetUsage {
  iterations: number;
  toolCalls: number;
  wallTimeMs: number;
  outputBytes: number;
}

/** 预算作用域：本轮执行 vs 任务寿命。 */
export type BudgetScope = 'run' | 'lifetime';

/** 预算维度名称（与 TaskBudget / BudgetUsage 字段对应）。 */
export type BudgetLimitName = keyof Required<TaskBudget>;

/** 预算触顶详情，供 SSE / 轨迹 / UI 续跑使用。 */
export interface BudgetExceededInfo {
  scope: BudgetScope;
  limitName: BudgetLimitName;
  used: number;
  limit: number;
  reason: string;
  runUsage: BudgetUsage;
  lifetimeUsage: BudgetUsage;
  runBudget: Required<TaskBudget>;
  lifetimeBudget: Required<TaskBudget>;
}

/** 任务级 token 汇总；不支持 usage 的 Provider 保持字段缺省而不是伪造。 */
export interface AggregatedTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** 推理/思考 token 数；它通常已包含在 completionTokens 中。 */
  reasoningTokens?: number;
  /** 命中 prompt cache 的 token 数。 */
  cacheReadTokens?: number;
  /** 写入 prompt cache 的 token 数。 */
  cacheWriteTokens?: number;
  estimatedCostUsd?: number;
  available: boolean;
  provider?: string;
  model?: string;
  updatedAt?: string;
}

/** 全库任务 token 使用汇总报告（用于设置页成本管理）。 */
export interface TokenUsageReportBreakdown {
  provider: string;
  model: string;
  tasks: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  updatedAt?: string;
}

/**
 * 按本地日历日的用量点。
 * 每个有 usage 的任务整段归入「最近一次 usage 更新日」
 * （回退 task.updatedAt / createdAt），跨日任务不会拆分。
 */
export interface TokenUsageDailyPoint {
  /** 本地日历日 YYYY-MM-DD */
  date: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  /** 归入该日的可计量任务数 */
  tasks: number;
}

export interface TokenUsageReport {
  /** 本地记录的任务总数。 */
  tasks: number;
  /** 返回过 usage 并参与汇总的任务数量。 */
  measuredTasks: number;
  /** 是否有任一任务返回过 usage。 */
  available: boolean;
  /** 输入 token 总计。 */
  promptTokens: number;
  /** 输出 token 总计。 */
  completionTokens: number;
  /** token 总计。 */
  totalTokens: number;
  /** 推理/思考 token 总计；它通常已包含在输出 token 中。 */
  reasoningTokens: number;
  /** 命中 prompt cache 的 token 总计。 */
  cacheReadTokens: number;
  /** 写入 prompt cache 的 token 总计。 */
  cacheWriteTokens: number;
  /** 估算成本（USD）总计。 */
  estimatedCostUsd: number;
  /** 按 provider/model 聚合的明细。 */
  breakdown: TokenUsageReportBreakdown[];
  /**
   * 近 N 日本地日历日活跃序列（含 0 日，按日期升序）。
   * 由任务级 usage 时间戳推导，不是 provider 账单日汇总。
   */
  daily: TokenUsageDailyPoint[];
  /** daily 窗口内峰值日；窗口全 0 时为 null。 */
  peakDay: { date: string; totalTokens: number } | null;
}

export interface TaskCheckpoint {
  id: string;
  label: string;
  createdAt: string;
  stepId?: string;
  message?: string;
  data?: unknown;
}

export interface PendingToolApproval {
  call: ToolCall;
  riskLevel: ToolRiskLevel;
  createdAt: string;
  /** auto mode 语境下需要审批的原因 */
  autoModeReason?: 'blocked_by_rule' | 'not_covered' | 'paused';
}

/** 内置子代理角色。角色只决定任务面，权限始终继承父任务。 */
export type SubagentRole = 'explore' | 'research' | 'coder' | 'shell' | 'writer' | 'general';

export type SubagentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** 子代理终止原因。独立预算会产生 timeout / max_iterations。 */
export type SubagentStopReason = 'completed' | 'error' | 'timeout' | 'cancelled' | 'max_iterations';

/** 子代理内部工具活动；只持久化用户可解释的元数据，不复制大段工具输出。 */
export interface SubagentActivity {
  id: string;
  toolName: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
}

/** 与父 delegate call 关联的子代理运行快照，供 SSE、历史回放和前端工作组使用。 */
export interface SubagentRun {
  id: string;
  parentCallId: string;
  role: SubagentRole;
  goal: string;
  status: SubagentRunStatus;
  currentActivity?: string;
  activities: SubagentActivity[];
  iterations: number;
  toolCallCount: number;
  maxIterations?: number;
  maxWallMs?: number;
  /** 子代理累计 token（provider 未返回 usage 时缺省）。 */
  tokenUsage?: number;
  stopReason?: SubagentStopReason;
  result?: string;
  error?: string;
  truncated?: boolean;
  durationMs?: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

/**
 * 侧栏/列表用的会话显示标题最大长度（字符）。
 * 对齐 Pi 会话名提案量级（~60–70），防止超长 goal 撑开布局。
 */
export const TASK_TITLE_MAX_LENGTH = 64;

/** 标题来源：截断 goal / 首轮后 LLM 精炼 */
export type TaskTitleSource = 'truncated' | 'llm';

/**
 * 生成侧栏可用的短标题：去换行、压空白、按 maxLength 截断并加省略号。
 * 对齐 Pi `appendSessionName` 的换行清洗语义，并补上 max length。
 */
export function formatTaskTitle(text: string, maxLength = TASK_TITLE_MAX_LENGTH): string {
  const cleaned = text.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'New chat';
  if ([...cleaned].length <= maxLength) return cleaned;
  const chars = [...cleaned];
  return `${chars.slice(0, Math.max(1, maxLength - 1)).join('')}…`;
}

/** 列表展示用标题：优先 title，否则从 goal 截断 */
export function taskDisplayTitle(task: Pick<Task, 'title' | 'goal'>): string {
  const titled = task.title?.trim();
  if (titled) return titled.length <= TASK_TITLE_MAX_LENGTH ? titled : formatTaskTitle(titled);
  return formatTaskTitle(task.goal);
}

/**
 * 任务级模型快照。创建任务时固化（或运行中显式切换时更新），
 * resume / 续跑据此恢复原模型，避免全局设置变更静默替换既有对话的模型。
 */
export interface TaskModelSnapshot {
  provider: string;
  model: string;
  thinkingLevel: AgentThinkingLevel;
}

/** 一个用户任务（Agent 的工作单元） */
export interface Task {
  id: string;
  /** 用户用自然语言表达的原始目标 */
  goal: string;
  /**
   * 侧栏/列表显示名（短标题）。
   * goal 始终保留完整用户输入；title 可被截断或 LLM 精炼覆盖。
   */
  title: string;
  /** title 如何产生；缺省视为 truncated */
  titleSource?: TaskTitleSource;
  status: TaskStatus;
  /** 当前 runtime 阶段；已结束的历史任务保留最终阶段。 */
  phase: TaskPhase | null;
  /** Agent 拆解出的计划步骤 */
  plan: PlanStep[];
  messages: Message[];
  /**
   * 单次 harness 执行预算（创建时快照；未设字段由引擎默认补齐）。
   * 每次 run 开始时 budgetUsage 清零，不跨续聊累计。
   */
  budget?: TaskBudget;
  /** 当前这一次 harness 执行已消耗的预算。 */
  budgetUsage?: BudgetUsage;
  /**
   * 任务寿命预算（创建时快照）。跨 resume / 续聊累计，
   * 防止无限续跑；触顶后需扩容再继续。
   */
  lifetimeBudget?: TaskBudget;
  /** 任务全生命周期累计预算消耗。 */
  lifetimeUsage?: BudgetUsage;
  /** 最近一次预算触顶详情；续跑成功后清除。 */
  budgetExceeded?: BudgetExceededInfo;
  artifacts?: TaskArtifact[];
  clarifications?: ClarificationRequest[];
  pendingApprovals?: PendingToolApproval[];
  checkpoints?: TaskCheckpoint[];
  tokenUsage?: AggregatedTokenUsage;
  /** 当前上下文窗口估算 token 数（后端 estimateTokens 计算） */
  contextTokens?: number;
  /** 任务级模型快照：resume / 续跑恢复该任务原模型；缺省表示跟随全局当前模型。 */
  modelSnapshot?: TaskModelSnapshot;
  /** 最近一次 revert 归档的消息（Phase 2 unrevert 钩子） */
  archivedMessages?: Message[];
  /** 分支来源的父任务 ID（branch 功能） */
  parentTaskId?: string;
  /** 所属项目 ID（缺省为独立对话） */
  projectId?: string;
  /** 自动模式运行时统计与状态 */
  autoModeState?: AutoModeState;
  /** 当前会话执行模式；plan 只读，用户可在输入框切换为 auto 后继续同一任务。 */
  executionMode?: AgentExecutionMode;
  /** 子代理运行历史；通过 parentCallId 关联到触发它的 assistant 消息。 */
  subagentRuns?: SubagentRun[];
  /** 引擎重启后被自动恢复续跑（对齐 pi -r）；任务正常结束或用户手动 resume 后清除。 */
  resumedAfterRestart?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 列表、搜索和托盘使用的轻量任务摘要，不携带消息、计划或运行细节。 */
export interface TaskSummary {
  id: string;
  goal: string;
  title: string;
  titleSource?: TaskTitleSource;
  status: TaskStatus;
  projectId?: string;
  createdAt: string;
  updatedAt: string;
}

export function taskSummaryFromTask(task: Task): TaskSummary {
  return {
    id: task.id,
    goal: task.goal,
    title: task.title,
    titleSource: task.titleSource,
    status: task.status,
    projectId: task.projectId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
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

/** Agent 的任务级执行模式。 */
export type AgentExecutionMode = 'auto' | 'plan';
/** @deprecated 使用 AgentExecutionMode；保留别名兼容既有设置与调用方。 */
export type AutoModeLevel = AgentExecutionMode;

/** Agent 运行时的统计与状态（工具默认自动放行；paused 时拦截非 safe 工具） */
export interface AutoModeState {
  level: AutoModeLevel;
  /** 自动批准的工具调用累计次数 */
  autoApprovedCalls: number;
  /** 被安全规则拦截的次数 */
  blockedByRules: number;
  /** 当前是否因外部事件暂停 */
  paused: boolean;
  /** 暂停原因（paused 时有效） */
  pausedReason?: string;
}

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
  | 'budget'
  | 'cancelled'
  | 'parse'
  | 'unknown';

/** Provider 可返回的 token 与成本信息；当前不支持时显式为 null。 */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** 推理/思考 token 数；它通常已包含在 completionTokens 中。 */
  reasoningTokens?: number;
  /** 命中 prompt cache 的 token 数（OpenAI/Anthropic 部分模型支持）。 */
  cacheReadTokens?: number;
  /** 写入 prompt cache 的 token 数（Anthropic 部分模型支持）。 */
  cacheWriteTokens?: number;
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

export type ToolSource =
  | { type: 'builtin' }
  | { type: 'skill'; skillName: string }
  | { type: 'mcp'; serverName: string; originalName: string };

/** 一次工具调用 */
export interface ToolCall {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  /** true 表示该工具由 Provider 执行，Aurevoy 只负责状态与历史记录。 */
  providerExecuted?: boolean;
  /** 后端生成的人类可读调用摘要，不包含密钥、正文等敏感或大字段 */
  summary?: string;
  /** 该工具调用关联的计划步骤 ID；前端按 group 重新渲染 timeline */
  planStepId?: string;
}

/** 工具调用结果 */
export interface ToolResult {
  callId: string;
  ok: boolean;
  /** true 表示结果来自 Provider 托管工具。 */
  providerExecuted?: boolean;
  output?: unknown;
  error?: string;
  errorCode?: 'schema_validation_failed' | 'approval_denied' | 'execution_failed';
}

/** Pi harness 暴露给前端的模型推理深度。 */
export type AgentThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** Pi harness 的工具执行策略。 */
export type AgentToolExecutionMode = 'sequential' | 'parallel';

/** Provider prompt cache 保留策略（Pi streamOptions.cacheRetention）。 */
export type AgentCacheRetention = 'short' | 'long';

// ============================================================
// Agent 事件流 (通过 SSE 推送给前端)
// ============================================================

/** 运行中待注入（steering/follow-up）队列里一条用户消息的安全投影。 */
export interface PendingQueueItem {
  kind: 'steering' | 'follow_up';
  /** 待注入消息正文预览（截断）。 */
  preview: string;
}

/**
 * Agent 在执行任务过程中向前端流式推送的事件。
 * 前端据此实时渲染任务进度、思考、工具调用与最终输出。
 */
export type AgentEvent =
  | { type: 'task_created'; taskId: string; task: Task }
  | { type: 'task_title'; taskId: string; title: string; source: TaskTitleSource }
  | {
      type: 'agent_start';
      taskId: string;
      thinkingLevel: AgentThinkingLevel;
      toolExecution: AgentToolExecutionMode;
    }
  | { type: 'status'; taskId: string; status: TaskStatus }
  | { type: 'phase'; taskId: string; phase: TaskPhase; detail?: string }
  | { type: 'plan'; taskId: string; plan: PlanStep[] }
  | { type: 'step_update'; taskId: string; step: PlanStep }
  | { type: 'message_start'; taskId: string; role: MessageRole | 'toolResult' }
  | { type: 'token'; taskId: string; delta: string } // LLM 流式 token
  | { type: 'message'; taskId: string; message: Message } // 一条完整消息
  | { type: 'tool_call'; taskId: string; call: ToolCall }
  | { type: 'tool_result'; taskId: string; result: ToolResult }
  | { type: 'subagent_updated'; taskId: string; run: SubagentRun }
  | {
      type: 'tool_progress';
      taskId: string;
      callId: string;
      /** 人类可读的进度描述 */
      message: string;
      /** 分块计数：当前块号 / 总块数 */
      chunk?: { current: number; total: number };
      /** 0-100 百分比；缺省或 -1 表示不确定进度 */
      percent?: number;
    } // 工具执行中的渐进进度
  | {
      type: 'approval_request';
      taskId: string;
      call: ToolCall;
      riskLevel: ToolRiskLevel;
      autoModeReason?: 'blocked_by_rule' | 'not_covered' | 'paused';
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
  | {
      type: 'budget_usage';
      taskId: string;
      usage: BudgetUsage;
      budget?: TaskBudget;
      lifetimeUsage?: BudgetUsage;
      lifetimeBudget?: TaskBudget;
    }
  | {
      type: 'budget_exceeded';
      taskId: string;
      info: BudgetExceededInfo;
    }
  | { type: 'token_usage'; taskId: string; usage: AggregatedTokenUsage }
  | { type: 'context_snapshot'; taskId: string; tokens: number }
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
      /** LLM 摘要正文；前端据此渲染可展开的压缩标记。 */
      summary?: string;
      /** 压缩前 / 后上下文估算 token，用于 context ring 下降展示。 */
      tokensBefore?: number;
      tokensAfter?: number;
      /** 是否携带了自定义压缩指令；true 时表示按用户指令摘要。 */
      instructed?: boolean;
      /** true 表示阈值触发的自动压缩；false/缺省表示手动 /compact。 */
      automatic?: boolean;
    }
  | { type: 'scout_started'; taskId: string }
  | { type: 'scout_report'; taskId: string; report: ScoutReport }
  | { type: 'plan_generated'; taskId: string; plan: PlanStep[]; source: 'llm' | 'heuristic' }
  | { type: 'skill_deactivated'; taskId: string; previousSkill?: string | null }
  | { type: 'skill_installed'; taskId: string; skillNames: string[]; repoUrl: string }
  | { type: 'skill_uninstalled'; taskId: string; skillName: string }
  | { type: 'content_blocks_added'; taskId: string; messageId: string; blocks: ContentBlock[] }
  | { type: 'auto_mode_state'; taskId: string; state: AutoModeState }
  | {
      /** 运行中 steering/follow-up 待注入队列的可见快照。 */
      type: 'queue_update';
      taskId: string;
      pending: PendingQueueItem[];
    }
  | {
      /** LLM 后台操作（压缩/分支摘要）重试进度。active=false 表示重试结束。 */
      type: 'retry_status';
      taskId: string;
      active: boolean;
      attempt?: number;
      maxAttempts?: number;
      delayMs?: number;
      reason?: string;
    }
  | {
      /** 任务级模型/推理档已切换（会话内即时生效并记录到会话树）。 */
      type: 'model_updated';
      taskId: string;
      provider: string;
      model: string;
      thinkingLevel: AgentThinkingLevel;
    }
  | {
      /** 任务被恢复续跑；automatic=true 表示引擎重启后的自动恢复（对齐 pi -r）。 */
      type: 'task_resumed';
      taskId: string;
      automatic: boolean;
    }
  | { type: 'done'; taskId: string; status: TaskStatus }
  | { type: 'error'; taskId: string; message: string }
  | { type: 'task_deleted'; taskId: string };

/**
 * SSE 线上事件信封。
 *
 * seq 在单个 task 内严格递增，客户端可通过 Last-Event-ID 增量恢复；
 * emittedAt 用于区分模型 TTFT、服务端排队和前端渲染延迟。
 */
export type StreamAgentEvent = AgentEvent & {
  seq: number;
  emittedAt: string;
};

// ============================================================
// HTTP API 请求/响应
// ============================================================

/** POST /api/tasks — 创建并启动一个任务 */
export interface CreateTaskRequest {
  goal: string;
  /** 本次任务的执行模式；由输入框选择，未提供时默认自动执行。 */
  executionMode?: AgentExecutionMode;
  /** 单次执行预算覆盖；未提供字段使用引擎默认。 */
  budget?: TaskBudget;
  /** 任务寿命预算覆盖；未提供字段使用引擎默认。 */
  lifetimeBudget?: TaskBudget;
  projectId?: string;
  attachments?: MessageAttachment[];
}

/**
 * POST /api/tasks/:id/budget/continue — 预算触顶后续跑。
 * 引擎会在寿命预算不足时自动扩容一份额度，并重新进入 harness。
 */
export interface ContinueBudgetRequest {
  /**
   * 额外授予的寿命预算增量（可选）。
   * 未提供时，若寿命已触顶则自动追加一份额度（等于当前 run budget）。
   */
  additionalLifetime?: TaskBudget;
  /**
   * 覆盖下一 run 的预算上限（可选）；未提供则沿用任务已快照的 run budget。
   */
  runBudget?: TaskBudget;
}

export interface ContinueBudgetResponse {
  task: Task;
  streamUrl: string;
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

export type WorkspaceReadEntryType = 'file' | 'directory';
export type WorkspaceReadResultType = 'directory' | 'text' | 'image';

export interface WorkspaceReadEntry {
  name: string;
  path: string;
  type: WorkspaceReadEntryType;
  size?: number;
  mimeType?: string;
}

export interface WorkspaceReadBaseResponse {
  root: string;
  path: string;
  type: WorkspaceReadResultType;
}

export interface WorkspaceDirectoryReadResponse extends WorkspaceReadBaseResponse {
  type: 'directory';
  entries: WorkspaceReadEntry[];
  truncated: boolean;
  next?: number;
}

export interface WorkspaceTextReadResponse extends WorkspaceReadBaseResponse {
  type: 'text';
  content: string;
  offset?: number;
  truncated: boolean;
  next?: number;
}

export interface WorkspaceImageReadResponse extends WorkspaceReadBaseResponse {
  type: 'image';
  content: string;
  mimeType: string;
}

/** GET /api/workspace/read — UI-facing adapter over the Pi read tool. */
export type WorkspaceReadResponse =
  | WorkspaceDirectoryReadResponse
  | WorkspaceTextReadResponse
  | WorkspaceImageReadResponse;

/**
 * LLM 主对话就绪态（全应用防呆共用）。
 * - ready: 可发送 / 可跑 harness
 * - no_provider: provider id 非法或缺失
 * - no_credential: 缺 API Key / OAuth
 * - no_model: 有凭证但未选择主模型（空 model 禁止打上游）
 */
export type LlmReadyState = 'ready' | 'no_provider' | 'no_credential' | 'no_model';

export interface LlmReadiness {
  state: LlmReadyState;
  ready: boolean;
  provider: string;
  model: string;
}

/** GET /api/health */
export interface HealthResponse {
  status: 'ok';
  version: string;
  uptimeMs: number;
  /**
   * 兼容字段：ready 时为 `provider:model`；否则 `unconfigured`。
   * 细粒度原因见 {@link llm}。
   */
  provider: string;
  /** 结构化就绪态；UI 按 state 引导，勿再只认 unconfigured。 */
  llm: LlmReadiness;
  /** Agent 上下文字符预算（用于前端展示当前上下文使用率） */
  contextCharBudget?: number;
  /** Agent 上下文 token 预算（用于前端展示 token 使用率） */
  contextTokenBudget?: number;
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

/** Pi 原生会话树的安全投影；不向前端暴露完整模型消息和工具结果。 */
export interface PiSessionTreeNode {
  /** Aurevoy 产品消息 ID；不暴露 Pi 私有 entry ID。 */
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  role?: MessageRole;
  preview?: string;
  label?: string;
  /** 只有映射到 Pi user entry 的产品用户消息才可切换。 */
  navigable?: boolean;
}

/** GET /api/tasks/:id/session-tree */
export interface PiSessionTreeResponse {
  taskId: string;
  leafId: string | null;
  nodes: PiSessionTreeNode[];
  updatedAt?: string;
}

/** POST /api/tasks/:id/session-tree/navigate */
export interface PiSessionTreeNavigateRequest {
  targetId: string;
  /** true 时回退/分叉前生成 LLM 分支摘要，保留被剪枝部分的上下文要点。 */
  summarize?: boolean;
  /** 可选的分支摘要自定义指令。 */
  customInstructions?: string;
}

/** PUT /api/tasks/:id/session-tree/labels/:targetId */
export interface PiSessionTreeLabelRequest {
  /** 空字符串/null 语义由客户端转为 undefined，用于移除标签。 */
  label?: string;
}

/** PATCH /api/tasks/:id/model — 会话内即时切换模型/推理档 */
export interface UpdateTaskModelRequest {
  provider?: string;
  model?: string;
  thinkingLevel?: AgentThinkingLevel;
}

export interface UpdateTaskModelResponse {
  task: Task;
  modelSnapshot: TaskModelSnapshot;
}

export interface PiSessionTreeNavigateResponse {
  task: Task;
  tree: PiSessionTreeResponse;
}

/**
 * POST /api/tasks/:id/messages — 在同一任务内追加一轮用户输入并继续执行。
 * 后端保留该任务的完整消息历史作为上下文重新进入 Agent 循环（多轮对话）。
 */
export interface ContinueTaskRequest {
  /** 用户的后续追问/补充 */
  message: string;
  /** 本轮使用的输入框模式；允许在同一任务内从 Plan 切换到 Agent。 */
  executionMode?: AgentExecutionMode;
  attachments?: MessageAttachment[];
  /** 任务运行中追加消息时的投递方式；默认 steering，等当前工具批次后注入。 */
  delivery?: 'steering' | 'follow_up';
}

/** POST /api/tasks/:id/queue/clear */
export interface ClearTaskQueueRequest {
  kind?: 'steering' | 'follow_up' | 'all';
}

export interface ClearTaskQueueResponse {
  taskId: string;
  kind: 'steering' | 'follow_up' | 'all';
  cleared: boolean;
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

/** 编辑重试的恢复范围。 */
export type RevertMode =
  | 'code_and_conv' // 截断对话 + 清除 checkpoint/artifact/plan
  | 'conv_only'; // 仅截断对话，保留 plan/checkpoint/artifact

/**
 * POST /api/tasks/:id/revert — 编辑重试的截断步骤（对话截断语义）。
 *
 * 把 messageId 及其之后的所有消息从活跃历史移除，任务回到该消息发送前的状态。
 * 不回滚已落盘文件。前端在用户确认内联编辑后调用本接口，再立刻用编辑后的文案
 * 调用 continue（`POST /api/tasks/:id/messages`）完成一步「修改并重试」。
 * `removedContent` 供诊断/兼容；UI 应以用户提交的编辑稿为准，不要回填覆盖。
 */
export interface RevertTaskRequest {
  /** 要截断到的目标消息 id（该消息及其之后都会被移除） */
  messageId: string;
  /** 恢复模式：`code_and_conv` 清 plan/checkpoint；`conv_only` 仅截断对话 */
  mode?: RevertMode;
}

export interface RevertTaskResponse {
  task: Task;
  /** 被移除的目标消息原文（user 消息时有值）；不应覆盖用户已编辑的稿 */
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
 * 仅在 revert 成功、continue 尚未写入新消息时可用（例如 continue 失败后的恢复）。
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
  /** 可选的自定义压缩指令（如“只保留关于 X 的决定”），传给 LLM 摘要器。 */
  instructions?: string;
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
  /** M8: 向量索引更新时间（有值表示已向量化，可用于语义搜索） */
  embeddingUpdatedAt?: string | null;
}

/** Skill: 暴露给前端的 skill 摘要（Agent Skills 标准格式，不含 body）。 */
export interface SkillDescriptor {
  name: string;
  description: string;
  allowedTools?: string[];
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  sourceDir: 'builtin' | 'user' | 'workspace' | 'system';
  /** 来源目录名，如 .aurevoy、.claude、.agents、.codex。优先级最高的工作区会附加 "(workspace)"。 */
  sourcePath: string;
  /** SKILL.md 文件的绝对路径（供模型 file-read 激活用）。 */
  location?: string;
  /** 安装来源 Git 仓库 URL（仅通过 install 安装的 skill）。 */
  installUrl?: string;
  /** 安装时间 ISO 时间戳。 */
  installedAt?: string;
  /** 是否启用；禁用的 skill 不会出现在 Agent 的 skill catalog 中，也不能被 load_skill 加载。 */
  enabled: boolean;
}

/** GET /api/skills/:name — 详情（含 SKILL.md body，供详情弹层渲染）。 */
export interface SkillDetail extends SkillDescriptor {
  /** frontmatter 之后的 markdown 正文。 */
  body: string;
  resources: Array<{
    type: 'script' | 'reference' | 'asset' | 'other';
    relativePath: string;
  }>;
}

/** POST /api/skills/install — 从 Git 仓库安装 skill */
export interface SkillInstallRequest {
  repoUrl: string;
}

/** POST /api/skills/install 响应 */
export interface SkillInstallResponse {
  installedSkills: string[];
  repoUrl: string;
  alreadyExisted: string[];
  totalFound: number;
}

/** DELETE /api/skills/:name 响应 */
export interface SkillUninstallResponse {
  name: string;
  deleted: boolean;
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

/** M8: 引用来源类型 */
export type CitationSourceType = 'memory' | 'kb_chunk' | 'kb_file';

/** M8: 结构化引用信息，用于追溯搜索结果与注入记忆的来源。 */
export interface Citation {
  sourceId: string;
  sourceType: CitationSourceType;
  /** 原文片段（前 200 字符） */
  content: string;
  /** 相关度 0-1 */
  score: number;
  /** memory 专用 */
  category?: MemoryCategory;
  nameSlug?: string;
  /** KB 专用 */
  filePath?: string;
  chunkIndex?: number;
}

/** M8: 含引用的搜索结果 */
export interface SearchResultWithCitations {
  results: Array<{
    file: string;
    snippet: string;
    score: number;
  }>;
  citations: Citation[];
  found: number;
  note: string;
}

// ============================================================
// M5 设置、工具管理与数据管理
// ============================================================

/**
 * 已保存的单个 LLM Provider 槽位。
 * 密钥永不回显，仅暴露 apiKeyConfigured。
 * 主界面模型菜单可跨槽位切换，后端激活对应 provider 的 key/baseUrl/model。
 */
export interface LlmProviderSlot {
  /** Pi provider id, e.g. openai / anthropic / deepseek / openrouter / google. */
  provider: string;
  baseUrl: string;
  /** 该 provider 上次使用的主模型 */
  model: string;
  /** 最近一次从该 Provider 获取到的完整模型列表 */
  availableModels: string[];
  /** 用户勾选后允许出现在主界面模型菜单中的模型列表 */
  enabledModels: string[];
  /** 在本机模型注册表中声明支持图片输入的模型 id。 */
  imageInputModels: string[];
  apiKeyConfigured: boolean;
  /** 是否已配置 OAuth 订阅凭证（密钥永不回显） */
  oauthConfigured: boolean;
}

/**
 * 来自 Pi `builtinProviders()` 的目录项（只读元数据）。
 * 前端按此渲染连接形态；协议/鉴权由 Pi 各 provider 实现，不在 UI 复刻。
 */
export interface PiProviderCatalogEntry {
  /** Pi provider id */
  id: string;
  /** 展示名 */
  name: string;
  /** 默认 baseUrl；空表示需用户填写或由 ambient 凭证推导 */
  defaultBaseUrl: string;
  /**
   * 该 provider 模型使用的协议（Pi model.api）。
   * 例：anthropic → ["anthropic-messages"]；openai → ["openai-responses"]
   */
  apis: string[];
  /** 是否支持 API Key / 静态凭证 */
  supportsApiKey: boolean;
  /** API Key 字段标签（来自 Pi auth.apiKey.name） */
  apiKeyLabel?: string;
  /** 是否支持 OAuth 订阅登录（Pi auth.oauth） */
  supportsOauth: boolean;
  /** OAuth 展示名（来自 Pi auth.oauth.name） */
  oauthLabel?: string;
  /** 内置 catalog 模型数量（静态；动态 provider 可能为 0） */
  modelCount: number;
  /**
   * 是否必须由用户提供 baseUrl。
   * 仅 openai-compatible 为 true；内置 provider 可留空用默认。
   */
  requiresBaseUrl: boolean;
  /** 是否为 Aurevoy 合成的自定义兼容端（非 Pi 内置） */
  custom?: boolean;
}

/** 引擎运维日志等级（Pino）。 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface RuntimeSettings {
  llm: {
    /** 当前激活的 Pi provider id。 */
    provider: string;
    baseUrl: string;
    model: string;
    /** 当前激活 Provider 的完整模型列表（与 providers[active].availableModels 一致）。 */
    availableModels: string[];
    /** 当前激活 Provider 的已启用模型（与 providers[active].enabledModels 一致）。 */
    enabledModels: string[];
    /** 当前激活 Provider 中声明支持图片输入的模型。 */
    imageInputModels: string[];
    temperature: number;
    timeoutMs: number;
    maxTokens: number;
    apiKeyConfigured: boolean;
    /** 当前激活 provider 是否已配置 OAuth 订阅凭证 */
    oauthConfigured: boolean;
    /**
     * 全部已配置过的 Provider 槽位。
     * 主界面模型菜单据此跨 provider 展示/切换；设置页切换下拉时据此回填字段。
     */
    providers: LlmProviderSlot[];
    /**
     * 内置 provider 目录 + openai-compatible 自定义项。
     * 设置页列表与连接表单据此渲染鉴权能力。
     */
    providerCatalog: PiProviderCatalogEntry[];
  };
  workspaceDir: string;
  commandExecutionEnabled: boolean;
  mcpServersJson: string;
  cleanupPolicyDays: number;
  /** 始终为 auto（兼容字段；UI 不再提供切换） */
  autoModeLevel: AutoModeLevel;
  /** 是否启用 auto mode 安全规则（拦截 destroy/exfiltrate 等危险操作） */
  autoModeSafetyEnabled: boolean;
  /** Pi harness 推理深度。 */
  agentThinkingLevel: AgentThinkingLevel;
  /** Pi harness 工具执行策略。 */
  agentToolExecution: AgentToolExecutionMode;
  /** Prompt cache 保留时长：long 利于多轮/长任务；short 更省 provider 侧缓存配额。 */
  agentCacheRetention: AgentCacheRetention;
  /** 上下文接近阈值时用 LLM 自动生成结构化摘要（自动压缩）。 */
  agentAutoCompact: boolean;
  /** 引擎重启后自动恢复上次进行中（running/pending）的任务并续跑（对齐 pi -r）。 */
  autoResumeInterruptedTasks: boolean;
  /** 任务开始时按目标隐式召回相关长期记忆并注入上下文。 */
  memoryRecallEnabled: boolean;
  /** 任务开始时按目标隐式召回相关知识库片段并注入上下文。 */
  kbRecallEnabled: boolean;
  /**
   * 新建任务时的默认执行预算（写入任务快照）。
   * 运行中任务不受此处后续修改影响。
   */
  budget: {
    run: Required<TaskBudget>;
    lifetime: Required<TaskBudget>;
  };
  dbPath: string;
  /** M8: Embedding Provider 配置（OpenAI 兼容接口） */
  embedding: {
    provider: 'openai' | 'off';
    model: string;
    baseUrl: string;
    apiKeyConfigured: boolean;
  };
  /** 用户指定的 Python 解释器路径（空则表示使用系统自动检测） */
  pythonPath: string;
  /** Web 搜索配置 */
  search: {
    /** 优先使用上游 Responses / Anthropic Messages 的服务器搜索；不支持时回退本地搜索。 */
    preferNative: boolean;
    provider: 'duckduckgo_lite' | 'tavily' | 'searxng' | 'custom';
    baseUrl: string;
    apiKeyConfigured: boolean;
  };
  /** 引擎运维日志（文件在 logFile；任务审计轨迹仍写 SQLite） */
  logging: {
    level: LogLevel;
    /** 当前日志文件路径（只读展示） */
    logFile: string;
  };
  /**
   * Agent 出站 HTTP(S) 代理（OAuth / LLM / 搜索等 Node fetch）。
   * 与系统代理无关：须在此填写或设置 HTTP(S)_PROXY 环境变量。
   */
  proxy: {
    enabled: boolean;
    /** 例如 http://127.0.0.1:7890 */
    url: string;
    /** 逗号分隔绕过列表，默认含 localhost */
    noProxy: string;
  };
}

export interface UpdateRuntimeSettingsRequest {
  llm?: Partial<{
    /**
     * 切换激活的 Pi provider。
     * 若该 provider 已有保存槽位，会恢复其 baseUrl/model/key；
     * 同一请求中的 model/baseUrl/apiKey 等字段会再覆盖到新激活槽位。
     */
    provider: string;
    baseUrl: string;
    model: string;
    availableModels: string[];
    enabledModels: string[];
    temperature: number;
    timeoutMs: number;
    maxTokens: number;
    /** 写入新 Key；留空字段表示不修改，空字符串表示清除。响应永不回显。按当前激活 provider 分槽存储。 */
    apiKey: string;
    /**
     * 删除指定 provider 槽位（含分槽 API Key）。
     * 若删除的是当前激活槽位，会自动切换到剩余槽位之一；
     * 若无剩余槽位，则回落到 openai 空配置。
     */
    removeProvider: string;
    /**
     * 更新指定槽位的 enabledModels，不切换当前激活 provider。
     * 若 provider 为当前激活槽，会同步扁平字段。
     */
    slotEnabledModels: {
      provider: string;
      enabledModels: string[];
    };
    /** 更新指定槽位中支持图片输入的模型；能力在本机注册并在请求前校验。 */
    slotImageInputModels: {
      provider: string;
      imageInputModels: string[];
    };
    /**
     * 更新指定槽位的 availableModels（完整目录，含用户自定义 id）。
     * 会同步修剪 enabledModels 中已不存在的项。
     * 若 provider 为当前激活槽，会同步扁平字段。
     */
    slotAvailableModels: {
      provider: string;
      availableModels: string[];
    };
    /**
     * 更新指定槽位的默认 model，不强制切换激活 provider。
     * 若 provider 为当前激活槽，会同步扁平 model 字段。
     */
    slotModel: {
      provider: string;
      model: string;
    };
  }>;
  workspaceDir?: string;
  commandExecutionEnabled?: boolean;
  mcpServersJson?: string;
  cleanupPolicyDays?: number;
  autoModeLevel?: AutoModeLevel;
  autoModeSafetyEnabled?: boolean;
  agentThinkingLevel?: AgentThinkingLevel;
  agentToolExecution?: AgentToolExecutionMode;
  agentCacheRetention?: AgentCacheRetention;
  agentAutoCompact?: boolean;
  autoResumeInterruptedTasks?: boolean;
  memoryRecallEnabled?: boolean;
  kbRecallEnabled?: boolean;
  /** 覆盖默认任务预算；仅影响此后新建的任务。 */
  budget?: {
    run?: Partial<TaskBudget>;
    lifetime?: Partial<TaskBudget>;
  };
  /** M8: Embedding Provider 配置（OpenAI 兼容接口） */
  embedding?: Partial<{
    provider: 'openai' | 'off';
    model: string;
    baseUrl: string;
    /** 写入新 Key；留空字段表示不修改，空字符串表示清除。响应永不回显。 */
    apiKey: string;
  }>;
  /** 用户指定的 Python 解释器路径 */
  pythonPath?: string;
  /** Web 搜索配置 */
  search?: Partial<{
    preferNative: boolean;
    provider: 'duckduckgo_lite' | 'tavily' | 'searxng' | 'custom';
    baseUrl: string;
    /** 写入新 Key；留空字段表示不修改，空字符串表示清除。响应永不回显。 */
    apiKey: string;
  }>;
  /** 运维日志；仅 level 可写，路径只读 */
  logging?: Partial<{
    level: LogLevel;
  }>;
  /** Agent 出站代理；保存后立即对全局 fetch 生效 */
  proxy?: Partial<{
    enabled: boolean;
    url: string;
    noProxy: string;
  }>;
}

export interface ModelListResponse {
  models: string[];
}

/** POST /api/settings/llm/oauth/login */
export interface OauthLoginStartRequest {
  provider: string;
}

/** OAuth 登录会话状态（轮询） */
export type OauthSessionStatus = 'running' | 'awaiting_input' | 'done' | 'error' | 'cancelled';

export type OauthAuthEvent =
  | { type: 'auth_url'; url: string; instructions?: string }
  | {
      type: 'device_code';
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: 'progress'; message: string };

export type OauthAuthPrompt =
  | { type: 'text'; message: string; placeholder?: string; signal?: never }
  | { type: 'secret'; message: string; placeholder?: string }
  | {
      type: 'select';
      message: string;
      options: ReadonlyArray<{ id: string; label: string; description?: string }>;
    }
  | { type: 'manual_code'; message: string; placeholder?: string };

export interface OauthSessionSnapshot {
  sessionId: string;
  provider: string;
  status: OauthSessionStatus;
  events: OauthAuthEvent[];
  pendingPrompt?: OauthAuthPrompt;
  error?: string;
}

/** POST /api/settings/llm/oauth/session/:id/respond */
export interface OauthLoginRespondRequest {
  value: string;
}

/** POST /api/settings/llm/oauth/logout */
export interface OauthLogoutRequest {
  provider: string;
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
// M8: 知识库类型
// ============================================================

export interface KbDir {
  id: string;
  dirPath: string;
  recursive: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KbDirListResponse {
  dirs: KbDir[];
}

export interface KbIndexStatus {
  totalFiles: number;
  totalChunks: number;
  lastIndexed: string | null;
}

export interface AddKbDirRequest {
  dirPath: string;
  recursive?: boolean;
}

// ============================================================
// 模型目录工具
// ============================================================

/**
 * 判断模型 id 是否更像「对话/补全」模型，而非 embedding / TTS / 图像生成等。
 * 用于过滤 Provider `/models` 混目录，避免 text-embedding 等出现在主模型列表。
 */
export function isChatModelId(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  if (!id) return false;
  // embedding / vector
  if (
    id.includes('embed')
    || id.includes('embedding')
    || id.includes('bge-')
    || id.includes('e5-')
    || id.includes('nomic-embed')
    || id.includes('text-embedding')
  ) {
    return false;
  }
  // speech / audio
  if (
    id.includes('tts')
    || id.includes('whisper')
    || id.includes('transcri')
    || id.includes('speech')
    || id.includes('audio')
    || id.includes('realtime')
  ) {
    return false;
  }
  // image / video gen
  if (
    id.includes('dall-e')
    || id.includes('dalle')
    || id.includes('stable-diffusion')
    || id.includes('sdxl')
    || id.includes('image-')
    || id.includes('imagen')
    || id.includes('sora')
    || id.includes('flux')
    || /(^|[-_/])(t2i|i2i|t2v|i2v)([-_/]|$)/.test(id)
  ) {
    return false;
  }
  // moderation / rerank / classify
  if (id.includes('moderation') || id.includes('rerank') || id.includes('classifier')) {
    return false;
  }
  return true;
}

/** 过滤出适合对话的模型 id 列表（保序、去重）。 */
export function filterChatModelIds(modelIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of modelIds) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id || seen.has(id) || !isChatModelId(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// ============================================================
// 运行时常量
// ============================================================

/** Agent 引擎默认监听地址 */
export const AGENT_DEFAULT_HOST = '127.0.0.1';
export const AGENT_DEFAULT_PORT = 8787;
export const AGENT_DEFAULT_BASE_URL = `http://${AGENT_DEFAULT_HOST}:${AGENT_DEFAULT_PORT}`;
