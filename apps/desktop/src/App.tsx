import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import type {
  AgentEvent,
  HealthResponse,
  MemoryCategory,
  MessageAttachment,
  RevertMode,
  Task,
  ToolDescriptor,
  UpdateRuntimeSettingsRequest,
} from "@aurevoy/shared";
import {
  answerClarification,
  approveToolCall,
  branchTask,
  cancelTask,
  checkHealth,
  cleanupData,
  compactTask,
  continueTask,
  createMemory,
  createTask,
  createProject,
  deleteProject,
  deleteMemory,
  deleteTask,
  getDataStatus,
  getMcpStatus,
  getSettings,
  listProviderModels,
  getTask,
  listMemories,
  listProjects,
  listTaskTraces,
  listTasks,
  listTools,
  resumeTask,
  revertTask,
  unrevertTask,
  updateArtifact,
  updateSettings,
  updateTool,
  updateMemory,
} from "./lib/api";
import { ensureDesktopAgentProcess } from "./lib/desktopAgent";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { useArtifacts } from "./hooks/useArtifacts";
import { useMemories } from "./hooks/useMemories";
import { useSSEStream } from "./hooks/useSSEStream";
import { useSettings } from "./hooks/useSettings";
import { useTaskState } from "./hooks/useTaskState";
import { useTools } from "./hooks/useTools";
import { useProjects } from "./hooks/useProjects";
import { useSkills } from "./hooks/useSkills";
import { Composer } from "./components/Composer";
import { Conversation, type ToolActivity } from "./components/Conversation";
import { ArtifactView } from "./components/ArtifactView";
import { InspectorPanel } from "./components/InspectorPanel";
import { ModelSelectorDrawer, type ModelSelectorDraft } from "./components/ModelSelectorDrawer";
import { SettingsPanel, type SettingsDraft } from "./components/SettingsPanel";
import { TaskHistorySidebar } from "./components/TaskHistorySidebar";
import type { FeedItem } from "./components/AgentEventFeed";
import { getPhaseLabel, getStatusLabel } from "./components/status";
import { t } from "./i18n";
import "./App.css";

type MainView = "chat" | "search" | "tools" | "settings";
type ContentMode = "conversation" | "artifacts";
type SettingsSectionId = "general" | "appearance" | "provider" | "mcp" | "tools" | "data" | "memory";

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 380;
const MIN_INSPECTOR_WIDTH = 300;
const MAX_INSPECTOR_WIDTH = 520;
const MIN_FONT_SCALE = 0.86;
const MAX_FONT_SCALE = 1.08;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatContextK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function readStoredNumber(key: string, fallback: number, min: number, max: number): number {
  const stored = window.localStorage.getItem(key);
  const parsed = stored ? Number(stored) : Number.NaN;
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
}

function parseProviderModel(provider?: string | null): string {
  if (!provider || provider === "unconfigured") return "";
  const [, model] = provider.split(/:(.*)/s);
  return model ?? provider;
}

/** 从实时事件流派生工具调用活动（当前运行轮次使用） */
function deriveToolActivityFromEvents(events: FeedItem[]): ToolActivity[] {
  const byId = new Map<string, ToolActivity>();
  const order: string[] = [];
  for (const { event } of events) {
    if (event.type === "tool_call") {
      if (!byId.has(event.call.id)) order.push(event.call.id);
      byId.set(event.call.id, {
        id: event.call.id,
        name: event.call.toolName,
        args: event.call.args,
        status: "running",
      });
    } else if (event.type === "approval_request") {
      const existing = byId.get(event.call.id);
      if (existing) {
        existing.status = "awaiting";
        existing.riskLevel = event.riskLevel;
      } else {
        if (!byId.has(event.call.id)) order.push(event.call.id);
        byId.set(event.call.id, {
          id: event.call.id,
          name: event.call.toolName,
          args: event.call.args,
          status: "awaiting",
          riskLevel: event.riskLevel,
        });
      }
    } else if (event.type === "tool_result") {
      const existing = byId.get(event.result.callId);
      if (existing) {
        existing.status = event.result.ok ? "ok" : "error";
        existing.output = event.result.output;
        existing.error = event.result.error;
      }
    }
  }
  return order.map((id) => byId.get(id)!);
}

