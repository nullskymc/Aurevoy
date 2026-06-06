import type { FormEvent } from "react";
import type { PlanStep, Task, TaskStatus } from "@aurevoy/shared";
import { GoalComposer } from "./GoalComposer";
import { PlanTimeline } from "./PlanTimeline";
import { StatusPill } from "./StatusPill";

interface TaskWorkspaceProps {
  busy: boolean;
  goal: string;
  onGoalChange: (goal: string) => void;
  onRetry: () => void;
  onStopStream: () => void;
  onSubmit: (event: FormEvent) => void;
  onUseSuggestion: (goal: string) => void;
  online: boolean | null;
  output: string;
  plan: PlanStep[];
  status: TaskStatus | null;
  task: Task | null;
}

export function TaskWorkspace({
  busy,
  goal,
  onGoalChange,
  onRetry,
  onStopStream,
  onSubmit,
  onUseSuggestion,
  online,
  output,
  plan,
  status,
  task,
}: TaskWorkspaceProps) {
  return (
    <main id="workspace" className="workspace">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">Aurevoy Agent</p>
          <h1>目标驱动执行台</h1>
        </div>
        <div className="workspace-controls">
          <StatusPill status={status} />
          <button type="button" className="secondary-action" onClick={onRetry} disabled={!task}>
            重试
          </button>
          <button type="button" className="secondary-action" onClick={onStopStream} disabled={!busy}>
            停止订阅
          </button>
        </div>
      </header>

      <GoalComposer
        busy={busy}
        goal={goal}
        online={online}
        onGoalChange={onGoalChange}
        onSubmit={onSubmit}
        onUseSuggestion={onUseSuggestion}
      />

      <section className="task-overview" aria-label="当前任务">
        <div>
          <span>当前目标</span>
          <strong>{task?.goal ?? "等待新的目标"}</strong>
        </div>
        <div>
          <span>计划步骤</span>
          <strong>{plan.length}</strong>
        </div>
        <div>
          <span>输出长度</span>
          <strong>{output.length}</strong>
        </div>
      </section>

      <div className="workspace-grid">
        <PlanTimeline plan={plan} />

        <section className="workspace-section result-section" aria-labelledby="result-title">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Result</p>
              <h2 id="result-title">执行结果</h2>
            </div>
          </div>
          {output ? (
            <pre className="result-output">{output}</pre>
          ) : (
            <div className="empty-state">
              Aurevoy 的流式输出会固定在这里，不会挤压计划与检查器。
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
