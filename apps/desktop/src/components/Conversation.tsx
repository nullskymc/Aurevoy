import { useEffect, useRef, useState } from "react";
import type { PlanStep, Task, TaskStatus } from "@aurevoy/shared";
import { StatusPill } from "./StatusPill";
import { getStatusLabel } from "./status";

/** 一次工具调用在 UI 中的活动状态（由 App 从事件或消息派生） */
export interface ToolActivity {
  id: string;
  name: string;
  args: unknown;
  status: "running" | "ok" | "error";
  output?: unknown;
  error?: string;
}

interface ConversationProps {
  task: Task;
  status: TaskStatus | null;
  plan: PlanStep[];
  output: string;
  busy: boolean;
  toolActivity: ToolActivity[];
}

export function Conversation({ task, status, plan, output, busy, toolActivity }: ConversationProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // 新内容到达时平滑滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [output, plan, status, toolActivity]);

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

            {toolActivity.length > 0 && <ToolActivityList items={toolActivity} />}

            {thinking ? (
              <div className="agent-thinking">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
                <span className="thinking-label">{getStatusLabel(status)}…</span>
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
                <StatusPill status={status} />
              </div>
            )}
          </div>
        </div>

        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function ToolActivityList({ items }: { items: ToolActivity[] }) {
  return (
    <div className="tool-activity">
      {items.map((item) => (
        <ToolActivityCard key={item.id} item={item} />
      ))}
    </div>
  );
}

function ToolActivityCard({ item }: { item: ToolActivity }) {
  const [open, setOpen] = useState(false);
  const statusText =
    item.status === "running" ? "执行中" : item.status === "ok" ? "完成" : "失败";
  const detail =
    item.status === "error"
      ? item.error ?? "未知错误"
      : item.output !== undefined
        ? safeStringify(item.output)
        : null;
  const argsText = safeStringify(item.args);

  return (
    <section className="tool-card" data-status={item.status} aria-label={`工具调用 ${item.name}`}>
      <button type="button" className="tool-card-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-card-icon" aria-hidden="true">
          {item.status === "running" ? "◌" : item.status === "ok" ? "✓" : "✕"}
        </span>
        <span className="tool-card-name">{item.name}</span>
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
