import { useEffect, useRef, useState } from "react";
import type { PlanStep, Task, TaskStatus } from "@aurevoy/shared";
import { StatusPill } from "./StatusPill";
import { getStatusLabel } from "./status";

interface ConversationProps {
  task: Task;
  status: TaskStatus | null;
  plan: PlanStep[];
  output: string;
  busy: boolean;
}

export function Conversation({ task, status, plan, output, busy }: ConversationProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // 新内容到达时平滑滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [output, plan, status]);

  const thinking = busy && !output;

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

            {thinking ? (
              <div className="agent-thinking">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
                <span className="thinking-label">{getStatusLabel(status)}…</span>
              </div>
            ) : (
              output && (
                <div className="agent-text">
                  {output}
                  {busy && <span className="stream-caret" aria-hidden="true" />}
                </div>
              )
            )}

            {!thinking && (
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
