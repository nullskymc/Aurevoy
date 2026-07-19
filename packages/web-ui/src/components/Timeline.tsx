/**
 * Timeline — 三层式步骤时间轴组件。
 *
 * 将 Agent 的工具调用与计划步骤重组为：
 *   顶层（Summary） → 中层（Steps） → 底层（Details）
 *
 * 支持历史回看与实时执行两种模式。
 */
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, MotionConfig } from "framer-motion";
import type {
  ContentBlock,
  Message,
  MessageToolCall,
  PlanStep,
  SubagentRole,
  SubagentRun,
} from "@aurevoy/shared";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { usePlatform } from "../platform/context";
import { t } from "../i18n";
import { ContextMenu } from "./ContextMenu";
import type { ContextMenuItem } from "./ContextMenu";
import {
  buildFileMenuItems,
  buildLinkMenuItems,
  contextMenuPoint,
  type ContextMenuState,
} from "./contextMenuActions";
import { getPlanStepStatusLabel, mapPlanStepGroupStatus, type PlanUiStatus } from "./planStatus";
import {
  IconAlertCircle,
  IconBot,
  IconChevron,
  IconClock,
  IconExternal,
  IconFile,
  IconGlobe,
  IconLoader,
  IconPencil,
  IconTerminal,
} from "../icons";
import "./Timeline.css";

/* ============ 类型定义 ============ */

/** 步骤类型标签，用于 badge 区分 */
export type StepKind =
  | "command" | "file_read" | "file_write" | "search"
  | "browse" | "think" | "api" | "edit" | "artifact" | "other";

/** 单个 timeline 步骤（对应一个工具调用） */
export interface TimelineStepData {
  id: string;
  kind: StepKind;
  title: string;
  status: "pending" | "running" | "success" | "failed";
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

/** 按计划步骤分组的工具调用集合 */
export interface PlanStepGroupData {
  planStepId: string;
  description: string;
  status: PlanUiStatus;
  /** Shown when plan step is blocked/paused */
  blockedReason?: string;
  steps: TimelineStepData[];
}

/** 一轮 Agent 回复的完整 timeline 呈现数据 */
export interface AgentRoundData {
  id: string;
  planStepGroups: PlanStepGroupData[];
  summary: string;
  markdownOutput?: string;
  contentBlocks?: ContentBlock[];
  subagentRuns?: SubagentRun[];
  status: "pending" | "running" | "completed" | "failed" | "blocked";
}

/* ============ 工具函数 ============ */

/**
 * 按稳定 ID 合并内嵌内容块。
 *
 * SSE 重放、历史恢复和实时尾巴可能在不同路径重复携带同一个块；
 * 渲染前统一收敛，避免 React key 冲突，同时保留最后一次 upsert 的内容。
 */
export function dedupeContentBlocks(blocks: ContentBlock[] | undefined): ContentBlock[] {
  if (!blocks || blocks.length < 2) return blocks ?? [];
  const byId = new Map<string, ContentBlock>();
  for (const block of blocks) {
    byId.set(block.id, block);
  }
  return [...byId.values()];
}

/** 从工具名推断步骤类型 */
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

function shouldHideToolFromWorkflow(toolName: string): boolean {
  return toolName === "attach_content" || toolName === "delegate";
}

/** 生成聚合摘要文本 */
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
  for (const [label, count] of Object.entries(counts)) {
    parts.push(`${count} 个${label}`);
  }
  if (parts.length === 0) return "";
  return `执行了 ${parts.join("，")}`;
}

