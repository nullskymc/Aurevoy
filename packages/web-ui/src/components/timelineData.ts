import type {
  ContentBlock,
  Message,
  MessageToolCall,
  PlanStep,
  SubagentRole,
  SubagentRun,
} from "@aurevoy/shared";
import { mapPlanStepGroupStatus, type PlanUiStatus } from "./planStatus";
import {
  classifyTimelineToolStatus,
  isCancelledToolError,
  shouldHideToolFromWorkflow,
} from "./timelineWorkflow";

/** 步骤类型标签，用于 badge 区分。 */
export type StepKind =
  | "command" | "file_read" | "file_write" | "search"
  | "browse" | "think" | "api" | "edit" | "artifact" | "other";

/** 单个 timeline 步骤（对应一个工具调用）。 */
export interface TimelineStepData {
  id: string;
  kind: StepKind;
  title: string;
  /** 后端提供的状态无关动作摘要；存在时优先于前端参数猜测。 */
  summary?: string;
  status: "pending" | "running" | "success" | "failed" | "cancelled";
  planStepId?: string;
  logs?: string;
  output?: string;
  error?: string;
  args?: Record<string, unknown>;
  toolName?: string;
  rawOutput?: unknown;
  progress?: {
    message: string;
    chunk?: { current: number; total: number };
    percent?: number;
  };
}

/** 按计划步骤分组的工具调用集合。 */
export interface PlanStepGroupData {
  planStepId: string;
  description: string;
  status: PlanUiStatus;
  /** Shown when plan step is blocked/paused. */
  blockedReason?: string;
  steps: TimelineStepData[];
}

/** 一轮 Agent 回复的完整 timeline 呈现数据。 */
export interface AgentRoundData {
  id: string;
  planStepGroups: PlanStepGroupData[];
  summary: string;
  markdownOutput?: string;
  contentBlocks?: ContentBlock[];
  subagentRuns?: SubagentRun[];
  status: "pending" | "running" | "completed" | "failed" | "blocked" | "cancelled";
}

/** 按稳定 ID 合并内嵌内容块，避免 SSE 重放造成 React key 冲突。 */
export function dedupeContentBlocks(blocks: ContentBlock[] | undefined): ContentBlock[] {
  if (!blocks || blocks.length < 2) return blocks ?? [];
  const byId = new Map<string, ContentBlock>();
  for (const block of blocks) byId.set(block.id, block);
  return [...byId.values()];
}

/** 从工具名推断步骤类型。 */
export function detectStepKind(toolName: string): StepKind {
  if (toolName === "execute_command" || toolName === "bash") return "command";
  if (toolName === "read_file" || toolName === "open_file" || toolName === "scroll" || toolName === "read") return "file_read";
  if (toolName === "write_file" || toolName === "create_file" || toolName === "append_file" || toolName === "session_open" || toolName === "session_write" || toolName === "session_close" || toolName === "session_abort" || toolName === "write") return "file_write";
  if (toolName === "edit_file" || toolName === "apply_diff" || toolName === "replace_lines" || toolName === "edit_lines" || toolName === "edit") return "edit";
  if (toolName === "web_search" || toolName === "search_grep" || toolName === "search_files" || toolName === "grep" || toolName === "glob") return "search";
  if (toolName === "web_fetch") return "browse";
  if (toolName === "create_artifact" || toolName === "apply_artifact") return "artifact";
  if (toolName.startsWith("browser_")) return "browse";
  if (toolName.startsWith("mcp_")) return "api";
  return "other";
}

/** 生成聚合摘要文本。 */
export function computeSummaryFromSteps(steps: TimelineStepData[]): string {
  const counts: Record<string, number> = {};
  for (const step of steps) {
    const key = step.kind === "command" ? "命令"
      : step.kind === "file_read" ? "读取文件"
      : step.kind === "file_write" ? "创建文件"
      : step.kind === "edit" ? "编辑文件"
      : step.kind === "search" ? "搜索"
      : step.kind === "browse" ? "浏览网页"
      : step.kind === "artifact" ? "生成产物"
      : null;
    if (key) counts[key] = (counts[key] ?? 0) + 1;
  }
  const parts: string[] = [];
  for (const [label, count] of Object.entries(counts)) parts.push(`${count} 个${label}`);
  return parts.length > 0 ? `执行了 ${parts.join("，")}` : "";
}

