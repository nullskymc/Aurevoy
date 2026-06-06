import type { PlanStep } from "@aurevoy/shared";
import { StatusPill } from "./StatusPill";

interface PlanTimelineProps {
  plan: PlanStep[];
}

export function PlanTimeline({ plan }: PlanTimelineProps) {
  return (
    <section className="workspace-section" aria-labelledby="plan-title">
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">Plan</p>
          <h2 id="plan-title">执行计划</h2>
        </div>
        <span className="section-count">{plan.length} 步</span>
      </div>

      {plan.length === 0 ? (
        <div className="empty-state">创建任务后，Aurevoy 会在这里展示计划。</div>
      ) : (
        <ol className="timeline">
          {plan.map((step, index) => (
            <li key={step.id} className="timeline-item" data-status={step.status}>
              <span className="timeline-index">{String(index + 1).padStart(2, "0")}</span>
              <div>
                <p>{step.description}</p>
                <StatusPill status={step.status} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
