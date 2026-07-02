/**
 * Timeline — 三层式步骤时间轴组件。
 *
 * 将 Agent 的工具调用与计划步骤重组为：
 *   顶层（Summary） → 中层（Steps） → 底层（Details）
 *
 * 支持历史回看与实时执行两种模式。
 */
import { useEffect, useRef, useState } from "react";
import type {
  ContentBlock,
  Message,
  MessageToolCall,
  PlanStep,
} from "@aurevoy/shared";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { usePlatform } from "../platform/context";
import { ThinkingCard } from "./ThinkingTimeline";
import { ContextMenu } from "./ContextMenu";
import type { ContextMenuItem } from "./ContextMenu";

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
  status: "pending" | "running" | "completed" | "failed";
  steps: TimelineStepData[];
}

/** 一轮 Agent 回复的完整 timeline 呈现数据 */
export interface AgentRoundData {
  id: string;
  planStepGroups: PlanStepGroupData[];
  summary: string;
  reasoning?: string;
  markdownOutput?: string;
  contentBlocks?: ContentBlock[];
  status: "pending" | "running" | "completed" | "failed";
}

/* ============ 工具函数 ============ */

/** 从工具名推断步骤类型 */
export function detectStepKind(toolName: string): StepKind {
  if (toolName === "execute_command" || toolName === "bash") return "command";
  if (toolName === "read_file" || toolName === "open_file" || toolName === "scroll" || toolName === "read") return "file_read";
  if (toolName === "write_file" || toolName === "create_file" || toolName === "append_file" || toolName === "session_open" || toolName === "session_write" || toolName === "session_close" || toolName === "session_abort" || toolName === "write") return "file_write";
  if (toolName === "edit_file" || toolName === "apply_diff" || toolName === "replace_lines" || toolName === "edit_lines" || toolName === "edit") return "edit";
  if (toolName === "web_search" || toolName === "search_grep" || toolName === "search_files" || toolName === "grep" || toolName === "glob") return "search";
  if (toolName === "create_artifact" || toolName === "apply_artifact") return "artifact";
  if (toolName.startsWith("browser_")) return "browse";
  if (toolName.startsWith("mcp_")) return "api";
  return "other";
}

