import { useEffect, useRef, useState } from "react";
import type { PlanStep, Task, TaskPhase, TaskStatus, ToolRiskLevel } from "@aurevoy/shared";
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
  output: string;
  busy: boolean;
  toolActivity: ToolActivity[];
  /** 工具审批决策回调（批准/拒绝） */
  onToolDecision: (callId: string, approved: boolean) => void;
}

export function Conversation({
  task,
  status,
  phase,
  plan,
  output,
  busy,
  toolActivity,
  onToolDecision,
}: ConversationProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // 新内容到达时平滑滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [output, phase, plan, status, toolActivity]);

  const hasOutput = output.trim().length > 0;
  // 还没有任何可见产出（文本/工具）时显示思考态
  const thinking = busy && !hasOutput && toolActivity.length === 0;
  // 有产出但仍在忙（如工具执行后等待下一轮）时显示轻量"继续思考"指示
  const stillWorking = busy && (hasOutput || toolActivity.length > 0);

  return (
    <div className="conversation">
      <div className="conversation-thread">
        {/* 用户目标气泡 */}
        <div className="msg msg-user">
          <div className="msg-bubble">{task.goal}</div>
        </div>

        {/* Agent 回复 */}
        <div className="msg msg-agent">
          <div className="msg-avatar">A</div>
          <div className="msg-body">
            {plan.length > 0 && <PlanCard plan={plan} />}

            {toolActivity.length > 0 && (
              <ToolActivityList items={toolActivity} onDecision={onToolDecision} />
            )}

            {thinking ? (
              <div className="agent-thinking">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
                <span className="thinking-label">{getPhaseLabel(phase) || getStatusLabel(status)}…</span>
              </div>
            ) : (
              hasOutput && (
                <div className="agent-text">
                  {output}
                  {busy && <span className="stream-caret" aria-hidden="true" />}
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

            {!busy && (
              <div className="msg-status">
                <StatusPill status={status} phase={phase} />
              </div>
            )}
          </div>
        </div>

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