/** 从 MessageToolCall 构建历史步骤数据。 */
function buildStepsFromToolCalls(
  toolCalls: MessageToolCall[],
  resultMap: Map<string, { ok: boolean; output?: unknown; error?: string }>,
  phaseCancelled = false,
): TimelineStepData[] {
  return toolCalls.filter((toolCall) => !shouldHideToolFromWorkflow(toolCall.function.name)).map((toolCall) => {
    const kind = detectStepKind(toolCall.function.name);
    let args: Record<string, unknown> = {};
    try {
      args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
    } catch {
      // 旧消息参数损坏时仍渲染工具卡，不让单个坏参数破坏整段历史。
    }
    const result = resultMap.get(toolCall.id);
    const status = classifyTimelineToolStatus(result, phaseCancelled);
    return {
      id: toolCall.id,
      kind,
      title: buildStepTitle(toolCall.function.name, args),
      summary: toolCall.function.summary,
      status,
      planStepId: toolCall.function.planStepId,
      logs: extractLogContent(toolCall.function.name, result),
      output: result?.output != null ? formatOutput(result.output) : undefined,
      error: result && !result.ok ? (result.error ?? "执行失败") : undefined,
      toolName: toolCall.function.name,
      rawOutput: result?.output,
    };
  });
}

/** 从工具参数构建短标题，避免把大参数塞进时间轴。 */
function buildStepTitle(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "execute_command" || toolName === "bash") {
    const command = typeof args.command === "string" ? args.command : "";
    const commandArgs = Array.isArray(args.args) ? (args.args as unknown[]).map(String).join(" ") : "";
    return truncateTitle([command, commandArgs].filter(Boolean).join(" ")) || "";
  }
  if (toolName === "replace_lines" || toolName === "edit_lines" || toolName === "edit") {
    const path = typeof args.path === "string" ? args.path : "";
    const startLine = typeof args.start_line === "number" ? args.start_line : null;
    const endLine = typeof args.end_line === "number" ? args.end_line : null;
    if (path && startLine != null && endLine != null) return truncateTitle(`${path} L${startLine}-${endLine}`);
    return truncateTitle(path) || "";
  }
  if (toolName === "write_file" || toolName === "write" || toolName === "append_file" || toolName === "session_open") {
    const path = typeof args.path === "string" ? args.path : "";
    return truncateTitle(path) || "";
  }
  if (toolName === "session_write" || toolName === "session_close" || toolName === "session_abort") {
    const sessionId = typeof args.session_id === "string" ? args.session_id.slice(0, 8) : "";
    return sessionId || "";
  }
  if (toolName === "open_file" || toolName === "read") {
    const path = typeof args.path === "string" ? args.path : "";
    const line = typeof args.line_number === "number" ? args.line_number : null;
    if (path && line != null) return truncateTitle(`${path} :${line}`);
    return truncateTitle(path) || "";
  }
  if (toolName === "scroll") {
    const file = typeof args.file === "string" ? args.file : "";
    const direction = typeof args.direction === "string" ? args.direction : "";
    return file ? truncateTitle(`${file} ${direction}`) : "";
  }
  if (toolName === "search_grep") {
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    return pattern ? truncateTitle(pattern) : "";
  }
  const target =
    (typeof args.TargetFile === "string" ? args.TargetFile :
      typeof args.AbsolutePath === "string" ? args.AbsolutePath :
        typeof args.path === "string" ? args.path :
          typeof args.filePath === "string" ? args.filePath :
            typeof args.query === "string" ? args.query :
              typeof args.Query === "string" ? args.Query :
                typeof args.pattern === "string" ? args.pattern :
                  typeof args.item_key === "string" ? args.item_key :
                    typeof args.itemKey === "string" ? args.itemKey :
                      typeof args.resource_id === "string" ? args.resource_id :
                        typeof args.resourceId === "string" ? args.resourceId :
                          typeof args.url === "string" ? args.url : null);
  if (target) return truncateTitle(target);
  if (toolName === "web_search") {
    const query = typeof args.query === "string" ? args.query : typeof args.Query === "string" ? args.Query : "";
    return query ? truncateTitle(query) : "";
  }
  if (toolName === "web_fetch") {
    const url = typeof args.url === "string" ? args.url : "";
    return url ? truncateTitle(url) : "";
  }
  return "";
}

