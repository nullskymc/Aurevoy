import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import type {
  AgentEvent,
  HealthResponse,
  MemoryCategory,
  Task,
  ToolDescriptor,
  UpdateRuntimeSettingsRequest,
} from "@aurevoy/shared";
import {
  answerClarification,
  approveToolCall,
  cancelTask,
  checkHealth,
  cleanupData,
  continueTask,
  createMemory,
  createTask,
  deleteMemory,
  getDataStatus,
  getMcpStatus,
  getSettings,
  listProviderModels,
  getTask,
  listMemories,
  listTaskTraces,
  listTasks,
  listTools,
  resumeTask,
  updateArtifact,
  updateSettings,
  updateTool,
  updateMemory,
} from "./lib/api";
import { ensureDesktopAgentProcess } from "./lib/desktopAgent";
import { useArtifacts } from "./hooks/useArtifacts";
import { useMemories } from "./hooks/useMemories";
import { useSSEStream } from "./hooks/useSSEStream";
import { useSettings } from "./hooks/useSettings";
import { useTaskState } from "./hooks/useTaskState";
import { useTools } from "./hooks/useTools";
import { Composer } from "./components/Composer";
import { Conversation, type ToolActivity } from "./components/Conversation";
import { InspectorPanel } from "./components/InspectorPanel";
import { MemoryPanel } from "./components/MemoryPanel";
import { ModelSelectorDrawer, type ModelSelectorDraft } from "./components/ModelSelectorDrawer";
import { SettingsPanel, type SettingsDraft } from "./components/SettingsPanel";
import { TaskHistorySidebar } from "./components/TaskHistorySidebar";
import { StatusPill } from "./components/StatusPill";
import type { FeedItem } from "./components/AgentEventFeed";
import { getPhaseLabel, getStatusLabel } from "./components/status";
import "./App.css";