/** Badge 标签文本映射 */
const BADGE_LABELS: Record<StepKind, string> = {
  command: "Cmd",
  file_read: "File",
  file_write: "Write",
  search: "Search",
  browse: "Web",
  think: "Think",
  api: "API",
  edit: "Edit",
  artifact: "Art",
  other: "Tool",
};

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
  return toolCalls.map((tc) => {
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
    return truncateTitle([cmd, commandArgs].filter(Boolean).join(" ")) || (toolName === "bash" ? "bash" : "执行命令");
  }
  if (toolName === "replace_lines" || toolName === "edit_lines") {
    const path = typeof args.path === "string" ? args.path : "";
    const startLine = typeof args.start_line === "number" ? args.start_line : null;
    const endLine = typeof args.end_line === "number" ? args.end_line : null;
    if (path && startLine != null && endLine != null) {
      return truncateTitle(`${path} L${startLine}-${endLine}`);
    }
    return truncateTitle(path) || "edit_lines";
  }
  if (toolName === "write_file") {
    const path = typeof args.path === "string" ? args.path : "";
    return `write: ${truncateTitle(path)}` || "write_file";
  }
  if (toolName === "append_file") {
    const path = typeof args.path === "string" ? args.path : "";
    return `append: ${truncateTitle(path)}` || "append_file";
  }
  if (toolName === "session_open") {
    const path = typeof args.path === "string" ? args.path : "";
    return `session: ${truncateTitle(path)}` || "session_open";
  }
  if (toolName === "session_write" || toolName === "session_close" || toolName === "session_abort") {
    const sid = typeof args.session_id === "string" ? args.session_id.slice(0, 8) : "";
    return `${toolName} ${sid}`;
  }
  if (toolName === "open_file") {
    const path = typeof args.path === "string" ? args.path : "";
    const line = typeof args.line_number === "number" ? args.line_number : null;
    if (path && line != null) return truncateTitle(`${path} :${line}`);
    return truncateTitle(path) || "open_file";
  }
  if (toolName === "scroll") {
    const file = typeof args.file === "string" ? args.file : "";
    const dir = typeof args.direction === "string" ? args.direction : "";
    return file ? truncateTitle(`${file} ${dir}`) : "scroll";
  }
  if (toolName === "search_grep") {
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    return pattern ? `grep: ${truncateTitle(pattern)}` : "search_grep";
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
    return query ? `搜索：${truncateTitle(query)}` : "搜索";
  }
  return toolName;
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
  if (toolName === "read_file" || toolName === "open_file" || toolName === "scroll") {
    const out = result.output;
    if (typeof out === "string") return out.slice(0, 2000);
    if (typeof out === "object" && out !== null) {
      const record = out as Record<string, unknown>;
      if (typeof record.text === "string") return record.text.slice(0, 2000);
    }
    return undefined;
  }
  if (toolName === "search_grep" || toolName === "search_files") {
    const out = result.output;
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
  if (toolName === "replace_lines" || toolName === "edit_lines" || toolName === "write_file" || toolName === "append_file" || toolName === "edit_file" || toolName === "create_file") {
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

/* ============ 数据构建函数 ============ */

/** 从历史消息构建 AgentRoundData */
export function buildAgentRoundFromMessage(
  message: Message,
  resultMap: Map<string, { ok: boolean; output?: unknown; error?: string }>,
  planSteps: PlanStep[],
): AgentRoundData {
  const toolCalls = message.toolCalls ?? [];
  const steps = buildStepsFromToolCalls(toolCalls, resultMap);
  const summary = computeSummaryFromSteps(steps);

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
    for (const ps of planSteps) {
      const stepsInGroup = groupsByPlanStepId.get(ps.id) ?? [];
      if (stepsInGroup.length === 0) continue;
      planStepGroups.push({
        planStepId: ps.id,
        description: ps.description,
        status: ps.status === "completed" ? "completed"
          : ps.status === "failed" ? "failed"
          : "completed",
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
    reasoning: message.reasoningContent,
    markdownOutput: message.content,
    contentBlocks: message.contentBlocks,
    status: "completed",
  };
}

/** 从 SSE 实时数据 AgentRunningTimeline（即 ToolActivity[]）构建 AgentRoundData */
export function buildLiveAgentRoundData(params: {
  plan: PlanStep[];
  liveToolActivity: { id: string; name: string; args: unknown; status: string; planStepId?: string; output?: unknown; error?: string; progress?: { message: string; chunk?: { current: number; total: number }; percent?: number } }[];
  output?: string;
  reasoning?: string;
  phase?: string | null;
  contentBlocks?: ContentBlock[];
}): AgentRoundData {
  const { plan, liveToolActivity, output, reasoning, phase, contentBlocks } = params;
  const steps: TimelineStepData[] = liveToolActivity.map((act) => {
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
      args,
      toolName: act.name,
      progress: act.progress,
    };
  });

  const summary = computeSummaryFromSteps(steps);

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

  if (stepsByPlanStepId.size > 0) {
    for (const ps of plan) {
      const stepsInGroup = stepsByPlanStepId.get(ps.id) ?? [];
      if (stepsInGroup.length === 0 && !unnamedSteps.length) continue;
      planStepGroups.push({
        planStepId: ps.id,
        description: ps.description,
        status: ps.status === "completed" ? "completed"
          : ps.status === "failed" ? "failed"
          : isFailed ? "failed"
          : "running",
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
  } else if (steps.length === 0) {
    for (const ps of plan) {
      planStepGroups.push({
        planStepId: ps.id,
        description: ps.description,
        status: ps.status as PlanStepGroupData["status"],
        steps: [],
      });
    }
  } else {
    const activeIndex = plan.findIndex((s) => s.status === "running");
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
    reasoning,
    markdownOutput: output,
    contentBlocks,
    status: isFailed ? "failed" : steps.some((s) => s.status === "running") ? "running" : "completed",
  };
}

/* ============ 组件 ============ */

/** 步骤状态图标组件 */
function StepStatus({ status }: { status: TimelineStepData["status"] }) {
  if (status === "running") return <span className="timeline-step-status is-running">运行中</span>;
  if (status === "failed") return <span className="timeline-step-status is-failed">失败</span>;
  return null;
}

/** Badge 标签 */
function StepBadge({ kind }: { kind: StepKind }) {
  return <span className={`timeline-step-badge is-${kind}`}>
    {BADGE_LABELS[kind] ?? "Tool"}
  </span>;
}

/** 聚合摘要行 */
function AgentRoundSummary({ summary, status, stepCount }: {
  summary: string;
  status: AgentRoundData["status"];
  stepCount: number;
}) {
  if (!summary && stepCount === 0) return null;
  return (
    <div className="timeline-summary">
      <span className="timeline-summary-text">
        {summary || `${stepCount} 个步骤`}
      </span>
      {status === "running" && (
        <span className="timeline-summary-badge is-running">
          <svg viewBox="0 0 12 12" width="10" height="10" className="step-spinner-sm" aria-hidden="true">
            <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5"
              strokeDasharray="14" strokeLinecap="round" />
          </svg>
          执行中
        </span>
      )}
      {status === "failed" && (
        <span className="timeline-summary-badge is-failed">失败</span>
      )}
    </div>
  );
}

/** 单个 Timeline 步骤 */
function TimelineStepNode({
  step,
  defaultOpen,
  onAutoCollapse,
}: {
  step: TimelineStepData;
  defaultOpen?: boolean;
  onAutoCollapse?: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen ?? step.status === "running");
  const prevStatusRef = useRef(step.status);

  // Context menu
  const [ctxMenu, setCtxMenu] = useState<{
    open: boolean;
    rect?: DOMRect;
    items: ContextMenuItem[];
  }>({ open: false, items: [] });

  function handleStepContextMenu(e: React.MouseEvent) {
    e.preventDefault();
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
      rect: e.currentTarget.getBoundingClientRect(),
      items,
    });
  }

  // 自动展开/折叠逻辑
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = step.status;
    if (step.status === "running") {
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
  }, [step.status]);

  const hasDetails = step.logs != null || step.error != null || (step.status === "running" && step.progress != null);

  return (
    <div
      className="timeline-step"
      data-status={step.status}
      onContextMenu={handleStepContextMenu}
    >
      <div className="timeline-step-header">
        <div className="timeline-step-left">
          <StepBadge kind={step.kind} />
        </div>
        <button
          type="button"
          className="timeline-step-title-btn"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className="timeline-step-title">{step.title}</span>
            <StepStatus status={step.status} />
          {hasDetails && (
            <span className="timeline-step-caret" data-open={open}>
              <svg viewBox="0 0 12 12" width="10" height="10" fill="none">
                <path d="M4 3L8 6L4 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          )}
        </button>
      </div>

      {open && hasDetails && (
        <div className="timeline-step-details">
          {step.logs && (
            <div className="timeline-step-log">
              <pre>{step.logs}</pre>
            </div>
          )}
          {step.error && (
            <div className="timeline-step-error">
              <svg viewBox="0 0 14 14" width="12" height="12" fill="none" aria-hidden="true">
                <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.2" />
                <path d="M7 4.5v3M7 9.5v.01" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
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
        </div>
      )}

      <ContextMenu
        items={ctxMenu.items}
        open={ctxMenu.open}
        anchorRect={ctxMenu.rect}
        onClose={() => setCtxMenu((p) => ({ ...p, open: false }))}
      />
    </div>
  );
}

/** 计划步骤分组 */
function PlanStepGroup({
  group,
  isLast,
  defaultOpen,
  onStepAutoCollapse,
}: {
  group: PlanStepGroupData;
  index: number;
  isLast: boolean;
  defaultOpen?: boolean;
  onStepAutoCollapse?: () => void;
}) {
  const runningCount = group.steps.filter((s) => s.status === "running").length;
  const failedCount = group.steps.filter((s) => s.status === "failed").length;
  const doneCount = group.steps.filter((s) => s.status === "success").length;

  return (
    <div className="timeline-plan-group" data-status={group.status}>
      {/* 计划步骤描述行 */}
      <div className="timeline-plan-head">
        <span className="timeline-plan-connector" />
        {group.description && (
          <span className="timeline-plan-desc">
            {group.description}
            {group.steps.length > 0 && (
              <span className="timeline-plan-count">
                {runningCount > 0 ? (
                  <span className="timeline-plan-status-text">执行中 {runningCount}</span>
                ) : failedCount > 0 ? (
                  <span className="timeline-plan-status-text is-failed">失败 {failedCount}</span>
                ) : (
                  <span className="timeline-plan-status-text">完成 {doneCount}</span>
                )}
              </span>
            )}
          </span>
        )}
      </div>

      {/* 步骤列表 */}
      {group.steps.length > 0 && (
        <div className="timeline-plan-steps">
          {group.steps.map((step) => (
            <TimelineStepNode
              key={step.id}
              step={step}
              defaultOpen={defaultOpen}
              onAutoCollapse={onStepAutoCollapse}
            />
          ))}
        </div>
      )}

      {/* 分组尾部连接线 */}
      {!isLast && <div className="timeline-plan-trail" />}
    </div>
  );
}

/* ============ 内容块渲染 ============ */

/** Agent 通过 attach_content 工具附加的富内容块。 */
function ContentBlockView({ block }: { block: ContentBlock }) {
  const platform = usePlatform();
  const [feedback, setFeedback] = useState<string | null>(null);

  const showFeedback = (msg: string) => {
    setFeedback(msg);
    setTimeout(() => setFeedback(null), 2000);
  };

  // Context menu for file_reference blocks
  const [ctxMenu, setCtxMenu] = useState<{
    open: boolean;
    rect?: DOMRect;
    items: ContextMenuItem[];
  }>({ open: false, items: [] });

  function handleFileContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    const filename = block.name || block.content.split("/").pop() || block.content;
    const items: ContextMenuItem[] = [
      {
        type: "item",
        id: "copy-path",
        label: "复制路径",
        action: () => navigator.clipboard.writeText(block.content).catch(() => {}),
      },
      {
        type: "item",
        id: "copy-filename",
        label: "复制文件名",
        action: () => navigator.clipboard.writeText(filename).catch(() => {}),
      },
      ...(platform.openFile
        ? [
            {
              type: "item" as const,
              id: "open-file",
              label: "在系统中打开",
              action: async () => {
                try {
                  await platform.openFile!(block.content);
                  showFeedback("已打开");
                } catch {
                  showFeedback("无法打开文件");
                }
              },
            },
          ]
        : []),
    ];
    setCtxMenu({
      open: true,
      rect: e.currentTarget.getBoundingClientRect(),
      items,
    });
  }

  switch (block.type) {
    case "file_reference": {
      const handleFileClick = async () => {
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
            <svg className="content-block-icon" viewBox="0 0 16 16" width="16" height="16" fill="none">
              <path d="M2 1h7.5L13 4.5V14a1 1 0 01-1 1H2a1 1 0 01-1-1V2a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.2"/>
              <path d="M9 1v3.5H12.5" stroke="currentColor" strokeWidth="1.2"/>
            </svg>
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
            anchorRect={ctxMenu.rect}
            onClose={() => setCtxMenu((p) => ({ ...p, open: false }))}
          />
        </>
      );
    }
    case "image": {
      const src = platform.filePathToUrl(block.content);
      if (!src) return null;
      return (
        <div className="content-block is-image">
          <img
            src={src}
            alt={block.name || "agent image"}
            className="content-block-image"
          />
          {block.name && <span className="content-block-caption">{block.name}</span>}
        </div>
      );
    }
    case "link": {
      return (
        <a
          className="content-block is-link"
          href={block.content}
          target="_blank"
          rel="noopener noreferrer"
        >
          <svg className="content-block-icon" viewBox="0 0 16 16" width="14" height="14" fill="none">
            <path d="M6 2H3a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            <path d="M11 1h4v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            <path d="M15 1L7 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
          <span>{block.name || block.content}</span>
        </a>
      );
    }
    default:
      return null;
  }
}
/* ============ 主组件 ============ */

/**
 * AgentRound — 核心 timeline 组件。
 * 接收 AgentRoundData（可由 buildAgentRoundFromMessage / buildLiveAgentRoundData 生成），
 * 渲染三层式步骤时间轴。
 */
export function AgentRound({
  data,
  busy = false,
  defaultToolDetailsOpen = false,
}: {
  data: AgentRoundData;
  busy?: boolean;
  defaultToolDetailsOpen?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stepCount = data.planStepGroups.reduce((acc, g) => acc + g.steps.length, 0);
  const hasLiveRunning = busy && data.status === "running";

  return (
    <div
      ref={containerRef}
      className={`timeline-agent-round ${busy ? "is-live" : ""} ${data.status === "failed" ? "is-failed" : ""}`}
      data-status={data.status}
    >
      {/* Summary 行 */}
      <AgentRoundSummary
        summary={data.summary}
        status={data.status}
        stepCount={stepCount}
      />

      {/* 推理过程 */}
      {data.reasoning && (
        <ThinkingCard data={{
          id: `reasoning-${data.id}`,
          phase: 1,
          summary: data.reasoning.split('\n')[0]?.trim()?.slice(0, 80) || '',
          fullText: data.reasoning,
          defaultOpen: false,
        }} />
      )}

      {/* 时间线区域 */}
      <div className="timeline-body">
        {data.planStepGroups.length > 0 ? (
          data.planStepGroups.map((group, i) => (
            <PlanStepGroup
              key={group.planStepId}
              group={group}
              index={i}
              isLast={i === data.planStepGroups.length - 1}
              defaultOpen={defaultToolDetailsOpen || group.steps.some((s) => s.status === "running")}
            />
          ))
        ) : (
          /* 无分组时显示空占位 */
          <div className="timeline-empty">
            <span className="timeline-step-icon is-pending" />
            <span>{busy ? "处理中…" : "无执行步骤"}</span>
          </div>
        )}
      </div>

      {/* 流式输出文本 — 流式阶段仅显示加载占位（禁打字机效果），本轮结束时渲染完整 markdown */}
      {data.markdownOutput && (
        <article className={`timeline-output ${hasLiveRunning ? "is-streaming" : ""}`}>
          <div className="doc-meta">
            <span className="doc-meta-icon">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
                <path d="M5 8l2 2 4-4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </span>
            <span>Aurevoy</span>
          </div>
          <div className="doc-body" style={{ paddingLeft: 0 }}>
            {hasLiveRunning ? (
              <span className="stream-placeholder">生成中…</span>
            ) : (
              <MarkdownRenderer content={data.markdownOutput} />
            )}
          </div>
        </article>
      )}

      {/* Agent 附加的富内容块（文件引用/图片/超链接） */}
      {data.contentBlocks && data.contentBlocks.length > 0 && (
        <div className="content-blocks">
          {data.contentBlocks.map((block) => (
            <ContentBlockView key={block.id} block={block} />
          ))}
        </div>
      )}
    </div>
  );
}
