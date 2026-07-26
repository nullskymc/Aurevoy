import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { AgentEvent, ContentBlock, PlanStep, Task, TaskArtifact, TaskPhase, TaskStatus, TaskSummary, TaskTraceEntry } from "@aurevoy/shared";
import { getTask } from "../api";
import { createLiveActivityStore } from "../app/liveActivityStore";
import { createFailureMessage, fetchWithRetry, mergeById } from "../app/taskUtils";
import type { ToolActivity } from "../components/Conversation";

export function useAgentEventHandler({
  closeStream,
  currentTask,
  mergeArtifact,
  patchCurrentTask,
  refreshRuntime,
  refreshSkills,
  refreshTaskTraces,
  setAutoModeState,
  setBusy,
  setCurrentTask,
  setOutput,
  appendOutput,
  setPhase,
  setPlan,
  setStatus,
  setTasks,
  setTraces,
  updateTaskList,
  onAttachedPreviewFiles,
}: {
  closeStream: () => void;
  currentTask: Task | null;
  mergeArtifact: (artifact: TaskArtifact) => void;
  patchCurrentTask: (patch: Partial<Task>) => void;
  refreshRuntime: () => Promise<void>;
  refreshSkills: () => void;
  refreshTaskTraces: (taskId: string) => Promise<void>;
  setAutoModeState: Dispatch<SetStateAction<{ paused?: boolean; pausedReason?: string; autoApprovedCalls?: number } | null>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setCurrentTask: Dispatch<SetStateAction<Task | null>>;
  setOutput: Dispatch<SetStateAction<string>>;
  appendOutput: (delta: string) => void;
  setPhase: Dispatch<SetStateAction<TaskPhase | null>>;
  setPlan: Dispatch<SetStateAction<PlanStep[]>>;
  setStatus: Dispatch<SetStateAction<TaskStatus | null>>;
  setTasks: Dispatch<SetStateAction<TaskSummary[]>>;
  setTraces: Dispatch<SetStateAction<TaskTraceEntry[]>>;
  updateTaskList: (task: Task) => void;
  /** attach_content 的可预览文件：默认在侧边工作台打开 */
  onAttachedPreviewFiles?: (paths: string[]) => void;
}) {
  const liveActivityRef = useRef(createLiveActivityStore());
  const [liveToolActivity, setLiveToolActivity] = useState<ToolActivity[]>([]);
  const [liveContentBlocks, setLiveContentBlocks] = useState<ContentBlock[]>([]);
  const [phaseDetail, setPhaseDetail] = useState("");
  const previousPhaseRef = useRef<TaskPhase | null>(null);
  const nextOutputFreshRef = useRef(false);
  const liveActivitySyncRafRef = useRef<number | null>(null);

  const flushLiveActivity = useCallback((): void => {
    liveActivitySyncRafRef.current = null;
    setLiveToolActivity(liveActivityRef.current.snapshot());
  }, []);

  /** 将多个 SSE 事件触发的 live activity 更新合并到同一帧，避免工具卡片逐个渲染。 */
  const scheduleLiveActivitySync = useCallback((): void => {
    if (liveActivitySyncRafRef.current !== null) return;
    liveActivitySyncRafRef.current = requestAnimationFrame(flushLiveActivity);
  }, [flushLiveActivity]);

  /** 统一清空所有实时/流式状态，避免切换任务时旧状态残留。 */
  const clearLiveState = useCallback((): void => {
    if (liveActivitySyncRafRef.current !== null) {
      cancelAnimationFrame(liveActivitySyncRafRef.current);
      liveActivitySyncRafRef.current = null;
    }
    liveActivityRef.current.clear();
    setLiveToolActivity([]);
    setOutput("");
    setLiveContentBlocks([]);
    setPhaseDetail("");
    nextOutputFreshRef.current = false;
  }, [setOutput]);

  useEffect(
    () => () => {
      if (liveActivitySyncRafRef.current !== null) {
        cancelAnimationFrame(liveActivitySyncRafRef.current);
        liveActivitySyncRafRef.current = null;
      }
    },
    [],
  );

  function handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "task_created":
        setCurrentTask(event.task);
        setPlan(event.task.plan);
        setStatus(event.task.status);
        setPhase(event.task.phase);
        setOutput("");
        setTraces([]);
        updateTaskList(event.task);
        break;
      case "task_title":
        patchCurrentTask({ title: event.title, titleSource: event.source });
        break;
      case "agent_start":
        setStatus("running");
        setPhase("thinking");
        patchCurrentTask({ status: "running", phase: "thinking" });
        break;
      case "scout_started":
        setPhase("planning");
        setPhaseDetail("侦查工作区");
        patchCurrentTask({ phase: "planning" });
        break;
      case "scout_report":
        setPhaseDetail(event.report.summary);
        break;
      case "status":
        setStatus(event.status);
        patchCurrentTask({ status: event.status });
        break;
      case "phase":
        setPhase(event.phase);
        setPhaseDetail(event.detail ?? "");
        patchCurrentTask({ phase: event.phase });
        if (event.phase !== previousPhaseRef.current) {
          const prevPhase = previousPhaseRef.current;
          previousPhaseRef.current = event.phase;
          if (event.phase === "thinking") {
            if (prevPhase === "calling_tool") {
              nextOutputFreshRef.current = true;
            }
            setLiveContentBlocks([]);
          }
        }
        break;
      case "plan":
      case "plan_generated":
        setPlan(event.plan);
        patchCurrentTask({ plan: event.plan });
        break;
      case "step_update":
        setPlan((previous) =>
          previous.map((step) => (step.id === event.step.id ? event.step : step)),
        );
        setCurrentTask((previous) => previous
          ? {
              ...previous,
              plan: previous.plan.map((step) => (step.id === event.step.id ? event.step : step)),
            }
          : previous,
        );
        break;
      case "token":
        if (nextOutputFreshRef.current) {
          setOutput("");
          nextOutputFreshRef.current = false;
        }
        appendOutput(event.delta);
        break;
      case "message_start":
        if (event.role === "assistant") {
          nextOutputFreshRef.current = true;
          setOutput("");
        }
        break;
      case "message": {
        if (event.message.role === "system") break;
        const isAssistant = event.message.role === "assistant";
        const hasToolCalls = (event.message.toolCalls?.length ?? 0) > 0;
        // 终稿无工具：清 live 缓存避免与历史交付重复
        // 过程旁白（有工具）：也清掉，避免旁白残留到下一轮流式/交付区
        if (isAssistant) setOutput("");
        if (isAssistant && hasToolCalls) nextOutputFreshRef.current = true;
        setCurrentTask((previous) => {
          const previousMessages = previous?.messages ?? [];
          if (!previous) return previous;
          const messageIndex = previousMessages.findIndex((message) => message.id === event.message.id);
          const messages = messageIndex >= 0
            ? previousMessages.map((message) => (message.id === event.message.id ? { ...message, ...event.message } : message))
            : [...previousMessages, event.message];
          const nextTask = { ...previous, messages };
          return nextTask;
        });
        if (event.message.contentBlocks?.length) {
          setLiveContentBlocks((prev) => {
            const existingIds = new Set(prev.map((b) => b.id));
            const batchIds = new Set<string>();
            const newBlocks = event.message.contentBlocks!.filter((b) => {
              if (existingIds.has(b.id) || batchIds.has(b.id)) return false;
              batchIds.add(b.id);
              return true;
            });
            return newBlocks.length > 0 ? [...prev, ...newBlocks] : prev;
          });
        }
        scheduleLiveActivitySync();
        break;
      }
      case "tool_call":
        liveActivityRef.current.upsert(event.call.id, {
          name: event.call.toolName,
          args: event.call.args,
          status: "running",
          planStepId: event.call.planStepId,
        });
        scheduleLiveActivitySync();
        break;
      case "tool_progress":
        liveActivityRef.current.upsert(event.callId, {
          progress: { message: event.message, chunk: event.chunk, percent: event.percent },
        });
        scheduleLiveActivitySync();
        break;
      case "subagent_updated":
        setCurrentTask((previous) => {
          if (!previous) return previous;
          const nextTask = {
            ...previous,
            subagentRuns: mergeById(previous.subagentRuns ?? [], event.run),
          };
          return nextTask;
        });
        break;
      case "approval_request":
        liveActivityRef.current.upsert(event.call.id, {
          name: event.call.toolName,
          args: event.call.args,
          status: "awaiting",
          riskLevel: event.riskLevel,
          planStepId: event.call.planStepId,
        });
        scheduleLiveActivitySync();
        setStatus("paused");
        setPhase("waiting_approval");
        setPhaseDetail(`等待确认工具 ${event.call.toolName}`);
        setCurrentTask((previous) => {
          if (!previous) return previous;
          const nextApprovals = [
            ...(previous.pendingApprovals ?? []).filter((item) => item.call.id !== event.call.id),
            { call: event.call, riskLevel: event.riskLevel, createdAt: new Date().toISOString() },
          ];
          const nextTask = {
            ...previous,
            status: "paused" as const,
            phase: "waiting_approval" as const,
            pendingApprovals: nextApprovals,
          };
          updateTaskList(nextTask);
          return nextTask;
        });
        break;
      case "tool_result":
        liveActivityRef.current.upsert(event.result.callId, {
          status: event.result.ok ? "ok" : "error",
          output: event.result.output,
          error: event.result.error,
          errorCode: event.result.errorCode,
        });
        scheduleLiveActivitySync();
        setCurrentTask((previous) => {
          if (!previous) return previous;
          const nextApprovals = (previous.pendingApprovals ?? []).filter((item) => item.call.id !== event.result.callId);
          if (nextApprovals.length === (previous.pendingApprovals ?? []).length) return previous;
          const nextTask = { ...previous, pendingApprovals: nextApprovals };
          return nextTask;
        });
        break;
      case "clarification_request":
      case "clarification_resolved":
        setCurrentTask((previous) => {
          if (!previous) return previous;
          const nextTask = {
            ...previous,
            clarifications: mergeById(previous.clarifications ?? [], event.clarification),
          };
          return nextTask;
        });
        break;
      case "artifact_created":
      case "artifact_updated":
        mergeArtifact(event.artifact);
        break;
      case "content_blocks_added": {
        setCurrentTask((previous) => {
          if (!previous) return previous;
          const previousMessages = previous.messages ?? [];
          const hitIndex = previousMessages.findIndex((msg) => msg.id === event.messageId);
          let messages = previousMessages;
          if (hitIndex >= 0) {
            messages = previousMessages.map((msg, index) =>
              index === hitIndex
                ? { ...msg, contentBlocks: mergeContentBlocks(msg.contentBlocks, event.blocks) }
                : msg,
            );
          } else {
            // messageId 未命中：挂到最近一条 assistant，避免块只活在 live tail、归属错乱
            const next = previousMessages.slice();
            for (let i = next.length - 1; i >= 0; i--) {
              if (next[i].role !== "assistant") continue;
              next[i] = {
                ...next[i],
                contentBlocks: mergeContentBlocks(next[i].contentBlocks, event.blocks),
              };
              messages = next;
              break;
            }
          }
          const nextTask = { ...previous, messages };
          return nextTask;
        });
        // 历史消息已承载这些块时，立刻从 live tail 移除，防止「所有消息底部都挂同一文件卡」
        const blockIds = new Set(event.blocks.map((block) => block.id));
        setLiveContentBlocks((prev) => prev.filter((block) => !blockIds.has(block.id)));
        // attach_content 文件引用：默认在侧边栏打开可预览类型（html/md 等）
        if (onAttachedPreviewFiles) {
          const paths = event.blocks
            .filter((b) => b.type === "file_reference" || b.type === "image")
            .map((b) => b.content)
            .filter((p): p is string => typeof p === "string" && p.trim().length > 0);
          if (paths.length > 0) onAttachedPreviewFiles(paths);
        }
        break;
      }
      case "checkpoint_created":
        setCurrentTask((previous) => {
          if (!previous) return previous;
          const nextTask = {
            ...previous,
            checkpoints: mergeById(previous.checkpoints ?? [], event.checkpoint),
          };
          return nextTask;
        });
        break;
      case "budget_usage":
        patchCurrentTask({
          budgetUsage: event.usage,
          budget: event.budget,
          lifetimeUsage: event.lifetimeUsage,
          lifetimeBudget: event.lifetimeBudget,
        });
        break;
      case "budget_exceeded":
        setStatus("paused");
        setPhase("waiting_budget");
        setPhaseDetail(event.info.reason);
        patchCurrentTask({
          status: "paused",
          phase: "waiting_budget",
          budgetExceeded: event.info,
          budgetUsage: event.info.runUsage,
          lifetimeUsage: event.info.lifetimeUsage,
          budget: event.info.runBudget,
          lifetimeBudget: event.info.lifetimeBudget,
        });
        break;
      case "token_usage":
        patchCurrentTask({ tokenUsage: event.usage });
        break;
      case "context_snapshot":
        patchCurrentTask({ contextTokens: event.tokens });
        break;
      case "reverted":
      case "unreverted":
      case "branched":
      case "compacted":
        break;
      case "plan_approval_request":
      case "plan_approval_resolved":
        // 兼容历史 Plan Agent 事件；当前模式切换不依赖审批状态。
        break;
      case "skill_installed":
      case "skill_deactivated":
      case "skill_uninstalled":
        refreshSkills();
        break;
      case "auto_mode_state":
        setAutoModeState({ ...event.state });
        break;
      case "task_deleted":
        closeStream();
        setTasks((prev) => prev.filter((t) => t.id !== event.taskId));
        if (currentTask?.id === event.taskId) {
          setCurrentTask(null);
          setStatus(null);
          setPhase(null);
          setPlan([]);
          setBusy(false);
          clearLiveState();
        }
        break;
      case "done": {
        clearLiveState();
        setStatus(event.status);
        const donePhase: TaskPhase =
          event.status === "cancelled"
            ? "cancelled"
            : event.status === "failed"
              ? "failed"
              : event.status === "paused"
                ? "waiting_budget"
                : "finalizing";
        setPhase(donePhase);
        if (event.status !== "paused") setPhaseDetail("");
        setBusy(false);
        setAutoModeState(null);
        patchCurrentTask({
          status: event.status,
          phase: donePhase,
        });
        closeStream();
        void refreshRuntime();
        void refreshTaskTraces(event.taskId);
        void fetchWithRetry(() => getTask(event.taskId), { retries: 3, baseDelayMs: 500 })
          .then((full) => {
            setCurrentTask((previous) => (previous?.id === full.id ? full : previous));
            updateTaskList(full);
            if (full.status === "paused") {
              setStatus("paused");
              setPhase(full.phase);
              if (full.phase === "waiting_budget" && full.budgetExceeded?.reason) {
                setPhaseDetail(full.budgetExceeded.reason);
              }
            }
          })
          .catch(() => {
            /* 3 次重试后仍失败：核心数据已通过 SSE message 事件覆盖 */
          });
        break;
      }
      case "error":
        setStatus("failed");
        setPhase("failed");
        setPhaseDetail(event.message);
        setOutput("");
        setBusy(false);
        setCurrentTask((previous) => {
          if (!previous || previous.id !== event.taskId) return previous;
          const failureText = event.message.trim();
          const alreadyHasFailure = previous.messages.some(
            (message) =>
              message.role === "assistant" &&
              (message.failure?.message.includes(failureText) ||
                message.content.includes(failureText) ||
                message.id.startsWith(`failure-${event.taskId}-`)),
          );
          const messages = alreadyHasFailure
            ? previous.messages
            : [...previous.messages, createFailureMessage(event.taskId, event.message)];
          const nextTask = {
            ...previous,
            messages,
            status: "failed" as const,
            phase: "failed" as const,
          };
          updateTaskList(nextTask);
          return nextTask;
        });
        break;
    }
  }

  const derivedLive = useMemo(() => {
    const pending = currentTask?.pendingApprovals ?? [];
    const livePendingIds = new Set(pending.map((pa) => pa.call.id));
    const next = liveToolActivity.map((item) => {
      if (livePendingIds.has(item.id) && item.status !== "awaiting") {
        return { ...item, status: "awaiting" as const };
      }
      return item;
    });
    const knownIds = new Set(next.map((item) => item.id));
    for (const pa of pending) {
      if (knownIds.has(pa.call.id)) continue;
      next.push({
        id: pa.call.id,
        name: pa.call.toolName,
        args: pa.call.args,
        status: "awaiting" as const,
        riskLevel: pa.riskLevel,
        planStepId: pa.call.planStepId,
      });
    }
    return next;
  }, [currentTask?.pendingApprovals, liveToolActivity]);

  return {
    clearLiveState,
    derivedLive,
    handleEvent,
    liveContentBlocks,
    phaseDetail,
  };
}

export function mergeContentBlocks(
  existing: ContentBlock[] | undefined,
  incoming: ContentBlock[],
): ContentBlock[] {
  // 用 Map 同时处理历史重复和单个 SSE 批次内的重复，避免重复 block 继续流入 React。
  const map = new Map<string, ContentBlock>();
  for (const block of existing ?? []) {
    map.set(block.id, block);
  }
  for (const block of incoming) {
    map.set(block.id, block);
  }
  return [...map.values()];
}
