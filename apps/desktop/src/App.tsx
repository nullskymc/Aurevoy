import { useEffect, useRef, useState } from "react";
import type {
  AgentEvent,
  HealthResponse,
  MemoryCategory,
  MemoryEntry,
  PlanStep,
  Task,
  TaskPhase,
  TaskStatus,
  TaskTraceEntry,
  ToolDescriptor,
} from "@aurevoy/shared";
import {
  approveToolCall,
  cancelTask,
  checkHealth,
  continueTask,
  createMemory,
  createTask,
  deleteMemory,
  getTask,
  listMemories,
  listTaskTraces,
  listTasks,
  listTools,
  streamTask,
  updateMemory,
} from "./lib/api";
import { Composer } from "./components/Composer";
import { Conversation, type ToolActivity } from "./components/Conversation";
import { InspectorPanel } from "./components/InspectorPanel";
import { MemoryPanel } from "./components/MemoryPanel";
import { TaskHistorySidebar } from "./components/TaskHistorySidebar";
import { StatusPill } from "./components/StatusPill";
import type { FeedItem } from "./components/AgentEventFeed";
import "./App.css";

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

function App() {
  const [busy, setBusy] = useState(false);
  const [currentTask, setCurrentTask] = useState<Task | null>(null);
  const [events, setEvents] = useState<FeedItem[]>([]);
  const [goal, setGoal] = useState("");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [online, setOnline] = useState<boolean | null>(null);
  const [output, setOutput] = useState("");
  const [phase, setPhase] = useState<TaskPhase | null>(null);
  const [plan, setPlan] = useState<PlanStep[]>([]);
  const [status, setStatus] = useState<TaskStatus | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [traces, setTraces] = useState<TaskTraceEntry[]>([]);
  const [tools, setTools] = useState<ToolDescriptor[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    void refreshRuntime();
    return () => esRef.current?.close();
  }, []);

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

  function applyTaskSnapshot(task: Task): void {
    setCurrentTask(task);
    setStatus(task.status);
    setPhase(task.phase);
    setPlan(task.plan);
    setOutput("");
    setGoal("");
    setEvents([]);
    void refreshTaskTraces(task.id);
  }

  async function refreshTaskTraces(taskId: string): Promise<void> {
    try {
      setTraces(await listTaskTraces(taskId));
    } catch (err) {
      setNotice(`读取任务轨迹失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function updateTaskList(task: Task): void {
    setTasks((previous) => {
      const withoutTask = previous.filter((item) => item.id !== task.id);
      return [task, ...withoutTask].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    });
  }

  function patchCurrentTask(patch: Partial<Task>): void {
    setCurrentTask((previous) => {
      if (!previous) return previous;
      const nextTask = { ...previous, ...patch };
      updateTaskList(nextTask);
      return nextTask;
    });
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
        esRef.current?.close();
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
    esRef.current?.close();

    try {
      const { task } = await createTask(trimmed);
      setCurrentTask(task);
      setPhase(task.phase);
      setTraces([]);
      updateTaskList(task);
      esRef.current = streamTask(task.id, handleEvent, () => {
        setBusy(false);
      });
    } catch (err) {
      setStatus("failed");
      setOutput(`无法连接 Agent 引擎：${err instanceof Error ? err.message : String(err)}`);
      setBusy(false);
      // 仅网络层失败才标记离线；HTTP 错误不代表引擎离线
      if (err instanceof TypeError) setOnline(false);
    }
  }

  function handleSelectTask(task: Task): void {
    esRef.current?.close();
    setBusy(false);
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
    esRef.current?.close();

    try {
      const { task } = await continueTask(currentTask.id, trimmed);
      setCurrentTask(task);
      setPhase(task.phase);
      updateTaskList(task);
      esRef.current = streamTask(task.id, handleEvent, () => {
        setBusy(false);
      });
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
    esRef.current?.close();
    setBusy(false);
    setCurrentTask(null);
    setStatus(null);
    setPhase(null);
    setPlan([]);
    setOutput("");
    setEvents([]);
    setTraces([]);
    setGoal("");
  }

  function handleRetry(): void {
    if (!currentTask) return;
    void startGoal(currentTask.goal);
  }

  function handleStopStream(): void {
    esRef.current?.close();
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

  async function refreshMemories(): Promise<void> {
    try {
      setMemories(await listMemories());
    } catch (err) {
      setNotice(`读取记忆失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleOpenMemory(): void {
    setMemoryOpen(true);
    void refreshMemories();
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

  const showConversation = currentTask !== null;

  // 当前运行轮次的实时工具活动（来自事件流）；历史轮次由 Conversation 从消息派生
  const liveToolActivity = deriveToolActivityFromEvents(events);

  return (
    <div className="app-shell">
      <TaskHistorySidebar
        activeTaskId={currentTask?.id}
        tasks={tasks}
        onNewTask={handleNewTask}
        onSelectTask={handleSelectTask}
        onOpenInspector={() => setInspectorOpen(true)}
        onOpenMemory={handleOpenMemory}
      />

      <main className="main">
        <header className="topbar">
          {showConversation ? (
            <>
              <StatusPill status={status} phase={phase} />
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
                  onClick={handleStopStream}
                  disabled={!busy}
                >
                  停止
                </button>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => setInspectorOpen(true)}
                >
                  运行详情
                </button>
              </div>
            </>
          ) : (
            <span />
          )}
        </header>

        {notice && (
          <div className="notice-banner" role="alert">
            <span>{notice}</span>
            <button type="button" className="notice-close" onClick={() => setNotice(null)} aria-label="关闭">
              ✕
            </button>
          </div>
        )}

        {showConversation ? (
          <>
            <div className="main-scroll">
              <Conversation
                task={currentTask}
                status={status}
                phase={phase}
                plan={plan}
                output={output}
                busy={busy}
                liveToolActivity={liveToolActivity}
                onToolDecision={handleToolDecision}
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
                onStop={handleStopStream}
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
              onStop={handleStopStream}
            />
          </div>
        )}
      </main>

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

      <MemoryPanel
        open={memoryOpen}
        memories={memories}
        onClose={() => setMemoryOpen(false)}
        onCreate={handleCreateMemory}
        onToggle={handleToggleMemory}
        onEdit={handleEditMemory}
        onDelete={handleDeleteMemory}
      />
    </div>
  );
}

export default App;
