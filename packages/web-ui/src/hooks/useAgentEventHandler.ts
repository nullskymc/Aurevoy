import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { AgentEvent, ContentBlock, PlanStep, Task, TaskArtifact, TaskPhase, TaskStatus, TaskTraceEntry } from "@aurevoy/shared";
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
  setPhase,
  setPlan,
  setStatus,
  setTasks,
  setTraces,
  updateTaskList,
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
  setPhase: Dispatch<SetStateAction<TaskPhase | null>>;
  setPlan: Dispatch<SetStateAction<PlanStep[]>>;
  setStatus: Dispatch<SetStateAction<TaskStatus | null>>;
  setTasks: Dispatch<SetStateAction<Task[]>>;
  setTraces: Dispatch<SetStateAction<TaskTraceEntry[]>>;
  updateTaskList: (task: Task) => void;
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
        setOutput("");
        setTraces([]);
        updateTaskList(event.task);
        break;
      case "task_title":
        patchCurrentTask({ title: event.title, titleSource: event.source });
        setTasks((prev) =>
          prev.map((task) =>
            task.id === event.taskId
              ? { ...task, title: event.title, titleSource: event.source }
              : task,
          ),
        );
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
        setPlan((previous) => {
          const nextPlan = previous.map((step) => (step.id === event.step.id ? event.step : step));
          patchCurrentTask({ plan: nextPlan });
          return nextPlan;
        });
        break;
      case "token":
        if (nextOutputFreshRef.current) {
          setOutput(event.delta);
          nextOutputFreshRef.current = false;
        } else {
          setOutput((previous) => previous + event.delta);
        }
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
        if (isAssistant && !hasToolCalls) setOutput("");
        setCurrentTask((previous) => {
          const previousMessages = previous?.messages ?? [];
          if (!previous) return previous;
          const messageIndex = previousMessages.findIndex((message) => message.id === event.message.id);
          const messages = messageIndex >= 0
            ? previousMessages.map((message) => (message.id === event.message.id ? { ...message, ...event.message } : message))
            : [...previousMessages, event.message];
          const nextTask = { ...previous, messages };
          updateTaskList(nextTask);
          return nextTask;
        });
        if (event.message.contentBlocks?.length) {
          setLiveContentBlocks((prev) => {
            const existingIds = new Set(prev.map((b) => b.id));
            const newBlocks = event.message.contentBlocks!.filter((b) => !existingIds.has(b.id));
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
          updateTaskList(nextTask);
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
          updateTaskList(nextTask);
          return nextTask;
        });
        break;
      case "artifact_created":
      case "artifact_updated":
        mergeArtifact(event.artifact);
        break;
      case "content_blocks_added":
        setCurrentTask((previous) => {
          if (!previous) return previous;
          const messages = (previous.messages ?? []).map((msg) => {
            if (msg.id !== event.messageId) return msg;
            const existingIds = new Set((msg.contentBlocks ?? []).map((b) => b.id));
            const newBlocks = event.blocks.filter((b) => !existingIds.has(b.id));
            if (newBlocks.length === 0) return msg;
            return { ...msg, contentBlocks: [...(msg.contentBlocks ?? []), ...newBlocks] };
          });
          const nextTask = { ...previous, messages };
          updateTaskList(nextTask);
          return nextTask;
        });
        setLiveContentBlocks((prev) => {
          const existingIds = new Set(prev.map((b) => b.id));
          const newBlocks = event.blocks.filter((b) => !existingIds.has(b.id));
          return newBlocks.length > 0 ? [...prev, ...newBlocks] : prev;
        });
        break;
      case "checkpoint_created":
        setCurrentTask((previous) => {
          if (!previous) return previous;
          const nextTask = {
            ...previous,
            checkpoints: mergeById(previous.checkpoints ?? [], event.checkpoint),
          };
          updateTaskList(nextTask);
          return nextTask;
        });
        break;
      case "budget_usage":
        patchCurrentTask({ budgetUsage: event.usage, budget: event.budget });
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
        setStatus("paused");
        setPhase("waiting_approval");
        setPlan(event.plan);
        setCurrentTask((previous) => {
          if (!previous) return previous;
          const nextTask = {
            ...previous,
            status: "paused" as const,
            phase: "waiting_approval" as const,
            plan: event.plan,
          };
          updateTaskList(nextTask);
          return nextTask;
        });
        break;
      case "plan_approval_resolved":
        setCurrentTask((previous) => {
          if (!previous) return previous;
          const nextPlan = previous.plan.map((step, index) => ({
            ...step,
            status: event.approved ? (index === 0 ? "running" as const : "pending" as const) : "pending" as const,
          }));
          setPlan(nextPlan);
          const nextTask = { ...previous, plan: nextPlan };
          updateTaskList(nextTask);
          return nextTask;
        });
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
      case "done":
        clearLiveState();
        setStatus(event.status);
        setPhase(
          event.status === "cancelled"
            ? "cancelled"
            : event.status === "failed"
              ? "failed"
              : "finalizing",
        );
        setPhaseDetail("");
        setBusy(false);
        setAutoModeState(null);
        patchCurrentTask({
          status: event.status,
          phase:
            event.status === "cancelled"
              ? "cancelled"
              : event.status === "failed"
                ? "failed"
                : "finalizing",
        });
        closeStream();
        void refreshRuntime();
        void refreshTaskTraces(event.taskId);
        void fetchWithRetry(() => getTask(event.taskId), { retries: 3, baseDelayMs: 500 })
          .then((full) => {
            setCurrentTask((previous) => (previous?.id === full.id ? full : previous));
            updateTaskList(full);
          })
          .catch(() => {
            /* 3 次重试后仍失败：核心数据已通过 SSE message 事件覆盖 */
          });
        break;
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

  const livePendingIds = new Set((currentTask?.pendingApprovals ?? []).map((pa) => pa.call.id));
  const derivedLive = liveToolActivity.map((item) => {
    if (livePendingIds.has(item.id) && item.status !== "awaiting") {
      return { ...item, status: "awaiting" as const };
    }
    return item;
  });

  for (const pa of currentTask?.pendingApprovals ?? []) {
    if (!liveActivityRef.current.has(pa.call.id)) {
      derivedLive.push({
        id: pa.call.id,
        name: pa.call.toolName,
        args: pa.call.args,
        status: "awaiting" as const,
        riskLevel: pa.riskLevel,
        planStepId: pa.call.planStepId,
      });
    }
  }

  return {
    clearLiveState,
    derivedLive,
    handleEvent,
    liveContentBlocks,
    phaseDetail,
  };
}