function createFeedItem(event: AgentEvent): FeedItem {
  return {
    id: `${event.taskId}-${event.type}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    event,
    createdAt: new Date().toISOString(),
  };
}

function mergeById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) return [...items, next];
  return items.map((item) => (item.id === next.id ? next : item));
}

function App() {
  const [activeView, setActiveView] = useState<MainView>("chat");
  const [contentMode, setContentMode] = useState<ContentMode>("conversation");
  const [events, setEvents] = useState<FeedItem[]>([]);
  const [goal, setGoal] = useState("");
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readStoredNumber("aurevoy.sidebarWidth", 280, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH),
  );
  const [inspectorWidth, setInspectorWidth] = useState(() =>
    readStoredNumber("aurevoy.inspectorWidth", 340, MIN_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH),
  );
  const [fontScale, setFontScale] = useState(() =>
    readStoredNumber("aurevoy.fontScale", 0.94, MIN_FONT_SCALE, MAX_FONT_SCALE),
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSectionId>("general");
  const [modelDrawerOpen, setModelDrawerOpen] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mainScrollRef = useRef<HTMLDivElement | null>(null);
  const {
    busy,
    currentTask,
    output,
    phase,
    plan,
    status,
    tasks,
    setBusy,
    setCurrentTask,
    setOutput,
    setPhase,
    setPlan,
    setStatus,
    setTasks,
    setTraces,
    patchCurrentTask,
    updateTaskList,
  } = useTaskState();
  const { closeStream, openStream } = useSSEStream();
  const {
    runtimeSettings,
    mcpServers,
    dataStatus,
    settingsSaving,
    fetchingModels,
    setRuntimeSettings,
    setMcpServers,
    setDataStatus,
    setSettingsSaving,
    setFetchingModels,
  } = useSettings();
  const { tools, setTools } = useTools();
  const { projects, setProjects } = useProjects();
  const { memories, setMemories } = useMemories();
  const { skills } = useSkills();
  const { mergeArtifact } = useArtifacts(setCurrentTask, updateTaskList);

  const [draftProjectId, setDraftProjectId] = useState<string | undefined>();

  // Sync draftProjectId when a task is selected
  useEffect(() => {
    if (currentTask?.projectId) setDraftProjectId(currentTask.projectId);
  }, [currentTask?.projectId]);

  const draftProjectName = useMemo(
    () => projects.find((p) => p.id === (draftProjectId ?? currentTask?.projectId))?.name,
    [projects, draftProjectId, currentTask?.projectId],
  );

  useEffect(() => {
    void bootstrapRuntime();
  }, []);

  useEffect(() => {
    window.localStorage.setItem("aurevoy.sidebarWidth", String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem("aurevoy.inspectorWidth", String(inspectorWidth));
  }, [inspectorWidth]);

  useEffect(() => {
    window.localStorage.setItem("aurevoy.fontScale", String(fontScale));
  }, [fontScale]);

  // Tauri 原生拖拽事件：获取 Finder 拖入的文件绝对路径
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type === 'drop') {
          const paths = event.payload.paths;
          void (async () => {
            for (const p of paths) {
              try {
                const meta = await invoke<{ name: string; size: number; is_dir: boolean; mime_type: string }>(
                  'file_metadata',
                  { path: p },
                );
                if (meta.is_dir) {
                  // 拖入文件夹 → 导入为项目
                  void handleImportProjectPath(p);
                } else {
                  // 拖入文件 → 添加为附件
                  setAttachments((prev) => {
                    // 去重
                    if (prev.some((a) => a.path === p)) return prev;
                    return [
                      ...prev,
                      {
                        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                        name: meta.name,
                        path: p,
                        mimeType: meta.mime_type,
                        size: meta.size,
                        type: meta.mime_type.startsWith('image/') ? 'image' : 'file',
                      },
                    ];
                  });
                }
              } catch {
                setNotice(`无法读取文件信息: ${p}`);
              }
            }
          })();
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        // 非 Tauri 环境（浏览器开发模式）忽略
      });
    return () => {
      unlisten?.();
    };
  }, []);

  async function handleImportProjectPath(dirPath: string): Promise<void> {
    try {
      const project = await createProject({ path: dirPath });
      setProjects((prev) => [...prev, project]);
      setNotice(`已导入项目: ${project.name}`);
    } catch (err) {
      setNotice(`导入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function bootstrapRuntime(): Promise<void> {
    try {
      const status = await ensureDesktopAgentProcess();
      if (status?.error) {
        setNotice(`${status.message}：${status.error}`);
      }
    } catch (err) {
      setNotice(`${t("notice.startEngineFailed")}${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await refreshRuntime();
    }
  }

  async function refreshRuntime(): Promise<void> {
    try {
      const [nextHealth, nextTasks, nextTools, nextProjects] = await Promise.all([
        checkHealth(),
        listTasks(),
        listTools(),
        listProjects(),
      ]);
      setHealth(nextHealth);
      setOnline(true);
      setTasks(nextTasks);
      setTools(nextTools);
      setProjects(nextProjects);
    } catch (err) {
      setHealth(null);
      // 仅网络层失败(fetch 抛 TypeError)才判定引擎离线；
      // HTTP 4xx/5xx 说明引擎可达、只是返回了错误，不应误判为离线。
      setOnline(err instanceof TypeError ? false : true);
    }
  }

  async function refreshSettings(): Promise<void> {
    try {
      const [settings, nextTools, mcp, data] = await Promise.all([
        getSettings(),
        listTools(),
        getMcpStatus(),
        getDataStatus(),
      ]);
      setRuntimeSettings(settings);
      setTools(nextTools);
      setMcpServers(mcp.servers);
      setDataStatus(data);
    } catch (err) {
      setNotice(`${t("notice.readSettingsFailed")}${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function applyTaskSnapshot(task: Task): void {
    setCurrentTask(task);
    setStatus(task.status);
    setPhase(task.phase);
    setPlan(task.plan);
    setOutput("");
    setGoal("");
    setEvents([]);
    void refreshTaskTraces(task.id);
    resetMainScroll();
  }

  function resetMainScroll(): void {
    const reset = () => mainScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
    window.requestAnimationFrame(reset);
    window.requestAnimationFrame(() => window.requestAnimationFrame(reset));
  }

  async function refreshTaskTraces(taskId: string): Promise<void> {
    try {
      setTraces(await listTaskTraces(taskId));
    } catch (err) {
      setNotice(`${t("notice.readTracesFailed")}${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleEvent(event: AgentEvent): void {
    setEvents((previous) => [...previous, createFeedItem(event)]);

    switch (event.type) {
      case "task_created":
        setCurrentTask(event.task);
        setStatus(event.task.status);
        setPhase(event.task.phase);
        setPlan(event.task.plan);
        setOutput("");
        setTraces([]);
        updateTaskList(event.task);
        break;
      case "status":
        setStatus(event.status);
        patchCurrentTask({ status: event.status });
        break;
      case "phase":
        setPhase(event.phase);
        patchCurrentTask({ phase: event.phase });
        break;
      case "plan":
        setPlan(event.plan);
        patchCurrentTask({ plan: event.plan });
        break;
      case "step_update":
        setPlan((previous) => {
          const nextPlan = previous.map((step) =>
            step.id === event.step.id ? event.step : step,
          );
          patchCurrentTask({ plan: nextPlan });
          return nextPlan;
        });
        break;
      case "token":
        setOutput((previous) => previous + event.delta);
        break;
      case "message":
        setCurrentTask((previous) => {
          const previousMessages = previous?.messages ?? [];
          const hasMessage = previousMessages.some((message) => message.id === event.message.id);
          const messages = hasMessage
            ? previousMessages
            : [...previousMessages, event.message];
          if (!previous) return previous;
          const nextTask = { ...previous, messages };
          updateTaskList(nextTask);
          return nextTask;
        });
        break;
      case "tool_call":
      case "tool_result":
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
      case "reverted":
        break;
      case "unreverted":
        break;
      case "branched":
        break;
      case "compacted":
        break;
      case "task_deleted":
        // 任务被删除（可能来自其他客户端或本端），关流并清理
        closeStream();
        setTasks((prev) => prev.filter((t) => t.id !== event.taskId));
        if (currentTask?.id === event.taskId) {
          setCurrentTask(null);
          setOutput("");
          setStatus(null);
          setPhase(null);
          setPlan([]);
          setBusy(false);
        }
        break;
      case "done":
        setStatus(event.status);
        setPhase(
          event.status === "cancelled"
            ? "cancelled"
            : event.status === "failed"
              ? "failed"
              : "finalizing",
        );
        setBusy(false);
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
        // 工具结果等消息只持久化、不走 live message 事件，拉取完整快照补全本轮线程
        void getTask(event.taskId)
          .then((full) => {
            setCurrentTask((previous) => (previous?.id === full.id ? full : previous));
            updateTaskList(full);
          })
          .catch(() => {
            /* 拉取失败不影响已显示的流式结果 */
          });
        break;
      case "error":
        setStatus("failed");
        setPhase("failed");
        setOutput((previous) =>
          previous ? `${previous}\n\n${t("notice.errorTag")}${event.message}` : `${t("notice.errorTag")}${event.message}`,
        );
        setBusy(false);
        patchCurrentTask({ status: "failed", phase: "failed" });
        break;
    }
  }

  async function startGoal(rawGoal: string, attach?: MessageAttachment[]): Promise<void> {
    const trimmed = rawGoal.trim();
    if (!trimmed || busy) return;

    setBusy(true);
    setEvents([]);
    setTraces([]);
    setOutput("");
    setPlan([]);
    setStatus("pending");
    setPhase("initializing");
    setGoal("");
    setAttachments([]);
    closeStream();

    try {
      const { task } = await createTask(trimmed, draftProjectId ?? currentTask?.projectId, attach);
      setCurrentTask(task);
      setPhase(task.phase);
      setTraces([]);
      updateTaskList(task);
      openStream(task.id, handleEvent, () => setBusy(false));
    } catch (err) {
      setStatus("failed");
      setOutput(`${t("notice.connectEngineFailed")}${err instanceof Error ? err.message : String(err)}`);
      setBusy(false);
      // 仅网络层失败才标记离线；HTTP 错误不代表引擎离线
      if (err instanceof TypeError) setOnline(false);
    }
  }

  function handleSelectTask(task: Task): void {
    closeStream();
    setBusy(false);
    setModelDrawerOpen(false);
    setEditingMessageId(null);
    setActiveView("chat");
    setContentMode("conversation");
    applyTaskSnapshot(task);
  }

  /** 在当前任务内追加一轮输入并继续（多轮对话）；保留后端完整上下文。 */
  async function continueGoal(rawMessage: string, attach?: MessageAttachment[]): Promise<void> {
    const trimmed = rawMessage.trim();
    if (!trimmed || busy || !currentTask) return;

    setBusy(true);
    setEvents([]);
    setTraces([]);
    setOutput("");
    setPlan([]);
    setStatus("running");
    setPhase("initializing");
    setGoal("");
    setAttachments([]);
    closeStream();

    try {
      const { task } = await continueTask(currentTask.id, trimmed, attach);
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

  /** 输入框提交分流：斜杠命令 → 编辑模式续聊 → 已有任务续聊 → 新建。 */
  function handleComposerSubmit(): void {
    const trimmed = goal.trim();
    if (trimmed === "/compact") {
      setGoal("");
      setAttachments([]);
      void handleCompact();
      return;
    }
    const currentAttachments = attachments.length > 0 ? [...attachments] : undefined;
    if (editingMessageId) {
      setEditingMessageId(null);
      void continueGoal(goal, currentAttachments);
    } else if (currentTask && !busy) {
      void continueGoal(goal, currentAttachments);
    } else {
      void startGoal(goal, currentAttachments);
    }
  }

  function handleNewTask(projectId?: string): void {
    closeStream();
    setBusy(false);
    setModelDrawerOpen(false);
    setEditingMessageId(null);
    setActiveView("chat");
    setContentMode("conversation");
    setCurrentTask(null);
    setStatus(null);
    setPhase(null);
    setPlan([]);
    setOutput("");
    setEvents([]);
    setTraces([]);
    setGoal("");
    setDraftProjectId(projectId);
    resetMainScroll();
  }


  /** 编辑用户消息：先 revert 截断历史，再回填 Composer 等待编辑后重新提交。 */
  async function handleRevertAndEdit(messageId: string, _content: string, mode: RevertMode): Promise<void> {
    if (busy || !currentTask) return;

    closeStream();
    setBusy(false);
    setEvents([]);
    setTraces([]);
    setOutput("");

    try {
      const response = await revertTask(currentTask.id, messageId, mode);
      setCurrentTask(response.task);
      setStatus(response.task.status);
      setPhase(response.task.phase);
      setPlan(response.task.plan);
      updateTaskList(response.task);
      setGoal(response.removedContent ?? _content);
      setEditingMessageId(messageId);
      resetMainScroll();
    } catch (err) {
      setNotice(`${t("notice.revertFailed")}${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 从后端持久历史恢复当前任务；与“重试原始目标”不同，会保留已有消息与工具轨迹。 */
  async function handleResumeTask(): Promise<void> {
    if (!currentTask || busy) return;

    setBusy(true);
    setEvents([]);
    setTraces([]);
    setOutput("");
    setPlan([]);
    setStatus("running");
    setPhase("initializing");
    closeStream();

    try {
      const { task } = await resumeTask(currentTask.id);
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

  /** 撤销上一次 revert：从归档恢复被截断的消息。 */
  async function handleUnrevert(): Promise<void> {
    if (!currentTask || busy) return;

    try {
      const response = await unrevertTask(currentTask.id);
      setCurrentTask(response.task);
      setStatus(response.task.status);
      setPhase(response.task.phase);
      setPlan(response.task.plan);
      updateTaskList(response.task);
      setEditingMessageId(null);
      setGoal("");
    } catch (err) {
      setNotice(`${t("notice.unrevertFailed")}${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 从指定消息处分支出新任务并切换过去。 */
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

  /** 将旧消息压缩为 LLM 摘要。 */
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
    // 通知后端中断任务的 LLM 流（fire-and-forget；失败不影响前端已停止）
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

  function handleArtifactDecision(artifactId: string, status: "confirmed" | "rejected"): void {
    const taskId = currentTask?.id;
    if (!taskId) return;
    setNotice(null);
    void updateArtifact(taskId, artifactId, { status })
      .then((artifact) => {
        setCurrentTask((previous) => {
          if (!previous) return previous;
          const nextTask = {
            ...previous,
            artifacts: mergeById(previous.artifacts ?? [], artifact),
          };
          updateTaskList(nextTask);
          return nextTask;
        });
      })
      .catch((err) => {
        setNotice(`${t("notice.updateArtifactFailed")}${err instanceof Error ? err.message : String(err)}`);
      });
  }

  async function refreshMemories(): Promise<void> {
    try {
      setMemories(await listMemories());
    } catch (err) {
      setNotice(`${t("notice.readMemoryFailed")}${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleOpenSettings(section: SettingsSectionId = "general"): void {
    setNotice(null);
    setModelDrawerOpen(false);
    setSettingsInitialSection(section);
    setActiveView("settings");
    setInspectorOpen(false);
    void refreshSettings();
    if (section === "memory") void refreshMemories();
  }

  function handleCloseSettings(): void {
    setNotice(null);
    setInspectorOpen(false);
    setActiveView("chat");
    resetMainScroll();
  }

  function handleOpenModelSelector(): void {
    setNotice(null);
    setModelDrawerOpen(true);
    setInspectorOpen(false);
    if (!runtimeSettings) void refreshSettings();
  }

  function handleOpenFullSettingsFromModelDrawer(): void {
    setModelDrawerOpen(false);
    handleOpenSettings("provider");
  }

  function handleOpenSearch(): void {
    setModelDrawerOpen(false);
    setActiveView("search");
    setInspectorOpen(false);
  }

  function handleOpenTools(): void {
    setModelDrawerOpen(false);
    setActiveView("tools");
    setInspectorOpen(false);
    void refreshRuntime();
  }

  function handleSaveSettings(draft: SettingsDraft): void {
    // Ensure current model is auto-added to quick-select list so the drawer isn't empty
    const currentEnabled = runtimeSettings?.llm.enabledModels ?? [];
    const mergedEnabled = currentEnabled.includes(draft.model)
      ? currentEnabled
      : [draft.model, ...currentEnabled];

    const body: UpdateRuntimeSettingsRequest = {
      llm: {
        provider: "openai",
        baseUrl: draft.baseUrl,
        model: draft.model,
        enabledModels: mergedEnabled,
        temperature: draft.temperature,
        timeoutMs: draft.timeoutMs,
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      },
      workspaceDir: draft.workspaceDir,
      commandExecutionEnabled: draft.commandExecutionEnabled,
      mcpServersJson: draft.mcpServersJson,
      cleanupPolicyDays: draft.cleanupPolicyDays,
    };
    setSettingsSaving(true);
    void updateSettings(body)
      .then((next) => {
        setRuntimeSettings(next);
        setHealth((previous) =>
          previous ? { ...previous, provider: `${next.llm.provider}:${next.llm.model}` } : previous,
        );
        setNotice(t("notice.settingsSaved"));
        return refreshSettings();
      })
      .catch((err) => setNotice(`${t("notice.saveSettingsFailed")}${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setSettingsSaving(false));
  }

  function handleSaveModelSelection(draft: ModelSelectorDraft): void {
    setSettingsSaving(true);
    void updateSettings({
      llm: {
        provider: "openai",
        model: draft.model,
      },
    })
      .then((next) => {
        setRuntimeSettings(next);
        setHealth((previous) =>
          previous ? { ...previous, provider: `${next.llm.provider}:${next.llm.model}` } : previous,
        );
        setModelDrawerOpen(false);
        setNotice(t("notice.modelSwitched"));
        return refreshRuntime();
      })
      .catch((err) => setNotice(`${t("notice.switchModelFailed")}${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setSettingsSaving(false));
  }

  function handleFetchModels(): void {
    setFetchingModels(true);
    void listProviderModels()
      .then((models) => {
        const currentModel = runtimeSettings?.llm.model ?? parseProviderModel(health?.provider);
        const existingEnabled = runtimeSettings?.llm.enabledModels ?? [];
        const firstFetch = (runtimeSettings?.llm.availableModels.length ?? 0) === 0;
        const enabledModels = !firstFetch && existingEnabled.length > 0
          ? existingEnabled.filter((model) => models.includes(model))
          : [];
        if (currentModel && models.includes(currentModel) && !enabledModels.includes(currentModel)) {
          enabledModels.unshift(currentModel);
        }
        return updateSettings({ llm: { availableModels: models, enabledModels } });
      })
      .then((next) => {
        setRuntimeSettings(next);
        setNotice(`${t("notice.fetchedModelsPrefix")} ${next.llm.availableModels.length} ${t("notice.fetchedModelsMid")} ${next.llm.enabledModels.length} ${t("notice.fetchedModelsSuffix")}`);
        return refreshSettings();
      })
      .catch((err) => setNotice(`${t("notice.fetchModelsFailed")}${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setFetchingModels(false));
  }

  function handleSaveEnabledModels(models: string[]): void {
    const currentModel = runtimeSettings?.llm.model;
    const enabledModels = currentModel && !models.includes(currentModel) ? [currentModel, ...models] : models;
    setSettingsSaving(true);
    void updateSettings({
      llm: {
        enabledModels,
      },
    })
      .then((next) => {
        setRuntimeSettings(next);
        setNotice(`${t("notice.enabledModelsPrefix")} ${next.llm.enabledModels.length} ${t("notice.enabledModelsSuffix")}`);
        return refreshSettings();
      })
      .catch((err) => setNotice(`${t("notice.saveModelListFailed")}${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setSettingsSaving(false));
  }

  function handleToggleTool(name: string, enabled: boolean): void {
    void updateTool(name, { enabled })
      .then((updated) => {
        setTools((prev) => prev.map((tool) => (tool.name === name ? updated : tool)));
      })
      .catch((err) => setNotice(`${t("notice.updateToolFailed")}${err instanceof Error ? err.message : String(err)}`));
  }

  function handleCleanupData(olderThanDays: number): void {
    void cleanupData(olderThanDays)
      .then((result) => {
        setNotice(`${t("notice.cleanedPrefix")} ${result.deletedTasks} ${t("notice.cleanedMid")}${result.deletedTraces} ${t("notice.cleanedSuffix")}`);
        return refreshSettings();
      })
      .catch((err) => setNotice(`${t("notice.cleanupFailed")}${err instanceof Error ? err.message : String(err)}`));
  }

  function handleCreateMemory(content: string, category: MemoryCategory): void {
    void createMemory({ content, category })
      .then((created) => setMemories((prev) => [created, ...prev]))
      .catch((err) => setNotice(`${t("notice.addMemoryFailed")}${err instanceof Error ? err.message : String(err)}`));
  }

  function handleToggleMemory(id: string, enabled: boolean): void {
    void updateMemory(id, { enabled })
      .then((updated) => setMemories((prev) => prev.map((m) => (m.id === id ? updated : m))))
      .catch((err) => setNotice(`${t("notice.updateMemoryFailed")}${err instanceof Error ? err.message : String(err)}`));
  }

  function handleEditMemory(id: string, content: string, category: MemoryCategory): void {
    void updateMemory(id, { content, category })
      .then((updated) => setMemories((prev) => prev.map((m) => (m.id === id ? updated : m))))
      .catch((err) => setNotice(`${t("notice.editMemoryFailed")}${err instanceof Error ? err.message : String(err)}`));
  }

  function handleDeleteMemory(id: string): void {
    void deleteMemory(id)
      .then(() => setMemories((prev) => prev.filter((m) => m.id !== id)))
      .catch((err) => setNotice(`${t("notice.deleteMemoryFailed")}${err instanceof Error ? err.message : String(err)}`));
  }

  function handleFontScaleChange(nextScale: number): void {
    setFontScale(clamp(nextScale, MIN_FONT_SCALE, MAX_FONT_SCALE));
  }

  async function handleImportProject(): Promise<void> {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, multiple: false });
      if (!selected) return;
      const project = await createProject({ path: selected as string });
      setProjects(prev => [...prev, project]);
    } catch (err) {
      setNotice(`导入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleDeleteProject(projectId: string): Promise<void> {
    if (!confirm(t('projects.deleteConfirm'))) return;
    try {
      await deleteProject(projectId);
      setProjects(prev => prev.filter(p => p.id !== projectId));
    } catch (err) {
      setNotice(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleDeleteTask(taskId: string): void {
    if (!confirm(t('sidebar.deleteTaskConfirm'))) return;
    // 如果删除的是当前打开的任务，先清空
    if (currentTask?.id === taskId) {
      closeStream();
      setCurrentTask(null);
      setOutput("");
      setStatus(null);
      setPhase(null);
      setPlan([]);
    }
    void deleteTask(taskId)
      .then(() => setTasks((prev) => prev.filter((t) => t.id !== taskId)))
      .catch((err) => setNotice(`${t("notice.deleteTaskFailed")}${err instanceof Error ? err.message : String(err)}`));
  }

  function startResize(panel: "left" | "right", event: PointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panel === "left" ? sidebarWidth : inspectorWidth;

    // 拖拽只修改布局宽度状态；具体列宽由 CSS 变量消费，避免组件互相知道布局细节。
    function handleMove(moveEvent: globalThis.PointerEvent): void {
      const delta = moveEvent.clientX - startX;
      if (panel === "left") {
        setSidebarWidth(clamp(startWidth + delta, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH));
      } else {
        setInspectorWidth(clamp(startWidth - delta, MIN_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH));
      }
    }

    function handleUp(): void {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  }

  const showConversation = currentTask !== null;
  const canResume =
    !!currentTask &&
    !busy &&
    currentTask.status !== "completed" &&
    currentTask.status !== "running" &&
    currentTask.status !== "planning" &&
    currentTask.status !== "paused";

  // 当前运行轮次的实时工具活动（来自事件流）；历史轮次由 Conversation 从消息派生
  const liveToolActivity = deriveToolActivityFromEvents(events);
  const shellStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--inspector-width": `${inspectorWidth}px`,
    "--font-scale": fontScale,
  } as CSSProperties;
  const isChatView = activeView === "chat";

  return (
    <div
      className="app-shell"
      data-active-view={activeView}
      data-left-collapsed={leftCollapsed}
      data-inspector-open={inspectorOpen}
      style={shellStyle}
    >
      <TaskHistorySidebar
        activeTaskId={currentTask?.id}
        activeView={activeView}
        tasks={tasks}
        projects={projects}
        selectedProjectId={draftProjectId ?? currentTask?.projectId}
        onNewTask={handleNewTask}
        onSelectTask={handleSelectTask}
        onSelectProject={setDraftProjectId}
        onCollapse={() => setLeftCollapsed(true)}
        onOpenSearch={handleOpenSearch}
        onOpenTools={handleOpenTools}
        onOpenSettings={handleOpenSettings}
        onImportProject={handleImportProject}
        onDeleteProject={handleDeleteProject}
        onDeleteTask={handleDeleteTask}
      />

      <div
        className="resize-handle resize-handle-left"
        role="separator"
        aria-label={t("a11y.resizeLeft")}
        onPointerDown={(event) => startResize("left", event)}
      />

      <main className="main">
        <header className="topbar">
          <div className="topbar-left-tools">
            {leftCollapsed && (
              <button
                type="button"
                className="icon-btn"
                onClick={() => setLeftCollapsed(false)}
                aria-label={t("nav.expand")}
              >
                <SidebarIcon />
              </button>
            )}
          </div>
          {isChatView && showConversation ? (
            <>
              <div className="topbar-context">
                <div className="topbar-title-group">
                  <span className="topbar-title">{currentTask?.goal}</span>
                  <span className="topbar-subtitle">
                    {status === "completed" || status === "failed" || status === "cancelled"
                      ? getStatusLabel(status)
                      : getPhaseLabel(phase) || getStatusLabel(status)}{" "}
                    · {currentTask?.messages.length ?? 0} 条消息
                  </span>
                </div>
              </div>
              <div className="topbar-actions">
                <div className="content-mode-switcher" role="tablist" aria-label={t("mode.switcherLabel")}>
                  <button
                    type="button"
                    className="mode-btn"
                    role="tab"
                    aria-selected={contentMode === "conversation"}
                    data-active={contentMode === "conversation"}
                    onClick={() => setContentMode("conversation")}
                  >
                    {t("mode.conversation")}
                  </button>
                  <button
                    type="button"
                    className="mode-btn"
                    role="tab"
                    aria-selected={contentMode === "artifacts"}
                    data-active={contentMode === "artifacts"}
                    onClick={() => setContentMode("artifacts")}
                  >
                    {t("mode.artifacts")}
                    {(currentTask?.artifacts?.length ?? 0) > 0 && (
                      <span className="mode-badge">{currentTask?.artifacts?.length}</span>
                    )}
                  </button>
                </div>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => setInspectorOpen((open) => !open)}
                >
                  {inspectorOpen ? t("action.hideDetails") : t("action.runDetails")}
                </button>
              </div>
            </>
          ) : isChatView ? (
            <>
              <div className="topbar-context">
                <span className="topbar-kicker">Aurevoy Agent</span>
              </div>
              <div className="topbar-actions">
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => setInspectorOpen((open) => !open)}
                >
                  {inspectorOpen ? t("action.hideDetails") : t("action.runDetails")}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="topbar-context">
                <div className="topbar-title-group">
                  <span className="topbar-title">{getMainViewTitle(activeView)}</span>
                  <span className="topbar-subtitle">{getMainViewSubtitle(activeView)}</span>
                </div>
              </div>
              <div className="topbar-actions">
                <button type="button" className="ghost-btn" onClick={() => setActiveView("chat")}>
                  返回对话
                </button>
              </div>
            </>
          )}
        </header>

        {activeView === "search" ? (
          <SearchPage
            query={searchQuery}
            tasks={tasks}
            onQueryChange={setSearchQuery}
            onSelectTask={handleSelectTask}
          />
        ) : activeView === "tools" ? (
          <ToolsPage tools={tools} onToggleTool={handleToggleTool} />
        ) : activeView === "settings" ? (
          <SettingsPanel
            settings={runtimeSettings}
            tools={tools}
            mcpServers={mcpServers}
            dataStatus={dataStatus}
            memories={memories}
            saving={settingsSaving}
            fetchingModels={fetchingModels}
            fontScale={fontScale}
            initialSection={settingsInitialSection}
            onClose={handleCloseSettings}
            onSave={handleSaveSettings}
            onToggleTool={handleToggleTool}
            onCleanup={handleCleanupData}
            onRefresh={refreshSettings}
            onFetchModels={handleFetchModels}
            onSaveEnabledModels={handleSaveEnabledModels}
            onFontScaleChange={handleFontScaleChange}
            onCreateMemory={handleCreateMemory}
            onToggleMemory={handleToggleMemory}
            onEditMemory={handleEditMemory}
            onDeleteMemory={handleDeleteMemory}
          />
        ) : showConversation ? (
          contentMode === "artifacts" ? (
            <div className="main-scroll">
              <ArtifactView
                artifacts={currentTask?.artifacts ?? []}
                onDecision={handleArtifactDecision}
              />
            </div>
          ) : (
          <>
            <div className="main-scroll" ref={mainScrollRef}>
              <Conversation
                task={currentTask}
                status={status}
                phase={phase}
                plan={plan}
                output={output}
                busy={busy}
                liveToolActivity={liveToolActivity}
                online={online}
                onToolDecision={handleToolDecision}
                onClarificationAnswer={handleClarificationAnswer}
                onArtifactDecision={handleArtifactDecision}
                canResume={canResume}
                hasArchivedMessages={(currentTask?.archivedMessages?.length ?? 0) > 0}
                onUserMessageEdit={(messageId, content, mode) => void handleRevertAndEdit(messageId, content, mode)}
                onUnrevert={() => void handleUnrevert()}
                onBranch={(messageId) => void handleBranch(messageId)}
                onResume={() => void handleResumeTask()}
                onStop={handleStopStream}
              />
            </div>
            <div className="composer-dock">
              {health?.contextCharBudget != null && currentTask && currentTask.messages.length > 0 && (
                <div className="context-hint">
                  {t("context.label")} ~{formatContextK(currentTask.messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0))} / {formatContextK(health.contextCharBudget)} {t("context.unit")}
                </div>
              )}
              <Composer
                value={goal}
                busy={busy}
                online={online}
                variant="docked"
                projectName={draftProjectName}
                isEditing={editingMessageId !== null}
                skills={skills}
                attachments={attachments}
                onAttachmentsChange={setAttachments}
                onCancelEdit={() => {
                  setEditingMessageId(null);
                  setGoal("");
                  setAttachments([]);
                }}
                provider={health?.provider}
                onChange={setGoal}
                onSubmit={handleComposerSubmit}
                onOpenModelSelector={handleOpenModelSelector}
                onStop={handleStopStream}
              />
              <ModelSelectorDrawer
                open={modelDrawerOpen}
                provider={health?.provider}
                settings={runtimeSettings}
                saving={settingsSaving}
                onClose={() => setModelDrawerOpen(false)}
                onOpenFullSettings={handleOpenFullSettingsFromModelDrawer}
                onSave={handleSaveModelSelection}
              />
            </div>
          </>
          )
        ) : (
          <div className="hero">
            <h1 className="hero-title">{t("hero.title")}</h1>
            <Composer
              value={goal}
              busy={busy}
              online={online}
              variant="hero"
              projectName={draftProjectName}
              skills={skills}
              attachments={attachments}
              onAttachmentsChange={setAttachments}
              provider={health?.provider}
              onChange={setGoal}
              onSubmit={handleComposerSubmit}
              onOpenModelSelector={handleOpenModelSelector}
              onStop={handleStopStream}
            />
            <ModelSelectorDrawer
              open={modelDrawerOpen}
              provider={health?.provider}
              settings={runtimeSettings}
              saving={settingsSaving}
              onClose={() => setModelDrawerOpen(false)}
              onOpenFullSettings={handleOpenFullSettingsFromModelDrawer}
              onSave={handleSaveModelSelection}
            />
          </div>
        )}
      </main>

      <div
        className="resize-handle resize-handle-right"
        role="separator"
        aria-label={t("a11y.resizeRight")}
        onPointerDown={(event) => startResize("right", event)}
      />

      <InspectorPanel
        open={inspectorOpen}
        events={events}
        health={health}
        task={currentTask}
        phase={phase}
        onClose={() => setInspectorOpen(false)}
      />

      {notice && <ToastNotice message={notice} onClose={() => setNotice(null)} />}
    </div>
  );
}

function ToastNotice({ message, onClose }: { message: string; onClose: () => void }) {
  return createPortal(
    <div className="toast-bubble" role="status">
      <span>{message}</span>
      <button type="button" className="toast-close" onClick={onClose} aria-label={t("a11y.closeNotice")}>
        ×
      </button>
    </div>,
    document.body,
  );
}

function SidebarIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <path
        d="M3.8 4.2h12.4c.9 0 1.6.7 1.6 1.6v8.4c0 .9-.7 1.6-1.6 1.6H3.8c-.9 0-1.6-.7-1.6-1.6V5.8c0-.9.7-1.6 1.6-1.6zM7.4 4.5v11"
        stroke="currentColor"
        strokeWidth="1.35"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function getMainViewTitle(view: MainView): string {
  if (view === "search") return t("nav.search");
  if (view === "tools") return t("nav.tools");
  if (view === "settings") return t("nav.settings");
  return t("mode.conversation");
}

function getMainViewSubtitle(view: MainView): string {
  if (view === "search") return t("view.search.subtitle");
  if (view === "tools") return t("view.tools.subtitle");
  if (view === "settings") return t("view.settings.subtitle");
  return t("view.chat.subtitle");
}

function SearchPage({
  query,
  tasks,
  onQueryChange,
  onSelectTask,
}: {
  query: string;
  tasks: Task[];
  onQueryChange: (query: string) => void;
  onSelectTask: (task: Task) => void;
}) {
  const normalizedQuery = query.trim().toLowerCase();
  const filteredTasks = normalizedQuery
    ? tasks.filter((task) => task.goal.toLowerCase().includes(normalizedQuery))
    : tasks;

  return (
    <section className="page-panel">
      <header className="page-panel-head">
        <div>
          <h1>{t("nav.search")}</h1>
          <p>{t("search.desc")}</p>
        </div>
      </header>
      <input
        className="page-search-input"
        value={query}
        placeholder={t("search.placeholder")}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
      />
      <div className="page-list">
        {filteredTasks.length === 0 ? (
          <p className="page-empty">{t("sidebar.emptyNoMatch")}</p>
        ) : (
          filteredTasks.map((task) => (
            <button key={task.id} type="button" className="page-list-row" onClick={() => onSelectTask(task)}>
              <span className="page-list-title">{task.goal}</span>
              <span className="page-list-meta">
                {task.status} · {new Date(task.updatedAt).toLocaleString("zh-CN")}
              </span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}

function ToolsPage({
  tools,
  onToggleTool,
}: {
  tools: ToolDescriptor[];
  onToggleTool: (name: string, enabled: boolean) => void;
}) {
  return (
    <section className="page-panel">
      <header className="page-panel-head">
        <div>
          <h1>{t("nav.tools")}</h1>
          <p>{t("toolsPage.desc")}</p>
        </div>
      </header>
      <div className="tool-page-grid">
        {tools.length === 0 ? (
          <p className="page-empty">{t("inspector.emptyTools")}</p>
        ) : (
          tools.map((tool) => (
            <article key={tool.name} className="tool-page-card">
              <header>
                <strong>{tool.name}</strong>
                <span>{tool.source?.type === "mcp" ? `MCP:${tool.source.serverName}` : t("settings.builtinTool")}</span>
              </header>
              <p>{tool.description}</p>
              <label className="memory-toggle tool-page-toggle">
                <input
                  type="checkbox"
                  checked={tool.enabled !== false}
                  onChange={(event) => onToggleTool(tool.name, event.currentTarget.checked)}
                />
                <span>
                  {tool.enabled === false ? t("memory.disable") : t("memory.enable")} · {tool.riskLevel ?? "safe"}
                </span>
              </label>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

export default App;
