import type { Task } from "@aurevoy/shared";
import { t } from "../i18n";
import { PlanProgress } from "./PlanProgress";
import { shouldShowPlanProgress } from "./planStatus";
import "./PlanFloatPanel.css";

/** 右侧栏的独立计划卡；与产物同列，但不共享视觉卡片。 */
export function PlanFloatPanel({
  task,
}: {
  task: Task | null;
}) {
  if (!task || !shouldShowPlanProgress(task.plan)) return null;

  return (
    <aside className="plan-float" aria-label={t("plan.title")}>
      <div className="plan-float-body">
        <PlanProgress plan={task.plan} />
      </div>
    </aside>
  );
}
