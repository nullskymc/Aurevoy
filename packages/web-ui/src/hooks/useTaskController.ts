import type { Dispatch, SetStateAction } from "react";
import type { AgentEvent, MessageAttachment, PlanStep, RevertMode, Task, TaskPhase, TaskStatus, TaskTraceEntry } from "@aurevoy/shared";
import {
  answerClarification,

  approveToolCall,
  branchTask,
  cancelTask,
  compactTask,
  continueTask,
  createTask,
  resumeTask,
  revertTask,
  unrevertTask,
} from "../api";
import type { MainView } from "../app/types";
import { t } from "../i18n";

export function useTaskController({
  attachments,
  busy,
  clearLiveState,
  closeStream,
  currentTask,
  draftProjectId,
  goal,
  handleEvent,
  openStream,
  refreshTaskTraces,
  runAgentRequest,
  setActiveView,
  setAttachments,
  setBusy,
  setCurrentTask,
  setDraftProjectId,
  setGoal,
  setModelDrawerOpen,
  setNotice,
  setOnline,
  setOutput,
  setPhase,
  setPlan,
  setStatus,
  setTraces,
  updateTaskList,
}: {
  attachments: MessageAttachment[];
  busy: boolean;
  clearLiveState: () => void;
  closeStream: () => void;
  currentTask: Task | null;
  draftProjectId: string | undefined;
  goal: string;
  handleEvent: (event: AgentEvent) => void;
  openStream: (taskId: string, onEvent: (event: AgentEvent) => void, onDone: () => void) => void;
  refreshTaskTraces: (taskId: string) => Promise<void>;
  runAgentRequest: <T>(request: () => Promise<T>) => Promise<T>;
  setActiveView: Dispatch<SetStateAction<MainView>>;
  setAttachments: Dispatch<SetStateAction<MessageAttachment[]>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setCurrentTask: Dispatch<SetStateAction<Task | null>>;
  setDraftProjectId: Dispatch<SetStateAction<string | undefined>>;
  setGoal: Dispatch<SetStateAction<string>>;
  setModelDrawerOpen: Dispatch<SetStateAction<boolean>>;
  setNotice: (message: string | null) => void;
  setOnline: Dispatch<SetStateAction<boolean | null>>;
  setOutput: Dispatch<SetStateAction<string>>;
  setPhase: Dispatch<SetStateAction<TaskPhase | null>>;
  setPlan: Dispatch<SetStateAction<PlanStep[]>>;
  setStatus: Dispatch<SetStateAction<TaskStatus | null>>;
  setTraces: Dispatch<SetStateAction<TaskTraceEntry[]>>;
  updateTaskList: (task: Task) => void;
}) {
  function resetComposer(): void {
    setGoal("");
    setAttachments([]);
  }

  async function startGoal(rawGoal: string, attach?: MessageAttachment[]): Promise<void> {
    const trimmed = rawGoal.trim();
    if (!trimmed || busy) return;

    setBusy(true);
    clearLiveState();
    setTraces([]);
    setPlan([]);
    setStatus("pending");
    setPhase("initializing");
    resetComposer();
    closeStream();

    try {
      const { task } = await runAgentRequest(() =>
        createTask(trimmed, draftProjectId ?? currentTask?.projectId, attach),
      );
      setCurrentTask(task);
      setPhase(task.phase);
      setTraces([]);
      updateTaskList(task);
      openStream(task.id, handleEvent, () => setBusy(false));
    } catch (err) {
      setStatus("failed");
      setOutput(`${t("notice.connectEngineFailed")}${err instanceof Error ? err.message : String(err)}`);
      setBusy(false);
      if (err instanceof TypeError) setOnline(false);
    }
  }

  function handleSelectTask(task: Task): void {
    closeStream();
    setModelDrawerOpen(false);
    setActiveView("chat");
    setCurrentTask(task);
    setStatus(task.status);
    setPhase(task.phase);
    setPlan(task.plan);
    setGoal("");
    clearLiveState();
    void refreshTaskTraces(task.id);

    const isLive =
      task.status === "pending" ||
      task.status === "planning" ||
      task.status === "running" ||
      task.status === "paused";

    if (isLive) {
      setBusy(true);
      openStream(task.id, handleEvent, () => setBusy(false));
    } else {
      setBusy(false);
    }
  }

  async function continueGoal(rawMessage: string, attach?: MessageAttachment[]): Promise<void> {
    const trimmed = rawMessage.trim();
    if (!trimmed || busy || !currentTask) return;

    setBusy(true);
    clearLiveState();
    setTraces([]);
    setPlan([]);
    setStatus("running");
    setPhase("initializing");
    resetComposer();
    closeStream();

    try {
      const { task } = await runAgentRequest(() => continueTask(currentTask.id, trimmed, attach));
      setCurrentTask(task);
      setPhase(task.phase);
      updateTaskList(task);
      openStream(task.id, handleEvent, () => setBusy(false));
    } catch (err) {
      setBusy(false);
      setNotice(`${t("notice.continueFailed")}${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof TypeError) setOnline(false);
    }
  }

  function handleUiChoice(payload: { partId: string; actionId: string; selection: unknown }): void {
    const selection =
      typeof payload.selection === "string"
        ? payload.selection
        : JSON.stringify(payload.selection);
    const text =
      `[UI ${payload.actionId}] part=${payload.partId}\n` +
      `selection=${selection}`;
    void continueGoal(text);
  }

  function handleComposerSubmit(): void {
    const trimmed = goal.trim();
    if (trimmed === "/compact") {
      resetComposer();
      void handleCompact();
      return;
    }
    const currentAttachments = attachments.length > 0 ? [...attachments] : undefined;
    if (currentTask && !busy) {
      void continueGoal(goal, currentAttachments);
    } else if (!busy) {
      void startGoal(goal, currentAttachments);
    }
  }

  function handleNewTask(projectId?: string): void {
    closeStream();
    setBusy(false);
    setModelDrawerOpen(false);
    setActiveView("chat");
    setCurrentTask(null);
    setStatus(null);
    setPhase(null);
    setPlan([]);
    clearLiveState();
    setTraces([]);
    setGoal("");
    setDraftProjectId(projectId);
  }

  /**
   * 轻量编辑重试：截断到目标用户消息，再用编辑后的文案立刻 continue。
   * 不走 Composer 二次编辑；取消只发生在内联卡本地，未提交前不改历史。
   */
  async function handleRevertAndEdit(
    messageId: string,
    content: string,
    mode: RevertMode,
    messageAttachments?: MessageAttachment[],
  ): Promise<void> {
    const trimmed = content.trim();
    if (busy || !currentTask || !trimmed) return;

    const taskId = currentTask.id;
    const attach =
      messageAttachments && messageAttachments.length > 0 ? messageAttachments : undefined;

    closeStream();
    clearLiveState();
    setTraces([]);
    setBusy(true);
    setStatus("running");
    setPhase("initializing");
    resetComposer();

    let truncatedTask: Task | null = null;
    try {
      const response = await revertTask(taskId, messageId, mode);
      truncatedTask = response.task;
      setCurrentTask(response.task);
      setStatus(response.task.status);
      setPhase(response.task.phase);
      setPlan(response.task.plan);
      updateTaskList(response.task);

      const { task } = await runAgentRequest(() => continueTask(taskId, trimmed, attach));
      setCurrentTask(task);
      setPhase(task.phase);
      setStatus(task.status);
      setPlan(task.plan);
      updateTaskList(task);
      openStream(task.id, handleEvent, () => setBusy(false));
    } catch (err) {
      setBusy(false);
      // revert 已成功时保留截断态，用户可用「撤销编辑」恢复
      if (truncatedTask) {
        setCurrentTask(truncatedTask);
        setStatus(truncatedTask.status);
        setPhase(truncatedTask.phase);
        setPlan(truncatedTask.plan);
        updateTaskList(truncatedTask);
      }
      setNotice(`${t("notice.revertFailed")}${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleResumeTask(): Promise<void> {
    if (!currentTask || busy) return;

    setBusy(true);
    clearLiveState();
    setTraces([]);
    setPlan([]);
    setStatus("running");
    setPhase("initializing");
    closeStream();

    try {
      const { task } = await runAgentRequest(() => resumeTask(currentTask.id));
      setCurrentTask(task);
      setPhase(task.phase);
      updateTaskList(task);
      openStream(task.id, handleEvent, () => setBusy(false));
    } catch (err) {
      setBusy(false);
      setNotice(`${t("notice.resumeFailed")}${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof TypeError) setOnline(false);
    }
  }

  async function handleUnrevert(): Promise<void> {
    if (!currentTask || busy) return;

    try {
      const response = await unrevertTask(currentTask.id);
      setCurrentTask(response.task);
      setStatus(response.task.status);
      setPhase(response.task.phase);
      setPlan(response.task.plan);
      updateTaskList(response.task);
      resetComposer();
    } catch (err) {
      setNotice(`${t("notice.unrevertFailed")}${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleBranch(messageId: string): Promise<void> {
    if (!currentTask || busy) return;

    try {
      const response = await branchTask(currentTask.id, messageId);
      updateTaskList(response.task);
      handleSelectTask(response.task);
    } catch (err) {
      setNotice(`${t("notice.branchFailed")}${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleCompact(): Promise<void> {
    if (!currentTask || busy) return;

    try {
      const response = await compactTask(currentTask.id);
      setCurrentTask(response.task);
      updateTaskList(response.task);
      setNotice(`${t("notice.compacted")}${response.originalCount} ${t("notice.compactedMessages")} ${response.summaryLength} ${t("notice.compactedChars")}`);
    } catch (err) {
      setNotice(`${t("notice.compactFailed")}${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleStopStream(): void {
    closeStream();
    setBusy(false);
    const taskId = currentTask?.id;
    if (taskId) {
      void cancelTask(taskId).catch((err) => {
        setNotice(`${t("notice.cancelNotDelivered")}${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  function handleToolDecision(callId: string, approved: boolean): void {
    const taskId = currentTask?.id;
    if (!taskId) return;
    setNotice(null);
    void approveToolCall(taskId, callId, approved).catch((err) => {
      setNotice(
        `${t("notice.submit")}${approved ? t("action.approve") : t("action.reject")}${t("notice.failedColon")}${err instanceof Error ? err.message : String(err)}${t("notice.pleaseRetry")}`,
      );
    });
  }

  function handleClarificationAnswer(clarificationId: string, answer: string): void {
    const taskId = currentTask?.id;
    if (!taskId) return;
    setNotice(null);
    void answerClarification(taskId, clarificationId, answer).catch((err) => {
      setNotice(`${t("notice.replyClarificationFailed")}${err instanceof Error ? err.message : String(err)}`);
    });
  }

  return {
    handleBranch,
    handleClarificationAnswer,
    handleComposerSubmit,
    handleUiChoice,
    handleNewTask,

    handleResumeTask,
    handleRevertAndEdit,
    handleSelectTask,
    handleStopStream,
    handleToolDecision,
    handleUnrevert,
  };
}
