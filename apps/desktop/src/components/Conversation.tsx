import { useEffect, useRef, useState } from "react";
import type { Message, PlanStep, Task, TaskPhase, TaskStatus, ToolRiskLevel } from "@aurevoy/shared";
import { StatusPill } from "./StatusPill";
import { getPhaseLabel, getStatusLabel } from "./status";

/** 一次工具调用在 UI 中的活动状态（由 App 从事件或消息派生） */
export interface ToolActivity {
  id: string;
  name: string;
  args: unknown;
  status: "awaiting" | "running" | "ok" | "error";
  riskLevel?: ToolRiskLevel;
  output?: unknown;
  error?: string;
}

interface ConversationProps {
  task: Task;
  status: TaskStatus | null;
  phase: TaskPhase | null;
  plan: PlanStep[];
  /** 当前正在生成的这一轮的流式文本尾巴（仅运行中有值） */
  output: string;
  busy: boolean;
  /** 当前运行轮次的实时工具活动（来自事件流） */
  liveToolActivity: ToolActivity[];
  /** 工具审批决策回调（批准/拒绝） */
  onToolDecision: (callId: string, approved: boolean) => void;
}

interface ToolResultInfo {
  ok: boolean;
  output?: unknown;
  error?: string;
}

/** 扫描消息，建立 toolCallId → 工具结果 的映射 */
function buildToolResultMap(messages: Message[]): Map<string, ToolResultInfo> {
  const map = new Map<string, ToolResultInfo>();
  for (const message of messages) {
    if (message.role !== "tool" || !message.toolCallId) continue;
    let parsed: unknown = message.content;
    try {
      parsed = JSON.parse(message.content);
    } catch {
      /* 保留原文 */
    }
    if (parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)) {
      map.set(message.toolCallId, {
        ok: false,
        error: String((parsed as Record<string, unknown>).error),
      });
    } else {
      map.set(message.toolCallId, { ok: true, output: parsed });
    }
  }
  return map;
}

/** 把一条 assistant 消息携带的 toolCalls 派生为工具活动卡片数据 */
function toolActivitiesFromAssistant(
  message: Message,
  resultMap: Map<string, ToolResultInfo>,
): ToolActivity[] {
  if (!message.toolCalls?.length) return [];
  return message.toolCalls.map((tc) => {
    let args: unknown = {};
    try {
      args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      args = tc.function.arguments;
    }
    const result = resultMap.get(tc.id);
    return {
      id: tc.id,
      name: tc.function.name,
      args,
      status: result ? (result.ok ? "ok" : "error") : "running",
      output: result?.output,
      error: result?.error,
    };
  });
}

