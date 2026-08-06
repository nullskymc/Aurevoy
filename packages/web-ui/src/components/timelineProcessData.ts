import type { SubagentRole, SubagentRun } from "@aurevoy/shared";
import { t } from "../i18n";
import {
  computeSummaryFromSteps,
  truncateTitle,
  type AgentRoundData,
  type PlanStepGroupData,
  type StepKind,
  type TimelineStepData,
} from "./timelineData";

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
  status: "pending" | "running" | "success" | "failed" | "cancelled";
  /** 工具原始 title / 命令预览 */
  detail?: string;
  /** 行图标语义：search / browse / command / file / edit / agent / other */
  icon?: "search" | "browse" | "command" | "file" | "edit" | "agent" | "other";
};

/** 完成态中的有序过程段：保留 assistant 说明与其发起的工具活动之间的绑定。 */
export interface ProcessSegmentData {
  id: string;
  narration?: string;
  activityRows: ProcessActivityRow[];
}

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
        status: group.status === "failed" || steps.some((s) => s.status === "failed")
          ? "failed"
          : group.status === "cancelled" || steps.some((s) => s.status === "cancelled")
            ? "cancelled"
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
    else if (round.status === "cancelled" && status !== "failed") status = "cancelled";
    else if (round.status === "running" && status !== "failed" && status !== "cancelled") status = "running";
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
      subagentRuns.some((r) => r.status === "failed")
        ? "failed"
        : status === "cancelled" ||
          allSteps.some((s) => s.status === "cancelled") ||
          subagentRuns.some((r) => r.status === "cancelled")
          ? "cancelled"
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
        : commandSteps.some((s) => s.status === "cancelled")
          ? "cancelled"
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
  const cancelled = step.status === "cancelled";
  const { label, icon } = step.summary?.trim()
    ? describeBackendToolSummary(step.kind, step.summary, running, failed, cancelled)
    : describeActivityStep(step.kind, title, running, failed, underGroup, step.toolName, cancelled);
  return {
    id: step.id,
    kind: "tool",
    label,
    icon,
    status: failed ? "failed" : cancelled ? "cancelled" : running ? "running" : step.status === "pending" ? "pending" : "success",
    detail: title,
  };
}

/** 将后端状态无关摘要转换成当前时态，避免前端再次理解每个工具的参数 schema。 */
function describeBackendToolSummary(
  kind: StepKind,
  summary: string,
  running: boolean,
  failed: boolean,
  cancelled: boolean,
): { label: string; icon: ProcessActivityRow["icon"] } {
  const detail = summary.trim();
  const icon = activityIconForKind(kind);
  if (failed) return { label: `${detail}失败`, icon };
  if (cancelled) return { label: `${detail}已取消`, icon };
  if (running) return { label: `正在${detail}`, icon };
  return { label: `已${detail}`, icon };
}

function activityIconForKind(kind: StepKind): ProcessActivityRow["icon"] {
  if (kind === "search") return "search";
  if (kind === "browse") return "browse";
  if (kind === "command") return "command";
  if (kind === "file_read" || kind === "file_write") return "file";
  if (kind === "edit") return "edit";
  return "other";
}