export function truncateTitle(value: string, max = 55): string {
  return value.length > max ? value.slice(0, max - 2) + "…" : value;
}

/** 提取工具输出中的用户可读日志摘要。 */
function extractLogContent(
  toolName: string,
  result?: { ok: boolean; output?: unknown; error?: string },
): string | undefined {
  if (!result) return undefined;
  if (toolName === "execute_command") {
    const output = result.output;
    if (typeof output === "string") return output;
    if (typeof output === "object" && output !== null) {
      const record = output as Record<string, unknown>;
      return [record.stdout, record.stderr].filter(Boolean).join("\n") || undefined;
    }
    return undefined;
  }
  if (toolName === "read_file" || toolName === "open_file" || toolName === "scroll" || toolName === "read") {
    const output = result.output;
    if (typeof output === "string") return output.slice(0, 2000);
    if (typeof output === "object" && output !== null) {
      const record = output as Record<string, unknown>;
      if (typeof record.text === "string") return record.text.slice(0, 2000);
      if (typeof record.content === "string") return record.content.slice(0, 2000);
    }
    return undefined;
  }
  if (toolName === "search_grep" || toolName === "search_files" || toolName === "grep" || toolName === "glob") {
    const output = result.output;
    if (typeof output === "string") return output.slice(0, 2000);
    if (typeof output === "object" && output !== null) {
      const matches = (output as Record<string, unknown>).matches;
      if (Array.isArray(matches)) {
        return matches.slice(0, 20).map((match) => {
          const item = match as Record<string, unknown>;
          return `${item.file}:${item.line}: ${item.content}`;
        }).join("\n");
      }
    }
    return undefined;
  }
  if (toolName === "replace_lines" || toolName === "edit_lines" || toolName === "write_file" || toolName === "append_file" || toolName === "edit_file" || toolName === "create_file" || toolName === "write") {
    const output = result.output;
    if (typeof output === "object" && output !== null) {
      const record = output as Record<string, unknown>;
      const parts: string[] = [];
      if (typeof record.bytes_written === "number") parts.push(`写入 ${record.bytes_written} 字节`);
      if (typeof record.replaced_lines === "number") parts.push(`替换 ${record.replaced_lines} 行 → ${record.new_lines_count} 行`);
      if (typeof record.note === "string") parts.push(record.note);
      if (Array.isArray(record.preview)) {
        parts.push(record.preview.slice(0, 15).map((preview) => {
          const item = preview as Record<string, unknown>;
          return `${item.changed ? "+ " : "  "}${String(item.lineNumber).padStart(5)} | ${item.content}`;
        }).join("\n"));
      }
      return parts.length > 0 ? parts.join("\n") : undefined;
    }
    return undefined;
  }
  return undefined;
}