export function Conversation({
  task,
  status,
  phase,
  plan,
  output,
  busy,
  liveToolActivity,
  onToolDecision,
}: ConversationProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // 新内容到达时平滑滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [output, phase, plan, status, liveToolActivity, task.messages.length]);

  const messages = task.messages;
  const resultMap = buildToolResultMap(messages);

  // 运行中时：已结束的历史渲染到“最后一条用户消息”为止，
  // 当前轮的产出（文本/工具）走实时 live 尾巴，避免与已提交消息重复。
  let lastUserIndex = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") lastUserIndex = index;
  });
  const historyEnd = busy ? lastUserIndex : messages.length - 1;
  const historyMessages = messages.slice(0, historyEnd + 1);

  const hasOutput = output.trim().length > 0;
  const thinking = busy && !hasOutput && liveToolActivity.length === 0;
  const stillWorking = busy && (hasOutput || liveToolActivity.length > 0);

  return (
    <div className="conversation">
      <div className="conversation-thread">
        {historyMessages.map((message) => {
          if (message.role === "user") {
            return (
              <div className="msg msg-user" key={message.id}>
                <div className="msg-bubble">{message.content}</div>
              </div>
            );
          }
          if (message.role === "assistant") {
            const tools = toolActivitiesFromAssistant(message, resultMap);
            const hasText = message.content.trim().length > 0;
            if (!hasText && tools.length === 0) return null;
            return (
              <div className="msg msg-agent" key={message.id}>
                <div className="msg-avatar">A</div>
                <div className="msg-body">
                  {tools.length > 0 && (
                    <ToolActivityList items={tools} onDecision={onToolDecision} />
                  )}
                  {hasText && <div className="agent-text">{message.content}</div>}
                </div>
              </div>
            );
          }
          return null;
        })}

        {/* 当前运行轮次的实时尾巴 */}
        {busy && (
          <div className="msg msg-agent">
            <div className="msg-avatar">A</div>
            <div className="msg-body">
              {plan.length > 0 && <PlanCard plan={plan} />}

              {liveToolActivity.length > 0 && (
                <ToolActivityList items={liveToolActivity} onDecision={onToolDecision} />
              )}

              {thinking ? (
                <div className="agent-thinking">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                  <span className="thinking-label">
                    {getPhaseLabel(phase) || getStatusLabel(status)}…
                  </span>
                </div>
              ) : (
                hasOutput && (
                  <div className="agent-text">
                    {output}
                    <span className="stream-caret" aria-hidden="true" />
                  </div>
                )
              )}

              {stillWorking && hasOutput && (
                <div className="agent-thinking agent-thinking-inline">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                  <span className="thinking-label">继续推进…</span>
                </div>
              )}
            </div>
          </div>
        )}

        {!busy && (
          <div className="msg-status">
            <StatusPill status={status} phase={phase} />
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function ToolActivityList({
  items,
  onDecision,
}: {
  items: ToolActivity[];
  onDecision: (callId: string, approved: boolean) => void;
}) {
  return (
    <div className="tool-activity">
      {items.map((item) => (
        <ToolActivityCard key={item.id} item={item} onDecision={onDecision} />
      ))}
    </div>
  );
}

function toolStatusIcon(status: ToolActivity["status"]): string {
  switch (status) {
    case "ok":
      return "✓";
    case "error":
      return "✕";
    case "awaiting":
      return "!";
    case "running":
    default:
      return "◌";
  }
}

function ToolActivityCard({
  item,
  onDecision,
}: {
  item: ToolActivity;
  onDecision: (callId: string, approved: boolean) => void;
}) {
  const [open, setOpen] = useState(item.status === "awaiting");
  const [decided, setDecided] = useState(false);

  // 状态变为待确认时自动展开（useState 初始值不随 props 更新，需 effect 补齐）
  useEffect(() => {
    if (item.status === "awaiting") setOpen(true);
  }, [item.status]);

  const statusText =
    item.status === "awaiting"
      ? "待确认"
      : item.status === "running"
        ? "执行中"
        : item.status === "ok"
          ? "完成"
          : "失败";
  const icon = toolStatusIcon(item.status);
  const detail =
    item.status === "error"
      ? item.error ?? "未知错误"
      : item.output !== undefined
        ? safeStringify(item.output)
        : null;
  const argsText = safeStringify(item.args);

  function decide(approved: boolean) {
    setDecided(true);
    onDecision(item.id, approved);
  }

  return (
    <section className="tool-card" data-status={item.status} aria-label={`工具调用 ${item.name}`}>
      <button type="button" className="tool-card-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-card-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="tool-card-name">{item.name}</span>
        {item.riskLevel && item.riskLevel !== "safe" && (
          <span className="tool-card-risk" data-risk={item.riskLevel}>
            {item.riskLevel === "dangerous" ? "高风险" : "需确认"}
          </span>
        )}
        <span className="tool-card-status">{statusText}</span>
        <span className="tool-card-caret" data-open={open} aria-hidden="true">
          ⌄
        </span>
      </button>
      {open && (
        <div className="tool-card-body">
          {argsText !== "{}" && (
            <div className="tool-card-field">
              <span className="tool-card-field-label">参数</span>
              <pre>{argsText}</pre>
            </div>
          )}
          {detail !== null && (
            <div className="tool-card-field">
              <span className="tool-card-field-label">{item.status === "error" ? "错误" : "结果"}</span>
              <pre>{detail}</pre>
            </div>
          )}
        </div>
      )}
      {item.status === "awaiting" && (
        <div className="tool-approval">
          <span className="tool-approval-hint">该工具需要你的确认才能执行</span>
          <div className="tool-approval-actions">
            <button
              type="button"
              className="tool-approval-btn reject"
              disabled={decided}
              onClick={() => decide(false)}
            >
              拒绝
            </button>
            <button
              type="button"
              className="tool-approval-btn approve"
              disabled={decided}
              onClick={() => decide(true)}
            >
              批准
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function PlanCard({ plan }: { plan: PlanStep[] }) {
  const [open, setOpen] = useState(true);
  const done = plan.filter((step) => step.status === "completed").length;

  return (
    <section className="plan-card" aria-label="执行计划">
      <button type="button" className="plan-card-head" onClick={() => setOpen((value) => !value)}>
        <span className="plan-card-title">执行计划</span>
        <span className="plan-card-progress">
          {done}/{plan.length}
        </span>
        <span className="plan-card-caret" data-open={open}>
          ⌄
        </span>
      </button>

      {open && (
        <ol className="plan-steps">
          {plan.map((step, index) => (
            <li key={step.id} className="plan-step" data-status={step.status}>
              <span className="plan-step-marker">
                {step.status === "completed" ? "✓" : String(index + 1).padStart(2, "0")}
              </span>
              <span className="plan-step-text">{step.description}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