/** 将工具步骤收成「一段时间的行为总结」文案（Codex：已搜索网页 / 已运行 cmd）。 */
export function describeActivityStep(
  kind: StepKind,
  title: string,
  running: boolean,
  failed: boolean,
  underGroup = false,
  toolName?: string,
  cancelled = false,
): { label: string; icon: ProcessActivityRow["icon"] } {
  const detail = title.trim();
  const withDetail = (base: string) => (detail ? `${base} (${detail})` : base);

  if (kind === "search") {
    if (failed) return { label: withDetail("搜索网页失败"), icon: "search" };
    if (cancelled) return { label: withDetail("搜索网页已取消"), icon: "search" };
    if (running) return { label: detail ? `正在搜索网页 · ${detail}` : "正在搜索网页", icon: "search" };
    return { label: withDetail("已搜索网页"), icon: "search" };
  }
  if (kind === "browse") {
    if (failed) return { label: withDetail("浏览网页失败"), icon: "browse" };
    if (cancelled) return { label: withDetail("浏览网页已取消"), icon: "browse" };
    if (running) return { label: detail ? `正在浏览 · ${detail}` : "正在浏览网页", icon: "browse" };
    return { label: withDetail("已浏览网页"), icon: "browse" };
  }
  if (kind === "command") {
    if (failed) return { label: withDetail("命令失败"), icon: "command" };
    if (cancelled) return { label: withDetail("命令已取消"), icon: "command" };
    if (running) return { label: detail ? `正在运行 ${detail}` : "正在运行命令", icon: "command" };
    if (underGroup) return { label: detail ? `已运行 ${detail}` : "已运行命令", icon: "command" };
    return { label: detail ? `已运行 ${detail}` : "已运行命令", icon: "command" };
  }
  if (kind === "file_read") {
    if (failed) return { label: withDetail("读取失败"), icon: "file" };
    if (cancelled) return { label: withDetail("读取已取消"), icon: "file" };
    if (running) return { label: detail ? `正在读取 ${detail}` : "正在读取文件", icon: "file" };
    return { label: detail ? `已读取 ${detail}` : "已读取文件", icon: "file" };
  }
  if (kind === "file_write") {
    if (failed) return { label: withDetail("写入失败"), icon: "file" };
    if (cancelled) return { label: withDetail("写入已取消"), icon: "file" };
    if (running) return { label: detail ? `正在写入 ${detail}` : "正在写入文件", icon: "file" };
    return { label: detail ? `已写入 ${detail}` : "已写入文件", icon: "file" };
  }
  if (kind === "edit") {
    if (failed) return { label: withDetail("编辑失败"), icon: "edit" };
    if (cancelled) return { label: withDetail("编辑已取消"), icon: "edit" };
    if (running) return { label: detail ? `正在编辑 ${detail}` : "正在编辑文件", icon: "edit" };
    return { label: detail ? `已编辑 ${detail}` : "已编辑文件", icon: "edit" };
  }
  if (failed) return { label: withDetail("步骤失败"), icon: "other" };
  if (cancelled) return { label: withDetail("步骤已取消"), icon: "other" };
  if (running) return { label: detail ? `正在处理 · ${detail}` : "正在处理", icon: "other" };
  const fallbackTool = toolName ? humanizeToolName(toolName) : "";
  return { label: detail ? `已完成 · ${detail}` : fallbackTool ? `已运行 ${fallbackTool}` : "已完成一步", icon: "other" };
}

function humanizeToolName(toolName: string): string {
  if (toolName.startsWith("mcp_")) {
    const parts = toolName.slice(4).split("_");
    const server = parts.shift() ?? "";
    if (parts[0] === server) parts.shift();
    const action = parts.join(" ");
    return [server, action].filter(Boolean).join(" · ");
  }
  return toolName.replace(/[_-]+/g, " ").trim();
}

function subagentToActivityRow(run: SubagentRun): ProcessActivityRow {
  const role = SUBAGENT_ROLE_META[run.role]?.label ?? run.role;
  const running = run.status === "running" || run.status === "queued";
  const failed = run.status === "failed";
  const cancelled = run.status === "cancelled";
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
  } else if (cancelled) {
    label = goalShort ? `子智能体已取消 · ${role}：${goalShort}` : `子智能体已取消 · ${role}`;
  } else {
    label = goalShort ? `已创建子智能体 · ${role}：${goalShort}` : `已创建子智能体 · ${role}`;
  }
  const budgetBits = [
    run.maxIterations ? `${run.iterations}/${run.maxIterations} 轮` : `${run.iterations} 轮`,
    run.maxWallMs ? `${Math.round((run.durationMs ?? 0) / 1000)}/${Math.round(run.maxWallMs / 1000)}s` : undefined,
    run.tokenUsage ? `${run.tokenUsage.toLocaleString()} tokens` : undefined,
  ].filter(Boolean).join(" · ");
  return {
    id: run.id,
    kind: "subagent",
    label,
    icon: "agent",
    status: failed ? "failed" : cancelled ? "cancelled" : running ? "running" : "success",
    detail: [run.currentActivity || run.goal, budgetBits].filter(Boolean).join(" · "),
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
    const { label } = runningStep.summary?.trim()
      ? describeBackendToolSummary(runningStep.kind, runningStep.summary, true, false, false)
      : describeActivityStep(
          runningStep.kind,
          runningStep.title?.trim() || "",
          true,
          false,
          false,
          runningStep.toolName,
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
  cancelled?: boolean;
}): string {
  const parts: string[] = [params.cancelled ? t("status.cancelled") : t("timeline.processed")];
  if (params.durationMs != null && params.durationMs > 0 && Number.isFinite(params.durationMs)) {
    parts.push(formatDuration(params.durationMs));
  }
  return parts.join(" ");
}

/** 实时过程必须明确处于进行态；只有完成后的折叠摘要才使用“已处理”。 */
export function formatProcessingSummaryLabel(durationMs?: number | null): string {
  const parts = [t("timeline.processing")];
  if (durationMs != null && durationMs > 0 && Number.isFinite(durationMs)) {
    parts.push(formatDuration(durationMs));
  }
  return parts.join(" ");
}
