import { useEffect, useRef, useState } from "react";
import type {
  AgentEvent,
  HealthResponse,
  PlanStep,
  Task,
  TaskStatus,
  ToolDescriptor,
} from "@aurevoy/shared";
import { checkHealth, createTask, listTasks, listTools, streamTask } from "./lib/api";
import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { InspectorPanel } from "./components/InspectorPanel";
import { TaskHistorySidebar } from "./components/TaskHistorySidebar";
import { StatusPill } from "./components/StatusPill";
import type { FeedItem } from "./components/AgentEventFeed";
import "./App.css";

function getAssistantOutput(task: Task): string {
  return task.messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.content)
    .join("\n\n");
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
  const [online, setOnline] = useState<boolean | null>(null);
  const [output, setOutput] = useState("");
  const [plan, setPlan] = useState<PlanStep[]>([]);
  const [status, setStatus] = useState<TaskStatus | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tools, setTools] = useState<ToolDescriptor[]>([]);
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
    } catch {
      setHealth(null);
      setOnline(false);
    }
  }

  function applyTaskSnapshot(task: Task): void {
    setCurrentTask(task);
    setStatus(task.status);
    setPlan(task.plan);
    setOutput(getAssistantOutput(task));
    setGoal("");
    setEvents([]);
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
        setPlan(event.task.plan);
        setOutput(getAssistantOutput(event.task));
        updateTaskList(event.task);
        break;
      case "status":
        setStatus(event.status);
        patchCurrentTask({ status: event.status });
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
        setOutput((previous) =>
          event.message.role === "assistant" && !previous ? event.message.content : previous,
        );
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
        setBusy(false);
        patchCurrentTask({ status: event.status });
        esRef.current?.close();
        void refreshRuntime();
        break;
      case "error":
        setStatus("failed");
        setOutput((previous) =>
          previous ? `${previous}\n\n[错误] ${event.message}` : `[错误] ${event.message}`,
        );
        setBusy(false);
        patchCurrentTask({ status: "failed" });
        break;
    }
  }

  async function startGoal(rawGoal: string): Promise<void> {
    const trimmed = rawGoal.trim();
    if (!trimmed || busy) return;

    setBusy(true);
    setEvents([]);
    setOutput("");
    setPlan([]);
    setStatus("pending");
    setGoal("");
    esRef.current?.close();

    try {
      const { task } = await createTask(trimmed);
      setCurrentTask(task);
      updateTaskList(task);
      esRef.current = streamTask(task.id, handleEvent, () => {
        setBusy(false);
      });
    } catch (err) {
      setStatus("failed");
      setOutput(`无法连接 Agent 引擎：${err instanceof Error ? err.message : String(err)}`);
      setBusy(false);
      setOnline(false);
    }
  }

  function handleSelectTask(task: Task): void {
    esRef.current?.close();
    setBusy(false);
    applyTaskSnapshot(task);
  }

  function handleNewTask(): void {
    esRef.current?.close();
    setBusy(false);
    setCurrentTask(null);
    setStatus(null);
    setPlan([]);
    setOutput("");
    setEvents([]);
    setGoal("");
  }

  function handleRetry(): void {
    if (!currentTask) return;
    void startGoal(currentTask.goal);
  }

  function handleStopStream(): void {
    esRef.current?.close();
    setBusy(false);
  }

  const showConversation = currentTask !== null;

  return (
    <div className="app-shell">
      <TaskHistorySidebar
        activeTaskId={currentTask?.id}
        tasks={tasks}
        onNewTask={handleNewTask}
        onSelectTask={handleSelectTask}
        onOpenInspector={() => setInspectorOpen(true)}
      />

      <main className="main">
        <header className="topbar">
          {showConversation ? (
            <>
              <StatusPill status={status} />
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

        {showConversation ? (
          <>
            <div className="main-scroll">
              <Conversation
                task={currentTask}
                status={status}
                plan={plan}
                output={output}
                busy={busy}
              />
            </div>
            <div className="composer-dock">
              <Composer
                value={goal}
                busy={busy}
                online={online}
                variant="docked"
                onChange={setGoal}
                onSubmit={() => void startGoal(goal)}
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
              onChange={setGoal}
              onSubmit={() => void startGoal(goal)}
            />
          </div>
        )}
      </main>

      <InspectorPanel
        open={inspectorOpen}
        events={events}
        health={health}
        task={currentTask}
        tools={tools}
        onClose={() => setInspectorOpen(false)}
      />
    </div>
  );
}

export default App;