function formatOutput(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function resolveHistoricalSubagentRuns(
  toolCalls: MessageToolCall[],
  resultMap: Map<string, { ok: boolean; output?: unknown; error?: string }>,
  persistedRuns: SubagentRun[],
  createdAt: string,
  phaseCancelled = false,
): SubagentRun[] {
  const delegateCalls = toolCalls.filter((call) => call.function.name === "delegate");
  const callIds = new Set(delegateCalls.map((call) => call.id));
  const runs = persistedRuns.filter((run) => callIds.has(run.parentCallId));

  for (const call of delegateCalls) {
    if (runs.some((run) => run.parentCallId === call.id)) continue;
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(call.function.arguments || "{}");
      if (isRecord(parsed)) args = parsed;
    } catch {
      // 旧消息参数损坏时仍保留一个可诊断的委托卡片。
    }
    const result = resultMap.get(call.id);
    const output = isRecord(result?.output) ? result.output : undefined;
    const completed = output?.completed === true;
    const cancelled = !completed && (isCancelledToolError(result?.error) || (phaseCancelled && !result));
    const role = normalizeSubagentRole(output?.role ?? args.role);
    const error = !completed
      ? (typeof output?.result === "string" ? output.result : result?.error)
      : undefined;
    runs.push({
      id: typeof output?.runId === "string" ? output.runId : `legacy-${call.id}`,
      parentCallId: call.id,
      role,
      goal: typeof args.goal === "string" ? args.goal : "委托子任务",
      status: completed ? "completed" : cancelled ? "cancelled" : "failed",
      currentActivity: completed ? "已完成并返回结果" : cancelled ? "已取消" : error ?? "子代理运行失败",
      activities: [],
      iterations: typeof output?.iterations === "number" ? output.iterations : 0,
      toolCallCount: typeof output?.toolCallCount === "number" ? output.toolCallCount : 0,
      maxIterations: typeof args.maxIterations === "number" ? args.maxIterations : undefined,
      stopReason: typeof output?.stopReason === "string"
        ? output.stopReason as SubagentRun["stopReason"]
        : completed ? "completed" : cancelled ? "cancelled" : "error",
      result: completed && typeof output?.result === "string" ? output.result : undefined,
      error,
      truncated: output?.truncated === true,
      durationMs: typeof output?.durationMs === "number" ? output.durationMs : undefined,
      createdAt,
      startedAt: createdAt,
      completedAt: createdAt,
    });
  }
  return runs;
}

function subagentRunFromLiveActivity(activity: {
  id: string;
  args: unknown;
  status: string;
  progress?: { message: string };
}): SubagentRun {
  const args = isRecord(activity.args) ? activity.args : {};
  const now = new Date().toISOString();
  const status: SubagentRun["status"] =
    activity.status === "error" ? "failed"
      : activity.status === "ok" ? "completed"
        : activity.status === "cancelled" ? "cancelled"
          : activity.status === "running" ? "running"
            : "queued";
  return {
    id: `pending-${activity.id}`,
    parentCallId: activity.id,
    role: normalizeSubagentRole(args.role),
    goal: typeof args.goal === "string" ? args.goal : "准备委托子任务",
    status,
    currentActivity: activity.progress?.message
      ?? (status === "running" ? "子智能体执行中" : status === "completed" ? "已完成" : status === "cancelled" ? "已取消" : "正在创建子智能体"),
    activities: [],
    iterations: 0,
    toolCallCount: 0,
    maxIterations: typeof args.maxIterations === "number" ? args.maxIterations : undefined,
    error: activity.status === "error" ? "子代理未能启动" : undefined,
    createdAt: now,
    startedAt: now,
  };
}