/** 从 MessageToolCall 构建 TimelineStepData[] */
function buildStepsFromToolCalls(
  toolCalls: MessageToolCall[],
  resultMap: Map<string, { ok: boolean; output?: unknown; error?: string }>,
): TimelineStepData[] {
  return toolCalls.filter((tc) => !shouldHideToolFromWorkflow(tc.function.name)).map((tc) => {
    const kind = detectStepKind(tc.function.name);
    let args: Record<string, unknown> = {};
    try {
      args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch { /* ignore */ }
    const title = buildStepTitle(tc.function.name, args);
    const result = resultMap.get(tc.id);
    const status: TimelineStepData["status"] = result
      ? (result.ok ? "success" : "failed")
      : "success";
    const logs = extractLogContent(tc.function.name, result);
    const error = result && !result.ok ? (result.error ?? "执行失败") : undefined;
    return {
      id: tc.id,
      kind,
      title,
      status,
      planStepId: tc.function.planStepId,
      logs,
      output: result?.output != null ? formatOutput(result.output) : undefined,
      error,
      toolName: tc.function.name,
      rawOutput: result?.output,
    };
  });
}

/** 从步骤构建标题 */
function buildStepTitle(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "execute_command" || toolName === "bash") {
    const cmd = typeof args.command === "string" ? args.command : "";
    const commandArgs = Array.isArray(args.args)
      ? (args.args as unknown[]).map(String).join(" ")
      : "";
    return truncateTitle([cmd, commandArgs].filter(Boolean).join(" ")) || "";
  }
  if (toolName === "replace_lines" || toolName === "edit_lines" || toolName === "edit") {
    const path = typeof args.path === "string" ? args.path : "";
    const startLine = typeof args.start_line === "number" ? args.start_line : null;
    const endLine = typeof args.end_line === "number" ? args.end_line : null;
    if (path && startLine != null && endLine != null) {
      return truncateTitle(`${path} L${startLine}-${endLine}`);
    }
    return truncateTitle(path) || "";
  }
  if (toolName === "write_file" || toolName === "write") {
    const path = typeof args.path === "string" ? args.path : "";
    return truncateTitle(path) || "";
  }
  if (toolName === "append_file") {
    const path = typeof args.path === "string" ? args.path : "";
    return truncateTitle(path) || "";
  }
  if (toolName === "session_open") {
    const path = typeof args.path === "string" ? args.path : "";
    return truncateTitle(path) || "";
  }
  if (toolName === "session_write" || toolName === "session_close" || toolName === "session_abort") {
    const sid = typeof args.session_id === "string" ? args.session_id.slice(0, 8) : "";
    return sid || "";
  }
  if (toolName === "open_file" || toolName === "read") {
    const path = typeof args.path === "string" ? args.path : "";
    const line = typeof args.line_number === "number" ? args.line_number : null;
    if (path && line != null) return truncateTitle(`${path} :${line}`);
    return truncateTitle(path) || "";
  }
  if (toolName === "scroll") {
    const file = typeof args.file === "string" ? args.file : "";
    const dir = typeof args.direction === "string" ? args.direction : "";
    return file ? truncateTitle(`${file} ${dir}`) : "";
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
     typeof args.Query === "string" ? args.Query :
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

function truncateTitle(s: string, max = 55): string {
  return s.length > max ? s.slice(0, max - 2) + "…" : s;
}

/** 提取日志内容 */
function extractLogContent(
  toolName: string,
  result?: { ok: boolean; output?: unknown; error?: string },
): string | undefined {
  if (!result) return undefined;
  if (toolName === "execute_command") {
    const out = result.output;
    if (typeof out === "string") return out;
    if (typeof out === "object" && out !== null) {
      const record = out as Record<string, unknown>;
      return [record.stdout, record.stderr].filter(Boolean).join("\n");
    }
    return undefined;
  }
  if (toolName === "read_file" || toolName === "open_file" || toolName === "scroll" || toolName === "read") {
    const out = result.output;
    if (typeof out === "string") return out.slice(0, 2000);
    if (typeof out === "object" && out !== null) {
      const record = out as Record<string, unknown>;
      if (typeof record.text === "string") return record.text.slice(0, 2000);
      if (typeof record.content === "string") return record.content.slice(0, 2000);
    }
    return undefined;
  }
  if (toolName === "search_grep" || toolName === "search_files" || toolName === "grep" || toolName === "glob") {
    const out = result.output;
    if (typeof out === "string") return out.slice(0, 2000);
    if (typeof out === "object" && out !== null) {
      const record = out as Record<string, unknown>;
      const matches = record.matches;
      if (Array.isArray(matches)) {
        return matches.slice(0, 20).map((m: Record<string, unknown>) =>
          `${m.file}:${m.line}: ${m.content}`).join("\n");
      }
    }
    return undefined;
  }
  if (toolName === "replace_lines" || toolName === "edit_lines" || toolName === "write_file" || toolName === "append_file" || toolName === "edit_file" || toolName === "create_file" || toolName === "write") {
    const out = result.output;
    if (typeof out === "object" && out !== null) {
      const record = out as Record<string, unknown>;
      const parts: string[] = [];
      if (typeof record.bytes_written === "number") parts.push(`写入 ${record.bytes_written} 字节`);
      if (typeof record.replaced_lines === "number") parts.push(`替换 ${record.replaced_lines} 行 → ${record.new_lines_count} 行`);
      if (typeof record.note === "string") parts.push(record.note);
      if (record.preview && Array.isArray(record.preview)) {
        const previewText = record.preview
          .slice(0, 15)
          .map((p: Record<string, unknown>) => `${p.changed ? "+ " : "  "}${String(p.lineNumber).padStart(5)} | ${p.content}`)
          .join("\n");
        parts.push(previewText);
      }
      if (parts.length > 0) return parts.join("\n");
    }
    return undefined;
  }
  return undefined;
}

function formatOutput(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

function resolveHistoricalSubagentRuns(
  toolCalls: MessageToolCall[],
  resultMap: Map<string, { ok: boolean; output?: unknown; error?: string }>,
  persistedRuns: SubagentRun[],
  createdAt: string,
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
    const role = normalizeSubagentRole(output?.role ?? args.role);
    const error = !completed
      ? (typeof output?.result === "string" ? output.result : result?.error)
      : undefined;
    runs.push({
      id: typeof output?.runId === "string" ? output.runId : `legacy-${call.id}`,
      parentCallId: call.id,
      role,
      goal: typeof args.goal === "string" ? args.goal : "委托子任务",
      status: completed ? "completed" : "failed",
      currentActivity: completed ? "已完成并返回结果" : error ?? "子代理运行失败",
      activities: [],
      iterations: typeof output?.iterations === "number" ? output.iterations : 0,
      toolCallCount: typeof output?.toolCallCount === "number" ? output.toolCallCount : 0,
      maxIterations: typeof args.maxIterations === "number" ? args.maxIterations : undefined,
      stopReason: typeof output?.stopReason === "string"
        ? output.stopReason as SubagentRun["stopReason"]
        : completed ? "completed" : "error",
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
    activity.status === "error"
      ? "failed"
      : activity.status === "ok"
        ? "completed"
        : activity.status === "running"
          ? "running"
          : "queued";
  return {
    id: `pending-${activity.id}`,
    parentCallId: activity.id,
    role: normalizeSubagentRole(args.role),
    goal: typeof args.goal === "string" ? args.goal : "准备委托子任务",
    status,
    currentActivity:
      activity.progress?.message
      ?? (status === "running" ? "子智能体执行中" : status === "completed" ? "已完成" : "正在创建子智能体"),
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

/* ============ 数据构建函数 ============ */

/** 从历史消息构建 AgentRoundData */
export function buildAgentRoundFromMessage(
  message: Message,
  resultMap: Map<string, { ok: boolean; output?: unknown; error?: string }>,
  planSteps: PlanStep[],
  persistedSubagentRuns: SubagentRun[] = [],
): AgentRoundData {
  const toolCalls = message.toolCalls ?? [];
  const steps = buildStepsFromToolCalls(toolCalls, resultMap);
  const summary = computeSummaryFromSteps(steps);
  const subagentRuns = resolveHistoricalSubagentRuns(
    toolCalls,
    resultMap,
    persistedSubagentRuns,
    message.createdAt,
  );

  // 按 planStepId 分组
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

  // 有 named group 时：按 task.plan 顺序遍历，填充步骤
  if (groupsByPlanStepId.size > 0) {
    const renderedPlanStepIds = new Set<string>();
    for (const ps of planSteps) {
      const stepsInGroup = groupsByPlanStepId.get(ps.id) ?? [];
      if (stepsInGroup.length === 0) continue;
      renderedPlanStepIds.add(ps.id);
      const toolFailed = stepsInGroup.some((step) => step.status === "failed");
      planStepGroups.push({
        planStepId: ps.id,
        description: ps.description,
        status: mapPlanStepGroupStatus(ps.status, toolFailed),
        blockedReason: ps.blockedReason,
        steps: stepsInGroup,
      });
    }
    for (const [planStepId, stepsInGroup] of groupsByPlanStepId) {
      if (renderedPlanStepIds.has(planStepId)) continue;
      planStepGroups.push({
        planStepId,
        description: "执行工具",
        status: stepsInGroup.some((step) => step.status === "failed") ? "failed" : "completed",
        steps: stepsInGroup,
      });
    }
  }

  // 回退：未分组步骤放一个默认组
  if (unnamedSteps.length > 0) {
    planStepGroups.push({
      planStepId: "_default",
      description: "执行任务",
      status: "completed",
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
    status: steps.some((step) => step.status === "failed")
      || subagentRuns.some((run) => run.status === "failed" || run.status === "cancelled")
      ? "failed"
      : "completed",
  };
}

/** 从 SSE 实时数据 AgentRunningTimeline（即 ToolActivity[]）构建 AgentRoundData */
export function buildLiveAgentRoundData(params: {
  plan: PlanStep[];
  liveToolActivity: { id: string; name: string; args: unknown; status: string; planStepId?: string; output?: unknown; error?: string; progress?: { message: string; chunk?: { current: number; total: number }; percent?: number } }[];
  output?: string;
  phase?: string | null;
  contentBlocks?: ContentBlock[];
  subagentRuns?: SubagentRun[];
}): AgentRoundData {
  const { plan, liveToolActivity, output, phase, contentBlocks, subagentRuns = [] } = params;
  const delegateActivities = liveToolActivity.filter((activity) => activity.name === "delegate");
  const delegateCallIds = new Set(delegateActivities.map((activity) => activity.id));
  const visibleSubagentRuns = subagentRuns.filter((run) => delegateCallIds.has(run.parentCallId));
  for (const activity of delegateActivities) {
    if (visibleSubagentRuns.some((run) => run.parentCallId === activity.id)) continue;
    visibleSubagentRuns.push(subagentRunFromLiveActivity(activity));
  }
  const steps: TimelineStepData[] = liveToolActivity.filter((act) => !shouldHideToolFromWorkflow(act.name)).map((act) => {
    const kind = detectStepKind(act.name);
    const args = typeof act.args === "object" && act.args !== null
      ? act.args as Record<string, unknown>
      : {};
    const rawStatus = act.status;
    const status: TimelineStepData["status"] =
      rawStatus === "ok" ? "success"
      : rawStatus === "error" ? "failed"
      : rawStatus === "awaiting" ? "pending"
      : "running";
    return {
      id: act.id,
      kind,
      title: buildStepTitle(act.name, args),
      status,
      planStepId: act.planStepId,
      logs: extractLogContent(act.name, act.status !== "running" ? { ok: act.status === "ok", output: act.output, error: act.error } : undefined),
      error: act.error,
      output: act.output != null ? formatOutput(act.output) : undefined,
      rawOutput: act.output,
      args,
      toolName: act.name,
      progress: act.progress,
    };
  });

  const summary = computeSummaryFromSteps(steps) || "";

  // 优先按 per-tool planStepId 分组，无 planStepId 时回退到按活跃 step 分组
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
  const isFailed = phase === "failed" || phase === "cancelled";
  const isActivePhase = phase === "thinking" || phase === "planning" || phase === "initializing";

  if (stepsByPlanStepId.size > 0) {
    const renderedPlanStepIds = new Set<string>();
    for (const ps of plan) {
      const stepsInGroup = stepsByPlanStepId.get(ps.id) ?? [];
      if (stepsInGroup.length === 0) continue;
      renderedPlanStepIds.add(ps.id);
      const toolFailed = stepsInGroup.some((step) => step.status === "failed");
      planStepGroups.push({
        planStepId: ps.id,
        description: ps.description,
        status: mapPlanStepGroupStatus(ps.status, toolFailed, isFailed),
        blockedReason: ps.blockedReason,
        steps: stepsInGroup,
      });
    }
    for (const [planStepId, stepsInGroup] of stepsByPlanStepId) {
      if (renderedPlanStepIds.has(planStepId)) continue;
      planStepGroups.push({
        planStepId,
        description: "执行工具",
        status: isFailed ? "failed"
          : stepsInGroup.some((step) => step.status === "failed") ? "failed"
          : stepsInGroup.some((step) => step.status === "running" || step.status === "pending") ? "running"
          : "completed",
        steps: stepsInGroup,
      });
    }
    if (unnamedSteps.length > 0) {
      planStepGroups.push({
        planStepId: "_live",
        description: "执行工具",
        status: isFailed ? "failed" : "running",
        steps: unnamedSteps,
      });
    }
  } else if (steps.length > 0) {
    const activeIndex = plan.findIndex(
      (s) => s.status === "running" || s.status === "blocked" || s.status === "paused",
    );
    const activeStepId = activeIndex >= 0 ? plan[activeIndex]?.id : undefined;
    const currentPlanDesc = activeStepId
      ? plan.find((s) => s.id === activeStepId)?.description ?? "执行工具"
      : "执行工具";
    planStepGroups.push({
      planStepId: activeStepId ?? "_live",
      description: currentPlanDesc,
      status: isFailed ? "failed" : "running",
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
    status: isFailed || visibleSubagentRuns.some((run) => run.status === "failed" || run.status === "cancelled")
      ? "failed"
      : (steps.some((s) => s.status === "running")
        || visibleSubagentRuns.some((run) => run.status === "running" || run.status === "queued")
        || isActivePhase)
        ? "running"
        : "completed",
  };
}

/* ============ 组件 ============ */

/** 步骤状态图标组件 */
function StepStatus({ status }: { status: TimelineStepData["status"] }) {
  if (status === "running") return <span className="timeline-step-status is-running">运行中</span>;
  if (status === "failed") return <span className="timeline-step-status is-failed">失败</span>;
  return null;
}

function StepGlyph({ step }: { step: TimelineStepData }) {
  if (step.status === "running") {
    return (
      <span className="timeline-step-glyph is-running" aria-hidden="true">
        <IconLoader size={15} />
      </span>
    );
  }
  if (step.kind === "search" || step.kind === "browse") {
    return (
      <span className="timeline-step-glyph" aria-hidden="true">
        <IconGlobe size={15} />
      </span>
    );
  }
  if (step.status === "failed") {
    return (
      <span className="timeline-step-glyph is-failed" aria-hidden="true">
        <IconAlertCircle size={15} />
      </span>
    );
  }
  return (
    <span className="timeline-step-glyph" aria-hidden="true">
      <IconClock size={15} />
    </span>
  );
}

function stepDisplayLabel(step: TimelineStepData): string {
  if (step.toolName === "web_search" || step.toolName === "search_grep" || step.toolName === "grep" || step.toolName === "glob") return "Searched";
  if (step.toolName === "web_fetch") return "Fetched URL";
  if (step.kind === "browse") return "Opened page";
  if (step.kind === "file_read") return "Read file";
  if (step.kind === "file_write") return "Wrote file";
  if (step.kind === "edit") return "Edited file";
  if (step.kind === "command") return "Ran command";
  return step.toolName ?? "Ran tool";
}

/** 单个 Timeline 步骤（旧树形详情；主路径已改为扁平 process list） */
function TimelineStepNode({
  step,
  defaultOpen,
  autoOpenRunning = true,
  onAutoCollapse,
}: {
  step: TimelineStepData;
  defaultOpen?: boolean;
  autoOpenRunning?: boolean;
  onAutoCollapse?: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen ?? (autoOpenRunning && step.status === "running"));
  const prevStatusRef = useRef(step.status);

  // Context menu
  const [ctxMenu, setCtxMenu] = useState<{
    open: boolean;
    point?: { x: number; y: number };
    items: ContextMenuItem[];
  }>({ open: false, items: [] });

  function handleStepContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = [
      {
        type: "item",
        id: "copy-title",
        label: "复制标题",
        action: () => navigator.clipboard.writeText(step.title).catch(() => {}),
      },
      ...(step.toolName
        ? [
            {
              type: "item" as const,
              id: "copy-tool-name",
              label: "复制工具名",
              action: () => navigator.clipboard.writeText(step.toolName!).catch(() => {}),
            },
          ]
        : []),
      ...(step.args && Object.keys(step.args).length > 0
        ? [
            {
              type: "item" as const,
              id: "copy-args",
              label: "复制参数",
              action: () =>
                navigator.clipboard
                  .writeText(JSON.stringify(step.args, null, 2))
                  .catch(() => {}),
            },
          ]
        : []),
      ...(step.output
        ? [
            {
              type: "item" as const,
              id: "copy-output",
              label: "复制输出",
              action: () => navigator.clipboard.writeText(step.output!).catch(() => {}),
            },
          ]
        : []),
      ...(step.error
        ? [
            {
              type: "item" as const,
              id: "copy-error",
              label: "复制错误信息",
              action: () => navigator.clipboard.writeText(step.error!).catch(() => {}),
            },
          ]
        : []),
    ];
    setCtxMenu({
      open: true,
      point: contextMenuPoint(e),
      items,
    });
  }

  // 自动展开/折叠逻辑
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = step.status;
    if (autoOpenRunning && step.status === "running") {
      setOpen(true);
    } else if (prev === "running" && (step.status === "success" || step.status === "failed")) {
      // 刚完成：短暂停留后折叠（成功）或保持展开（失败）
      if (step.status === "success") {
        const timer = setTimeout(() => {
          setOpen(false);
          onAutoCollapse?.();
        }, 800);
        return () => clearTimeout(timer);
      }
      // 失败保持展开
    }
  }, [autoOpenRunning, step.status]);

  const hasDetails = step.logs != null || step.error != null || step.output != null || (step.status === "running" && step.progress != null);
  const searchPreview = buildSearchPreview(step);

  return (
    <motion.div
      className="timeline-step"
      data-status={step.status}
      onContextMenu={handleStepContextMenu}
      variants={{
        hidden: { opacity: 0, y: -8 },
        show: { opacity: 1, y: 0 },
      }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      layout
    >
      <div className="timeline-step-header">
        <StepGlyph step={step} />
        <button
          type="button"
          className="timeline-step-title-btn"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className="timeline-step-tool">{stepDisplayLabel(step)}</span>
          {step.title && <span className="timeline-step-title">{step.title}</span>}
            <StepStatus status={step.status} />
          {hasDetails && (
            <span className="timeline-step-caret" data-open={open}>
              <IconChevron size={10} />
            </span>
          )}
        </button>
      </div>

      <AnimatePresence initial={false}>
        {open && hasDetails && (
          <motion.div
            className="timeline-step-details"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ height: { duration: 0.2, ease: "easeOut" }, opacity: { duration: 0.12 } }}
          >
            {searchPreview ? (
              <SearchPreviewView preview={searchPreview} />
            ) : step.logs ? (
              <div className="timeline-step-log">
                <pre>{step.logs}</pre>
              </div>
            ) : step.output ? (
              <div className="timeline-step-log">
                <pre>{step.output}</pre>
              </div>
            ) : null}
            {step.error && (
              <div className="timeline-step-error">
                <IconAlertCircle size={12} />
                <span>{step.error}</span>
              </div>
            )}
            {step.status === "running" && step.progress && (
              <div className="timeline-step-log is-running">
                <div className="timeline-step-progress">
                  {step.progress.percent != null ? (
                    <div className="progress-bar">
                      <div className="progress-bar-fill" style={{ width: `${step.progress.percent}%` }} />
                    </div>
                  ) : (
                    <span className="stream-caret" />
                  )}
                  <span className="progress-text">{step.progress.message}</span>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <ContextMenu
        items={ctxMenu.items}
        open={ctxMenu.open}
        anchorPoint={ctxMenu.point}
        onClose={() => setCtxMenu((p) => ({ ...p, open: false }))}
      />
    </motion.div>
  );
}

interface SearchPreviewResult {
  title: string;
  url: string;
  snippet?: string;
  host: string;
}

interface SearchPreviewData {
  query: string;
  resultCount: number;
  results: SearchPreviewResult[];
}

function buildSearchPreview(step: TimelineStepData): SearchPreviewData | null {
  if (step.toolName !== "web_search") return null;
  const source = normalizeSearchOutput(step.rawOutput ?? step.output);
  if (!source) return null;
  const query = source.query || (typeof step.args?.query === "string" ? step.args.query : "");
  const results = source.results.slice(0, 6).map((item) => ({
    title: item.title,
    url: item.url,
    snippet: item.snippet,
    host: hostFromUrl(item.url),
  }));
  return {
    query,
    resultCount: source.resultCount || source.results.length,
    results,
  };
}

function normalizeSearchOutput(value: unknown): { query: string; resultCount: number; results: SearchPreviewResult[] } | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const rawResults = Array.isArray(record.results) ? record.results : [];
  const results = rawResults
    .map((item): SearchPreviewResult | null => {
      if (!item || typeof item !== "object") return null;
      const result = item as Record<string, unknown>;
      const title = typeof result.title === "string" ? result.title : "";
      const url = typeof result.url === "string" ? result.url : typeof result.link === "string" ? result.link : "";
      if (!title || !url) return null;
      const snippet = typeof result.snippet === "string"
        ? result.snippet
        : typeof result.content === "string"
          ? result.content
          : undefined;
      return { title, url, snippet, host: hostFromUrl(url) };
    })
    .filter((item): item is SearchPreviewResult => item !== null);
  return {
    query: typeof record.query === "string" ? record.query : "",
    resultCount: typeof record.resultCount === "number" ? record.resultCount : results.length,
    results,
  };
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function SearchPreviewView({ preview }: { preview: SearchPreviewData }) {
  const platform = usePlatform();
  return (
    <div className="timeline-search-preview">
      <div className="timeline-search-head">
        <span className="timeline-search-query">{preview.query || "web search"}</span>
        <span className="timeline-search-count">{preview.resultCount} result{preview.resultCount === 1 ? "" : "s"}</span>
      </div>
      {preview.results.length > 0 ? (
        <div className="timeline-search-results">
          {preview.results.map((result, index) => (
            <a
              key={`${result.url}-${index}`}
              className="timeline-search-result"
              href={result.url}
              title={result.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => {
                event.preventDefault();
                void platform.openExternal?.(result.url);
              }}
            >
              <span className="timeline-search-favicon" aria-hidden="true">{result.host.slice(0, 1).toUpperCase()}</span>
              <span className="timeline-search-result-main">
                <span className="timeline-search-result-title">{result.title}</span>
                {result.snippet && <span className="timeline-search-snippet">{result.snippet}</span>}
              </span>
              <span className="timeline-search-host">{result.host}</span>
            </a>
          ))}
        </div>
      ) : (
        <div className="timeline-search-empty">No results</div>
      )}
    </div>
  );
}

/** @deprecated 主对话不再渲染树形分组；保留供可选详细模式 */
export function PlanStepGroup({
  group,
  isLast,
  defaultOpen,
  autoOpenRunningTools = true,
  onStepAutoCollapse,
}: {
  group: PlanStepGroupData;
  index: number;
  isLast: boolean;
  defaultOpen?: boolean;
  autoOpenRunningTools?: boolean;
  onStepAutoCollapse?: () => void;
}) {
  const runningCount = group.steps.filter((s) => s.status === "running").length;
  const failedCount = group.steps.filter((s) => s.status === "failed").length;
  const doneCount = group.steps.filter((s) => s.status === "success").length;

  const stepContainerVariants = {
    hidden: {},
    show: { transition: { staggerChildren: 0.06 } },
  };

  const statusText =
    group.status === "blocked"
      ? getPlanStepStatusLabel("blocked")
      : runningCount > 0
        ? `${t("plan.step.running")} ${runningCount}`
        : failedCount > 0
          ? `${t("plan.step.failed")} ${failedCount}`
          : group.status === "pending"
            ? t("plan.step.pending")
            : `${t("plan.step.completed")} ${doneCount}`;

  return (
    <motion.div
      className="timeline-plan-group"
      data-status={group.status}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      layout
    >
      {/* 计划步骤描述行 */}
      <div className="timeline-plan-head">
        <span className="timeline-plan-connector" />
        {group.description && (
          <span className="timeline-plan-desc">
            {group.description}
            <span className="timeline-plan-count">
              <span
                className={
                  group.status === "failed" || group.status === "blocked"
                    ? `timeline-plan-status-text is-${group.status}`
                    : "timeline-plan-status-text"
                }
              >
                {statusText}
              </span>
            </span>
          </span>
        )}
      </div>
      {group.blockedReason ? (
        <p className="timeline-plan-blocked-reason" role="status">
          {group.blockedReason}
        </p>
      ) : null}

      {/* 步骤列表 */}
      {group.steps.length > 0 && (
        <motion.div
          className="timeline-plan-steps"
          variants={stepContainerVariants}
          initial="hidden"
          animate="show"
        >
          {group.steps.map((step) => (
            <TimelineStepNode
              key={step.id}
              step={step}
              defaultOpen={defaultOpen}
              autoOpenRunning={autoOpenRunningTools}
              onAutoCollapse={onStepAutoCollapse}
            />
          ))}
        </motion.div>
      )}

      {/* 分组尾部连接线 */}
      {!isLast && <div className="timeline-plan-trail" />}
    </motion.div>
  );
}

/* ============ 内容块渲染 ============ */

/** Agent 通过 attach_content 工具附加的富内容块。 */
function ContentBlockView({
  block,
  onOpenWorkspacePath,
}: {
  block: ContentBlock;
  /** 在侧边工作台打开文件预览（attach_content 默认行为） */
  onOpenWorkspacePath?: (path: string) => void;
}) {
  const platform = usePlatform();
  const [feedback, setFeedback] = useState<string | null>(null);

  const showFeedback = (msg: string) => {
    setFeedback(msg);
    setTimeout(() => setFeedback(null), 2000);
  };

  // Context menu for file_reference blocks
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>({ open: false, items: [] });

  function handleFileContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({
      open: true,
      point: contextMenuPoint(e),
      items: buildFileMenuItems({
        path: block.content,
        name: block.name,
        platform,
      }),
    });
  }

  function handleLinkContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({
      open: true,
      point: contextMenuPoint(e),
      items: buildLinkMenuItems({
        url: block.content,
        label: block.name,
        platform,
      }),
    });
  }

  switch (block.type) {
    case "file_reference": {
      const handleFileClick = async () => {
        if (onOpenWorkspacePath) {
          onOpenWorkspacePath(block.content);
          showFeedback(t("workbench.openedInSidebar"));
          return;
        }
        try {
          if (platform.openFile) {
            await platform.openFile(block.content);
            showFeedback("已打开");
            return;
          }
        } catch { /* 平台不支持打开文件，回退到复制路径 */ }
        try {
          await navigator.clipboard.writeText(block.content);
          showFeedback("已复制路径");
        } catch {
          showFeedback("无法打开文件");
        }
      };
      return (
        <>
          <div
            className={`content-block is-file ${feedback ? "is-active" : ""}`}
            onClick={handleFileClick}
            onContextMenu={handleFileContextMenu}
            title={block.content}
          >
            <IconFile className="content-block-icon" size={16} />
            <span className="content-block-name">
              {block.name || block.content.split("/").pop() || block.content}
            </span>
            <span className="content-block-path">
              {feedback || block.content}
            </span>
          </div>
          <ContextMenu
            items={ctxMenu.items}
            open={ctxMenu.open}
            anchorPoint={ctxMenu.point}
            onClose={() => setCtxMenu((p) => ({ ...p, open: false }))}
          />
        </>
      );
    }
    case "image": {
      const src = platform.filePathToUrl(block.content);
      if (!src) return null;
      return (
        <>
          <div
            className="content-block is-image"
            onClick={() => onOpenWorkspacePath?.(block.content)}
            onContextMenu={handleFileContextMenu}
            title={block.content}
            role={onOpenWorkspacePath ? "button" : undefined}
          >
            <img
              src={src}
              alt={block.name || "agent image"}
              className="content-block-image"
            />
            {block.name && <span className="content-block-caption">{block.name}</span>}
          </div>
          <ContextMenu
            items={ctxMenu.items}
            open={ctxMenu.open}
            anchorPoint={ctxMenu.point}
            onClose={() => setCtxMenu((p) => ({ ...p, open: false }))}
          />
        </>
      );
    }
    case "link": {
      return (
        <>
          <a
          className="content-block is-link"
          href={block.content}
          onClick={(event) => {
            event.preventDefault();
            void platform.openExternal?.(block.content);
          }}
          onContextMenu={handleLinkContextMenu}
          target="_blank"
          rel="noopener noreferrer"
        >
          <IconExternal className="content-block-icon" size={14} />
          <span>{block.name || block.content}</span>
        </a>
          <ContextMenu
            items={ctxMenu.items}
            open={ctxMenu.open}
            anchorPoint={ctxMenu.point}
            onClose={() => setCtxMenu((p) => ({ ...p, open: false }))}
          />
        </>
      );
    }
    default:
      return null;
  }
}
/* ============ 子代理元数据（扁平活动行用） ============ */

const SUBAGENT_ROLE_META: Record<SubagentRole, { label: string }> = {
  explore: { label: "侦查" },
  research: { label: "调研" },
  coder: { label: "编码" },
  shell: { label: "验证" },
  writer: { label: "写作" },
  general: { label: "通用" },
};

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return "<1s";
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/* ============ 过程呈现（Codex 语法：live 状态流 + 完成后扁平列表） ============ */

export type ProcessActivityRow = {
  id: string;
  kind: "tool" | "subagent" | "group";
  /** 展示用行为摘要（如「已搜索网页」），不是原始 tool 名 */
  label: string;
  status: "pending" | "running" | "success" | "failed";
  /** 工具原始 title / 命令预览 */
  detail?: string;
  /** 行图标语义：search / browse / command / file / edit / agent / other */
  icon?: "search" | "browse" | "command" | "file" | "edit" | "agent" | "other";
};

/**
 * 将同一 conversation turn 内多条 assistant 过程 round 合并为一条，
 * 避免界面叠多个「已处理」。
 */
export function mergeAgentRoundData(
  rounds: AgentRoundData[],
  mergedId = "turn-process",
): AgentRoundData | null {
  const nonempty = rounds.filter(
    (round) =>
      round.planStepGroups.some((g) => g.steps.length > 0) ||
      (round.subagentRuns?.length ?? 0) > 0,
  );
  if (nonempty.length === 0) return null;

  const planStepGroups: PlanStepGroupData[] = [];
  const subagentRuns: SubagentRun[] = [];
  const seenSubagentIds = new Set<string>();
  const seenStepIds = new Set<string>();
  let status: AgentRoundData["status"] = "completed";

  for (const round of nonempty) {
    for (const group of round.planStepGroups) {
      const steps = group.steps.filter((step) => {
        if (seenStepIds.has(step.id)) return false;
        seenStepIds.add(step.id);
        return true;
      });
      if (steps.length === 0) continue;
      planStepGroups.push({
        ...group,
        planStepId: `${group.planStepId}__${planStepGroups.length}`,
        steps,
        status: steps.some((s) => s.status === "failed")
          ? "failed"
          : steps.some((s) => s.status === "running" || s.status === "pending")
            ? "running"
            : "completed",
      });
    }
    for (const run of round.subagentRuns ?? []) {
      if (seenSubagentIds.has(run.id)) continue;
      seenSubagentIds.add(run.id);
      subagentRuns.push(run);
    }
    if (round.status === "failed") status = "failed";
    else if (round.status === "running" && status !== "failed") status = "running";
    else if (round.status === "pending" && status === "completed") status = "pending";
  }

  const allSteps = planStepGroups.flatMap((g) => g.steps);
  if (allSteps.length === 0 && subagentRuns.length === 0) return null;

  return {
    id: mergedId,
    planStepGroups,
    summary: computeSummaryFromSteps(allSteps),
    // 过程合并块不带交付正文（交付由 delivery 面单独渲染）
    markdownOutput: undefined,
    contentBlocks: undefined,
    subagentRuns: subagentRuns.length > 0 ? subagentRuns : undefined,
    status:
      status === "failed" ||
      allSteps.some((s) => s.status === "failed") ||
      subagentRuns.some((r) => r.status === "failed" || r.status === "cancelled")
        ? "failed"
        : status === "running" || allSteps.some((s) => s.status === "running")
          ? "running"
          : "completed",
  };
}

/** 将 AgentRoundData 压成扁平活动行（完成后列表 / 测试用）。 */
export function flattenProcessActivityRows(data: AgentRoundData): ProcessActivityRow[] {
  const rows: ProcessActivityRow[] = [];
  const steps = data.planStepGroups.flatMap((group) => group.steps);
  const commandSteps = steps.filter((s) => s.kind === "command" || s.toolName === "execute_command" || s.toolName === "bash");
  const otherSteps = steps.filter((s) => !commandSteps.includes(s));

  if (commandSteps.length > 1) {
    rows.push({
      id: `group-commands-${data.id}`,
      kind: "group",
      label: `运行了多个命令`,
      status: commandSteps.some((s) => s.status === "failed")
        ? "failed"
        : commandSteps.some((s) => s.status === "running" || s.status === "pending")
          ? "running"
          : "success",
    });
    for (const step of commandSteps) {
      rows.push(toolStepToActivityRow(step, true));
    }
  } else {
    for (const step of commandSteps) {
      rows.push(toolStepToActivityRow(step, false));
    }
  }

  for (const step of otherSteps) {
    if (step.toolName === "delegate") continue;
    rows.push(toolStepToActivityRow(step, false));
  }

  for (const run of data.subagentRuns ?? []) {
    rows.push(subagentToActivityRow(run));
  }

  return rows;
}

function toolStepToActivityRow(step: TimelineStepData, underGroup: boolean): ProcessActivityRow {
  const title = step.title?.trim() || "";
  const running = step.status === "running" || step.status === "pending";
  const failed = step.status === "failed";
  const { label, icon } = describeActivityStep(step.kind, title, running, failed, underGroup);
  return {
    id: step.id,
    kind: "tool",
    label,
    icon,
    status: failed ? "failed" : running ? "running" : step.status === "pending" ? "pending" : "success",
    detail: title,
  };
}

/** 将工具步骤收成「一段时间的行为总结」文案（Codex：已搜索网页 / 已运行 cmd）。 */
export function describeActivityStep(
  kind: StepKind,
  title: string,
  running: boolean,
  failed: boolean,
  underGroup = false,
): { label: string; icon: ProcessActivityRow["icon"] } {
  const detail = title.trim();
  const withDetail = (base: string) => (detail ? `${base} (${detail})` : base);

  if (kind === "search") {
    if (failed) return { label: withDetail("搜索网页失败"), icon: "search" };
    if (running) return { label: detail ? `正在搜索网页 · ${detail}` : "正在搜索网页", icon: "search" };
    return { label: withDetail("已搜索网页"), icon: "search" };
  }
  if (kind === "browse") {
    if (failed) return { label: withDetail("浏览网页失败"), icon: "browse" };
    if (running) return { label: detail ? `正在浏览 · ${detail}` : "正在浏览网页", icon: "browse" };
    return { label: withDetail("已浏览网页"), icon: "browse" };
  }
  if (kind === "command") {
    if (failed) return { label: withDetail("命令失败"), icon: "command" };
    if (running) return { label: detail ? `正在运行 ${detail}` : "正在运行命令", icon: "command" };
    if (underGroup) return { label: detail ? `已运行 ${detail}` : "已运行命令", icon: "command" };
    return { label: detail ? `已运行 ${detail}` : "已运行命令", icon: "command" };
  }
  if (kind === "file_read") {
    if (failed) return { label: withDetail("读取失败"), icon: "file" };
    if (running) return { label: detail ? `正在读取 ${detail}` : "正在读取文件", icon: "file" };
    return { label: detail ? `已读取 ${detail}` : "已读取文件", icon: "file" };
  }
  if (kind === "file_write") {
    if (failed) return { label: withDetail("写入失败"), icon: "file" };
    if (running) return { label: detail ? `正在写入 ${detail}` : "正在写入文件", icon: "file" };
    return { label: detail ? `已写入 ${detail}` : "已写入文件", icon: "file" };
  }
  if (kind === "edit") {
    if (failed) return { label: withDetail("编辑失败"), icon: "edit" };
    if (running) return { label: detail ? `正在编辑 ${detail}` : "正在编辑文件", icon: "edit" };
    return { label: detail ? `已编辑 ${detail}` : "已编辑文件", icon: "edit" };
  }
  if (failed) return { label: withDetail("步骤失败"), icon: "other" };
  if (running) return { label: detail ? `正在处理 · ${detail}` : "正在处理", icon: "other" };
  return { label: detail ? `已完成 · ${detail}` : "已完成一步", icon: "other" };
}

function subagentToActivityRow(run: SubagentRun): ProcessActivityRow {
  const role = SUBAGENT_ROLE_META[run.role]?.label ?? run.role;
  const running = run.status === "running" || run.status === "queued";
  const failed = run.status === "failed" || run.status === "cancelled";
  const goalShort = run.goal?.trim()
    ? run.goal.trim().length > 40
      ? `${run.goal.trim().slice(0, 40)}…`
      : run.goal.trim()
    : "";
  // 一行一个子代理；live 与完成后抽屉共用同一套文案
  let label: string;
  if (running) {
    if (run.currentActivity?.trim() && !/创建|准备委托|子智能体执行中/i.test(run.currentActivity)) {
      label = goalShort
        ? `${role} · ${truncateTitle(run.currentActivity.trim(), 36)}`
        : run.currentActivity.trim();
    } else {
      label = goalShort ? `运行子智能体 · ${role}：${goalShort}` : `运行子智能体 · ${role}`;
    }
  } else if (failed) {
    label = goalShort ? `子智能体失败 · ${role}：${goalShort}` : `子智能体失败 · ${role}`;
  } else {
    label = goalShort ? `已创建子智能体 · ${role}：${goalShort}` : `已创建子智能体 · ${role}`;
  }
  return {
    id: run.id,
    kind: "subagent",
    label,
    icon: "agent",
    status: failed ? "failed" : running ? "running" : "success",
    detail: run.currentActivity || run.goal,
  };
}

/**
 * live 状态行：一段时间的行为摘要（灰字），不是工具卡标题。
 * 优先级：子代理活动 → 工具 progress / 行为文案 → phaseDetail（非 delegate 噪音）→ 正在思考
 */
export function resolveLiveStatusText(params: {
  phaseDetail?: string;
  data: AgentRoundData;
}): string {
  const runningSubs = (params.data.subagentRuns ?? []).filter(
    (r) => r.status === "running" || r.status === "queued",
  );
  if (runningSubs.length > 1) {
    return `创建中 ${runningSubs.length} 个智能体`;
  }
  const runningSub = runningSubs[0];
  if (runningSub) {
    const role = SUBAGENT_ROLE_META[runningSub.role]?.label ?? runningSub.role;
    if (runningSub.currentActivity?.trim()) {
      const act = normalizeLiveStatus(runningSub.currentActivity) ?? runningSub.currentActivity.trim();
      // 仍是创建阶段的文案时，带上角色
      if (/创建|准备委托|子智能体执行中/i.test(act)) {
        return runningSub.goal
          ? `子智能体 · ${role}：${truncateTitle(runningSub.goal, 40)}`
          : `子智能体 · ${role} 执行中`;
      }
      return act;
    }
    return runningSub.goal
      ? `子智能体 · ${role}：${truncateTitle(runningSub.goal, 40)}`
      : `子智能体 · ${role} 执行中`;
  }

  const runningStep = params.data.planStepGroups
    .flatMap((g) => g.steps)
    .find((s) => s.status === "running" || s.status === "pending");
  if (runningStep) {
    if (runningStep.progress?.message?.trim()) {
      return normalizeLiveStatus(runningStep.progress.message) ?? runningStep.progress.message.trim();
    }
    const { label } = describeActivityStep(
      runningStep.kind,
      runningStep.title?.trim() || "",
      true,
      false,
    );
    return label;
  }

  const phase = normalizeLiveStatus(params.phaseDetail);
  // 忽略「调用工具 delegate」这类泄漏工具名的 phase 文案
  if (phase && !isBareDelegatePhaseDetail(phase)) return phase;

  // 流式 markdown 走打字机正文，不占用灰字状态行（避免与交付重复）
  return "正在思考";
}

function isBareDelegatePhaseDetail(text: string): boolean {
  return /^调用工具\s*delegate\b/i.test(text.trim())
    || /^calling tool\s*delegate\b/i.test(text.trim());
}

/** 去掉 "Agent " 前缀等产品噪音，保留行为描述 */
export function normalizeLiveStatus(raw?: string | null): string | null {
  if (!raw) return null;
  let text = raw.trim();
  if (!text) return null;
  text = text.replace(/^Agent\s+/i, "");
  if (/^(thinking|模型思考|思考中)/i.test(text)) return "正在思考";
  if (isBareDelegatePhaseDetail(text)) return null;
  return text;
}

/**
 * 完成后摘要标签。无可靠 duration 时不编造秒数。
 * durationMs 仅在调用方确有真实计时数据时传入。
 */
export function formatProcessedSummaryLabel(params: {
  stepCount?: number;
  subagentCount?: number;
  durationMs?: number | null;
  failed?: boolean;
}): string {
  const parts: string[] = ["已处理"];
  if (params.durationMs != null && params.durationMs > 0 && Number.isFinite(params.durationMs)) {
    parts.push(formatDuration(params.durationMs));
  }
  return parts.join(" ");
}

function ProcessActivityIcon({ icon }: { icon?: ProcessActivityRow["icon"] }) {
  if (icon === "search" || icon === "browse") {
    return <IconGlobe size={14} />;
  }
  if (icon === "agent") {
    return <IconBot size={14} />;
  }
  if (icon === "command") {
    return <IconTerminal size={14} />;
  }
  if (icon === "file") {
    return <IconFile size={14} />;
  }
  if (icon === "edit") {
    return <IconPencil size={14} />;
  }
  return <span aria-hidden="true">·</span>;
}

function LiveStatusLine({ text }: { text: string }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={text}
        className="process-live-status"
        role="status"
        aria-live="polite"
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
      >
        {text}
      </motion.div>
    </AnimatePresence>
  );
}

/**
 * Live 过程块：
 *   已处理 10s
 *   ────────
 *   运行子智能体 · 调研：…   ← 每个子代理一行，SSE 全程保留
 *   正在搜索网页…            ← 无活动行时的灰字回落
 */
function LiveProcessBlock({
  statusText,
  activityRows = [],
  startedAtMs,
  showFallbackStatus = true,
}: {
  statusText: string;
  /** 子代理/工具活动行；有则全程展示，完成后由抽屉收纳同一套 rows */
  activityRows?: ProcessActivityRow[];
  startedAtMs?: number | null;
  /** 无 activityRows 时是否显示灰字状态（有打字机正文时可关） */
  showFallbackStatus?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAtMs == null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAtMs]);

  const durationMs =
    startedAtMs != null && Number.isFinite(startedAtMs)
      ? Math.max(0, now - startedAtMs)
      : null;
  const header = formatProcessedSummaryLabel({ durationMs });
  const hasRows = activityRows.length > 0;

  return (
    <div
      className="process-live-block"
      data-process="live"
      data-status-visible={hasRows || showFallbackStatus ? "true" : "false"}
    >
      <div className="process-summary-static">{header}</div>
      <div className="process-summary-rule is-always" aria-hidden="true" />
      {hasRows ? <ProcessActivityList rows={activityRows} live /> : null}
      {!hasRows && showFallbackStatus ? <LiveStatusLine text={statusText} /> : null}
    </div>
  );
}

function ProcessActivityList({
  rows,
  live = false,
}: {
  rows: ProcessActivityRow[];
  /** live 列表不折叠，始终展开 */
  live?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <ul
      className="process-activity-list"
      data-live={live ? "true" : undefined}
      aria-label="执行过程"
    >
      {rows.map((row) => (
        <li
          key={row.id}
          className="process-activity-row"
          data-kind={row.kind}
          data-status={row.status}
          data-icon={row.icon}
        >
          <span className="process-activity-icon" aria-hidden="true">
            <ProcessActivityIcon icon={row.icon} />
          </span>
          <span className="process-activity-label">{row.label}</span>
        </li>
      ))}
    </ul>
  );
}

function CompletedProcess({
  data,
  defaultOpen = false,
  durationMs,
}: {
  data: AgentRoundData;
  defaultOpen?: boolean;
  durationMs?: number | null;
}) {
  const rows = flattenProcessActivityRows(data);
  const stepCount = data.planStepGroups.reduce((acc, g) => acc + g.steps.length, 0);
  const subagentCount = data.subagentRuns?.length ?? 0;
  if (rows.length === 0 && stepCount === 0 && subagentCount === 0) return null;

  const [open, setOpen] = useState(defaultOpen);
  const label = formatProcessedSummaryLabel({
    stepCount,
    subagentCount,
    durationMs,
    failed: data.status === "failed",
  });

  return (
    <div className="process-completed" data-status={data.status} data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="process-summary-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="process-summary-label">{label}</span>
        <span className="process-summary-caret" data-open={open ? "true" : "false"} aria-hidden="true">
          ▾
        </span>
      </button>
      <div className="process-summary-rule is-always" aria-hidden="true" />
      {open && <ProcessActivityList rows={rows} />}
    </div>
  );
}

/**
 * AgentRound — 单轮 Agent 呈现。
 * live：状态流（无工具卡时间轴）；完成后：可展开扁平活动列表 + 裸 Markdown 交付。
 */
export function AgentRound({
  data,
  busy = false,
  defaultToolDetailsOpen = false,
  showWorkflow = true,
  showOutput = true,
  phaseDetail,
  /** live 计时起点（ms epoch）；缺省不显示秒数 */
  processStartedAtMs,
  /** 完成后的耗时（ms） */
  processDurationMs,
  onOpenWorkspacePath,
}: {
  data: AgentRoundData;
  busy?: boolean;
  defaultToolDetailsOpen?: boolean;
  showWorkflow?: boolean;
  showOutput?: boolean;
  phaseDetail?: string;
  processStartedAtMs?: number | null;
  processDurationMs?: number | null;
  onOpenWorkspacePath?: (path: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stepCount = data.planStepGroups.reduce((acc, g) => acc + g.steps.length, 0);
  const subagentRuns = data.subagentRuns ?? [];
  const hasProcess = stepCount > 0 || subagentRuns.length > 0;
  const liveStatusText = resolveLiveStatusText({ phaseDetail, data });
  const hasRunningTools = data.planStepGroups
    .flatMap((g) => g.steps)
    .some((s) => s.status === "running" || s.status === "pending");
  const hasRunningSubagents = subagentRuns.some(
    (r) => r.status === "running" || r.status === "queued",
  );
  // 工具/子代理进行中：只保留灰字行为摘要；空闲思考/收尾：打字机流式正文
  const suppressBusyDelivery = busy && (hasRunningTools || hasRunningSubagents);
  const streamText = data.markdownOutput?.trim() ?? "";
  const showDelivery = showOutput && streamText.length > 0 && !suppressBusyDelivery;

  const outputNode = showDelivery ? (
    <article className={`timeline-output process-delivery${busy ? " is-streaming" : ""}`}>
      <div className="doc-body process-delivery-body">
        <MarkdownRenderer content={data.markdownOutput!} onOpenWorkspacePath={onOpenWorkspacePath} />
        {busy ? <span className="stream-caret" aria-hidden="true" /> : null}
      </div>
    </article>
  ) : null;

  const contentBlocks = dedupeContentBlocks(data.contentBlocks);
  const contentBlocksNode = showOutput && contentBlocks.length > 0 ? (
    <div className="content-blocks">
      {contentBlocks.map((block) => (
        <ContentBlockView
          key={block.id}
          block={block}
          onOpenWorkspacePath={onOpenWorkspacePath}
        />
      ))}
    </div>
  ) : null;

  // 与完成后抽屉同一套扁平行：每个子代理一行，工具行同列；live 全程展开
  const activityRows = flattenProcessActivityRows(data);

  const processNode = showWorkflow ? (
    busy ? (
      <LiveProcessBlock
        statusText={liveStatusText}
        activityRows={activityRows}
        startedAtMs={processStartedAtMs}
        // 已有活动行时不靠灰字；无行且未在打字机交付时显示「正在思考」等
        showFallbackStatus={!showDelivery && activityRows.length === 0}
      />
    ) : hasProcess ? (
      <CompletedProcess
        data={data}
        defaultOpen={defaultToolDetailsOpen}
        durationMs={processDurationMs}
      />
    ) : null
  ) : null;

  // live：状态在前；完成后：摘要在交付之前（与 Codex 一致）
  return (
    <MotionConfig reducedMotion="user">
      <div
        ref={containerRef}
        className={`timeline-agent-round process-agent-round ${busy ? "is-live" : ""} ${data.status === "failed" ? "is-failed" : ""}`}
        data-status={data.status}
        data-process={busy ? "live" : hasProcess ? "completed" : "none"}
      >
        {processNode}
        {outputNode}
        {contentBlocksNode}
      </div>
    </MotionConfig>
  );
}