type MainView = "chat" | "search" | "tools" | "memory" | "settings";
type SettingsSectionId = "general" | "appearance" | "provider" | "mcp" | "tools" | "data";

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 380;
const MIN_INSPECTOR_WIDTH = 300;
const MAX_INSPECTOR_WIDTH = 520;
const MIN_FONT_SCALE = 0.86;
const MAX_FONT_SCALE = 1.08;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
  const [events, setEvents] = useState<FeedItem[]>([]);
  const [goal, setGoal] = useState("");
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
    traces,
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
  const { memories, setMemories } = useMemories();
  const { mergeArtifact } = useArtifacts(setCurrentTask, updateTaskList);

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

  async function bootstrapRuntime(): Promise<void> {
    try {
      const status = await ensureDesktopAgentProcess();
      if (status?.error) {
        setNotice(`${status.message}：${status.error}`);
      }
    } catch (err) {
      setNotice(`启动 Agent 引擎失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await refreshRuntime();
    }
  }

  async function refreshRuntime(): Promise<void> {
    try {
      const [nextHealth, nextTasks, nextTools] = await Promise.all([
        checkHealth(),
        listTasks(),
        listTools(),
      ]);
      setHealth(nextHealth);
      setOnline(true);
      setTasks(nextTasks);
      setTools(nextTools);
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
      setNotice(`读取设置失败：${err instanceof Error ? err.message : String(err)}`);
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
      setNotice(`读取任务轨迹失败：${err instanceof Error ? err.message : String(err)}`);
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
          previous ? `${previous}\n\n[错误] ${event.message}` : `[错误] ${event.message}`,
        );
        setBusy(false);
        patchCurrentTask({ status: "failed", phase: "failed" });
        break;
    }
  }

  async function startGoal(rawGoal: string): Promise<void> {
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
    closeStream();

    try {
      const { task } = await createTask(trimmed);
      setCurrentTask(task);
      setPhase(task.phase);
      setTraces([]);
      updateTaskList(task);
      openStream(task.id, handleEvent, () => setBusy(false));
    } catch (err) {
      setStatus("failed");
      setOutput(`无法连接 Agent 引擎：${err instanceof Error ? err.message : String(err)}`);
      setBusy(false);
      // 仅网络层失败才标记离线；HTTP 错误不代表引擎离线
      if (err instanceof TypeError) setOnline(false);
    }
  }

  function handleSelectTask(task: Task): void {
    closeStream();
    setBusy(false);
    setModelDrawerOpen(false);
    setActiveView("chat");
    applyTaskSnapshot(task);
  }

  /** 在当前任务内追加一轮输入并继续（多轮对话）；保留后端完整上下文。 */
  async function continueGoal(rawMessage: string): Promise<void> {
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
    closeStream();

    try {
      const { task } = await continueTask(currentTask.id, trimmed);
      setCurrentTask(task);
      setPhase(task.phase);
      updateTaskList(task);
      openStream(task.id, handleEvent, () => setBusy(false));
    } catch (err) {
      setBusy(false);
      setNotice(`继续对话失败：${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof TypeError) setOnline(false);
    }
  }

  /** 输入框提交分流：已有当前任务则续聊，否则新建任务。 */
  function handleComposerSubmit(): void {
    if (currentTask && !busy) {
      void continueGoal(goal);
    } else {
      void startGoal(goal);
    }
  }

  function handleNewTask(): void {
    closeStream();
    setBusy(false);
    setModelDrawerOpen(false);
    setActiveView("chat");
    setCurrentTask(null);
    setStatus(null);
    setPhase(null);
    setPlan([]);
    setOutput("");
    setEvents([]);
    setTraces([]);
    setGoal("");
    resetMainScroll();
  }

  function handleRetry(): void {
    if (!currentTask) return;
    void startGoal(currentTask.goal);
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
      setNotice(`恢复任务失败：${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof TypeError) setOnline(false);
    }
  }

  function handleStopStream(): void {
    closeStream();
    setBusy(false);
    // 通知后端中断任务的 LLM 流（fire-and-forget；失败不影响前端已停止）
    const taskId = currentTask?.id;
    if (taskId) {
      void cancelTask(taskId).catch((err) => {
        setNotice(`取消请求未送达后端：${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  function handleToolDecision(callId: string, approved: boolean): void {
    const taskId = currentTask?.id;
    if (!taskId) return;
    setNotice(null);
    void approveToolCall(taskId, callId, approved).catch((err) => {
      setNotice(
        `提交${approved ? "批准" : "拒绝"}失败：${err instanceof Error ? err.message : String(err)}。请重试。`,
      );
    });
  }

  function handleClarificationAnswer(clarificationId: string, answer: string): void {
    const taskId = currentTask?.id;
    if (!taskId) return;
    setNotice(null);
    void answerClarification(taskId, clarificationId, answer).catch((err) => {
      setNotice(`提交追问回复失败：${err instanceof Error ? err.message : String(err)}`);
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
        setNotice(`更新产物状态失败：${err instanceof Error ? err.message : String(err)}`);
      });
  }

  async function refreshMemories(): Promise<void> {
    try {
      setMemories(await listMemories());
    } catch (err) {
      setNotice(`读取记忆失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleOpenMemory(): void {
    setModelDrawerOpen(false);
    setActiveView("memory");
    setInspectorOpen(false);
    void refreshMemories();
  }

  function handleOpenSettings(section: SettingsSectionId = "general"): void {
    setNotice(null);
    setModelDrawerOpen(false);
    setSettingsInitialSection(section);
    setActiveView("settings");
    setInspectorOpen(false);
    void refreshSettings();
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
    const body: UpdateRuntimeSettingsRequest = {
      llm: {
        provider: "openai",
        baseUrl: draft.baseUrl,
        model: draft.model,
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
        setNotice("设置已保存，并已应用到 Agent runtime");
        return refreshSettings();
      })
      .catch((err) => setNotice(`保存设置失败：${err instanceof Error ? err.message : String(err)}`))
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
        setNotice("模型已切换");
        return refreshRuntime();
      })
      .catch((err) => setNotice(`切换模型失败：${err instanceof Error ? err.message : String(err)}`))
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
        setNotice(`已获取 ${next.llm.availableModels.length} 个模型，已启用 ${next.llm.enabledModels.length} 个`);
        return refreshSettings();
      })
      .catch((err) => setNotice(`获取模型列表失败：${err instanceof Error ? err.message : String(err)}`))
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
        setNotice(`已启用 ${next.llm.enabledModels.length} 个主界面模型`);
        return refreshSettings();
      })
      .catch((err) => setNotice(`保存模型列表失败：${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setSettingsSaving(false));
  }

  function handleToggleTool(name: string, enabled: boolean): void {
    void updateTool(name, { enabled })
      .then((updated) => {
        setTools((prev) => prev.map((tool) => (tool.name === name ? updated : tool)));
      })
      .catch((err) => setNotice(`更新工具失败：${err instanceof Error ? err.message : String(err)}`));
  }

  function handleCleanupData(olderThanDays: number): void {
    void cleanupData(olderThanDays)
      .then((result) => {
        setNotice(`已清理 ${result.deletedTasks} 个任务、${result.deletedTraces} 条轨迹`);
        return refreshSettings();
      })
      .catch((err) => setNotice(`清理数据失败：${err instanceof Error ? err.message : String(err)}`));
  }

  function handleCreateMemory(content: string, category: MemoryCategory): void {
    void createMemory({ content, category })
      .then((created) => setMemories((prev) => [created, ...prev]))
      .catch((err) => setNotice(`新增记忆失败：${err instanceof Error ? err.message : String(err)}`));
  }

  function handleToggleMemory(id: string, enabled: boolean): void {
    void updateMemory(id, { enabled })
      .then((updated) => setMemories((prev) => prev.map((m) => (m.id === id ? updated : m))))
      .catch((err) => setNotice(`更新记忆失败：${err instanceof Error ? err.message : String(err)}`));
  }

  function handleEditMemory(id: string, content: string, category: MemoryCategory): void {
    void updateMemory(id, { content, category })
      .then((updated) => setMemories((prev) => prev.map((m) => (m.id === id ? updated : m))))
      .catch((err) => setNotice(`编辑记忆失败：${err instanceof Error ? err.message : String(err)}`));
  }

  function handleDeleteMemory(id: string): void {
    void deleteMemory(id)
      .then(() => setMemories((prev) => prev.filter((m) => m.id !== id)))
      .catch((err) => setNotice(`删除记忆失败：${err instanceof Error ? err.message : String(err)}`));
  }

  function handleFontScaleChange(nextScale: number): void {
    setFontScale(clamp(nextScale, MIN_FONT_SCALE, MAX_FONT_SCALE));
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
        onNewTask={handleNewTask}
        onSelectTask={handleSelectTask}
        onCollapse={() => setLeftCollapsed(true)}
        onOpenSearch={handleOpenSearch}
        onOpenTools={handleOpenTools}
        onOpenMemory={handleOpenMemory}
        onOpenSettings={handleOpenSettings}
      />

      <div
        className="resize-handle resize-handle-left"
        role="separator"
        aria-label="调整左侧栏宽度"
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
                aria-label="展开左侧栏"
              >
                <SidebarIcon />
              </button>
            )}
          </div>
          {isChatView && showConversation ? (
            <>
              <div className="topbar-context">
                <StatusPill status={status} phase={phase} />
                <div className="topbar-title-group">
                  <span className="topbar-title">{currentTask?.goal}</span>
                  <span className="topbar-subtitle">
                    {getPhaseLabel(phase) || getStatusLabel(status)} · {currentTask?.messages.length ?? 0} 条消息
                  </span>
                </div>
              </div>
              <div className="topbar-actions">
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={handleRetry}
                  disabled={!currentTask}
                >
                  重试
                </button>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => void handleResumeTask()}
                  disabled={!canResume}
                >
                  恢复
                </button>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={handleStopStream}
                  disabled={!busy}
                >
                  停止
                </button>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => setInspectorOpen((open) => !open)}
                >
                  {inspectorOpen ? "隐藏详情" : "运行详情"}
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
                  {inspectorOpen ? "隐藏详情" : "运行详情"}
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
        ) : activeView === "memory" ? (
          <MemoryPanel
            open
            memories={memories}
            onClose={() => setActiveView("chat")}
            onCreate={handleCreateMemory}
            onToggle={handleToggleMemory}
            onEdit={handleEditMemory}
            onDelete={handleDeleteMemory}
          />
        ) : activeView === "settings" ? (
          <SettingsPanel
            settings={runtimeSettings}
            tools={tools}
            mcpServers={mcpServers}
            dataStatus={dataStatus}
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
          />
        ) : showConversation ? (
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
                onToolDecision={handleToolDecision}
                onClarificationAnswer={handleClarificationAnswer}
                onArtifactDecision={handleArtifactDecision}
              />
            </div>
            <div className="composer-dock">
              <Composer
                value={goal}
                busy={busy}
                online={online}
                variant="docked"
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
        ) : (
          <div className="hero">
            <h1 className="hero-title">我们应该在 Aurevoy 中构建什么？</h1>
            <Composer
              value={goal}
              busy={busy}
              online={online}
              variant="hero"
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
        aria-label="调整右侧栏宽度"
        onPointerDown={(event) => startResize("right", event)}
      />

      <InspectorPanel
        open={inspectorOpen}
        events={events}
        health={health}
        task={currentTask}
        phase={phase}
        traces={traces}
        tools={tools}
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
      <button type="button" className="toast-close" onClick={onClose} aria-label="关闭通知">
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
  if (view === "search") return "搜索";
  if (view === "tools") return "工具";
  if (view === "memory") return "记忆";
  if (view === "settings") return "设置";
  return "对话";
}

function getMainViewSubtitle(view: MainView): string {
  if (view === "search") return "搜索本地对话历史";
  if (view === "tools") return "来自后端工具注册表的真实工具";
  if (view === "memory") return "长期记忆管理";
  if (view === "settings") return "模型、MCP、工具、数据与字体";
  return "目标、计划与执行结果";
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
          <h1>搜索</h1>
          <p>当前搜索范围是本地任务历史，不包含未接入的全局文件索引。</p>
        </div>
      </header>
      <input
        className="page-search-input"
        value={query}
        placeholder="输入目标关键词"
        onChange={(event) => onQueryChange(event.currentTarget.value)}
      />
      <div className="page-list">
        {filteredTasks.length === 0 ? (
          <p className="page-empty">没有匹配的对话</p>
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
          <h1>工具</h1>
          <p>工具列表来自 Agent 后端注册表，启停会写回运行时设置。</p>
        </div>
      </header>
      <div className="tool-page-grid">
        {tools.length === 0 ? (
          <p className="page-empty">未发现可用工具</p>
        ) : (
          tools.map((tool) => (
            <article key={tool.name} className="tool-page-card">
              <header>
                <strong>{tool.name}</strong>
                <span>{tool.source?.type === "mcp" ? `MCP:${tool.source.serverName}` : "内置"}</span>
              </header>
              <p>{tool.description}</p>
              <label className="memory-toggle tool-page-toggle">
                <input
                  type="checkbox"
                  checked={tool.enabled !== false}
                  onChange={(event) => onToggleTool(tool.name, event.currentTarget.checked)}
                />
                <span>
                  {tool.enabled === false ? "停用" : "启用"} · {tool.riskLevel ?? "safe"}
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