function normalizeSubagentRole(value: unknown): SubagentRole {
  return value === "explore" || value === "research" || value === "coder"
    || value === "shell" || value === "writer" || value === "general"
    ? value
    : "general";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从历史消息构建 AgentRoundData。 */
export function buildAgentRoundFromMessage(
  message: Message,
  resultMap: Map<string, { ok: boolean; output?: unknown; error?: string }>,
  planSteps: PlanStep[],
  persistedSubagentRuns: SubagentRun[] = [],
  phase?: string | null,
): AgentRoundData {
  const toolCalls = message.toolCalls ?? [];
  const phaseCancelled = phase === "cancelled";
  const steps = buildStepsFromToolCalls(toolCalls, resultMap, phaseCancelled);
  const summary = computeSummaryFromSteps(steps);
  const subagentRuns = resolveHistoricalSubagentRuns(toolCalls, resultMap, persistedSubagentRuns, message.createdAt, phaseCancelled);

  const groupsByPlanStepId = new Map<string, TimelineStepData[]>();
  const unnamedSteps: TimelineStepData[] = [];
  for (const step of steps) {
    if (step.planStepId) {
      const list = groupsByPlanStepId.get(step.planStepId) ?? [];
      list.push(step);
      groupsByPlanStepId.set(step.planStepId, list);
    } else {
      unnamedSteps.push(step);
    }
  }

  const planStepGroups: PlanStepGroupData[] = [];
  if (groupsByPlanStepId.size > 0) {
    const renderedPlanStepIds = new Set<string>();
    for (const planStep of planSteps) {
      const stepsInGroup = groupsByPlanStepId.get(planStep.id) ?? [];
      if (stepsInGroup.length === 0) continue;
      renderedPlanStepIds.add(planStep.id);
      const toolFailed = stepsInGroup.some((step) => step.status === "failed");
      planStepGroups.push({
        planStepId: planStep.id,
        description: planStep.description,
        status: mapPlanStepGroupStatus(planStep.status, toolFailed, false, phaseCancelled),
        blockedReason: planStep.blockedReason,
        steps: stepsInGroup,
      });
    }
    for (const [planStepId, stepsInGroup] of groupsByPlanStepId) {
      if (renderedPlanStepIds.has(planStepId)) continue;
      planStepGroups.push({
        planStepId,
        description: "执行工具",
        status: stepsInGroup.some((step) => step.status === "failed")
          ? "failed"
          : stepsInGroup.some((step) => step.status === "cancelled") ? "cancelled" : "completed",
        steps: stepsInGroup,
      });
    }
  }
  if (unnamedSteps.length > 0) {
    planStepGroups.push({
      planStepId: "_default",
      description: "执行任务",
      status: unnamedSteps.some((step) => step.status === "failed")
        ? "failed"
        : unnamedSteps.some((step) => step.status === "cancelled") ? "cancelled" : "completed",
      steps: unnamedSteps,
    });
  }

  return {
    id: `${message.id}-timeline`,
    planStepGroups,
    summary,
    markdownOutput: message.content,
    contentBlocks: message.contentBlocks,
    subagentRuns,
    status: steps.some((step) => step.status === "failed") || subagentRuns.some((run) => run.status === "failed")
      ? "failed"
      : steps.some((step) => step.status === "cancelled") || subagentRuns.some((run) => run.status === "cancelled")
        ? "cancelled"
        : "completed",
  };
}

/** 从 SSE 实时数据（即 ToolActivity[]）构建 AgentRoundData。 */
export function buildLiveAgentRoundData(params: {
  plan: PlanStep[];
  liveToolActivity: {
    id: string;
    name: string;
    args: unknown;
    summary?: string;
    status: string;
    planStepId?: string;
    output?: unknown;
    error?: string;
    progress?: { message: string; chunk?: { current: number; total: number }; percent?: number };
  }[];
  output?: string;
  phase?: string | null;
  contentBlocks?: ContentBlock[];
  subagentRuns?: SubagentRun[];
}): AgentRoundData {
  const { plan, liveToolActivity, output, phase, contentBlocks, subagentRuns = [] } = params;
  const isFailed = phase === "failed";
  const isCancelled = phase === "cancelled";
  const isActivePhase = phase === "thinking" || phase === "planning" || phase === "initializing";
  const delegateActivities = liveToolActivity.filter((activity) => activity.name === "delegate");
  const visibleSubagentRuns = [...subagentRuns];
  for (const activity of delegateActivities) {
    if (!visibleSubagentRuns.some((run) => run.parentCallId === activity.id)) {
      visibleSubagentRuns.push(subagentRunFromLiveActivity(activity));
    }
  }

  const steps: TimelineStepData[] = liveToolActivity
    .filter((activity) => !shouldHideToolFromWorkflow(activity.name))
    .map((activity) => {
      const kind = detectStepKind(activity.name);
      const args = isRecord(activity.args) ? activity.args : {};
      const status: TimelineStepData["status"] =
        activity.status === "ok" ? "success"
          : activity.status === "error" ? (isCancelledToolError(activity.error) ? "cancelled" : "failed")
            : activity.status === "cancelled" ? "cancelled"
              : isCancelled ? "cancelled"
                : activity.status === "awaiting" ? "pending" : "running";
      return {
        id: activity.id,
        kind,
        title: buildStepTitle(activity.name, args),
        summary: activity.summary,
        status,
        planStepId: activity.planStepId,
        logs: extractLogContent(activity.name, activity.status !== "running"
          ? { ok: activity.status === "ok", output: activity.output, error: activity.error }
          : undefined),
        error: activity.error,
        output: activity.output != null ? formatOutput(activity.output) : undefined,
        rawOutput: activity.output,
        args,
        toolName: activity.name,
        progress: activity.progress,
      };
    });

  const summary = computeSummaryFromSteps(steps);
  const stepsByPlanStepId = new Map<string, TimelineStepData[]>();
  const unnamedSteps: TimelineStepData[] = [];
  for (const step of steps) {
    if (step.planStepId) {
      const list = stepsByPlanStepId.get(step.planStepId) ?? [];
      list.push(step);
      stepsByPlanStepId.set(step.planStepId, list);
    } else {
      unnamedSteps.push(step);
    }
  }

  const planStepGroups: PlanStepGroupData[] = [];
  if (stepsByPlanStepId.size > 0) {
    const renderedPlanStepIds = new Set<string>();
    for (const planStep of plan) {
      const stepsInGroup = stepsByPlanStepId.get(planStep.id) ?? [];
      if (stepsInGroup.length === 0) continue;
      renderedPlanStepIds.add(planStep.id);
      const toolFailed = stepsInGroup.some((step) => step.status === "failed");
      planStepGroups.push({
        planStepId: planStep.id,
        description: planStep.description,
        status: mapPlanStepGroupStatus(planStep.status, toolFailed, isFailed, isCancelled),
        blockedReason: planStep.blockedReason,
        steps: stepsInGroup,
      });
    }
    for (const [planStepId, stepsInGroup] of stepsByPlanStepId) {
      if (renderedPlanStepIds.has(planStepId)) continue;
      planStepGroups.push({
        planStepId,
        description: "执行工具",
        status: isFailed ? "failed"
          : isCancelled ? "cancelled"
            : stepsInGroup.some((step) => step.status === "failed") ? "failed"
              : stepsInGroup.some((step) => step.status === "cancelled") ? "cancelled"
                : stepsInGroup.some((step) => step.status === "running" || step.status === "pending") ? "running"
                  : "completed",
        steps: stepsInGroup,
      });
    }
    if (unnamedSteps.length > 0) {
      planStepGroups.push({
        planStepId: "_live",
        description: "执行工具",
        status: isFailed ? "failed" : isCancelled ? "cancelled" : "running",
        steps: unnamedSteps,
      });
    }
  } else if (steps.length > 0) {
    const activeIndex = plan.findIndex((step) => step.status === "running" || step.status === "blocked" || step.status === "paused");
    const activeStepId = activeIndex >= 0 ? plan[activeIndex]?.id : undefined;
    const currentPlanDesc = activeStepId ? plan.find((step) => step.id === activeStepId)?.description ?? "执行工具" : "执行工具";
    planStepGroups.push({
      planStepId: activeStepId ?? "_live",
      description: currentPlanDesc,
      status: isFailed ? "failed" : isCancelled ? "cancelled" : "running",
      steps,
    });
  }

  return {
    id: "live-tail",
    planStepGroups,
    summary,
    markdownOutput: output,
    contentBlocks,
    subagentRuns: visibleSubagentRuns,
    status: isCancelled
      ? "cancelled"
      : isFailed || visibleSubagentRuns.some((run) => run.status === "failed")
        ? "failed"
        : visibleSubagentRuns.some((run) => run.status === "cancelled")
          ? "cancelled"
          : steps.some((step) => step.status === "running")
              || visibleSubagentRuns.some((run) => run.status === "running" || run.status === "queued")
              || isActivePhase
            ? "running"
            : "completed",
  };
}
