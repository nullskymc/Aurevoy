import type { PlanStep, PlanStepStatus, Task } from '@aurevoy/shared';
import { taskEvents } from './events.js';

/** 启发式三步模板 id（createInitialPlan 产出）。 */
export const HEURISTIC_STEP = {
  discover: 'discover',
  synthesize: 'synthesize',
  deliver: 'deliver',
} as const;

/** 只读/检索类工具：多落在 discover。 */
const EXPLORE_TOOL =
  /^(read|open_file|list_directory|list_dir|glob|grep|search_grep|search_files|web_search|web_fetch|scroll|recall|index_files|memory_|get_|load_skill)/i;

/** 写入/产出类工具：推进到 synthesize→deliver。 */
const PRODUCE_TOOL =
  /^(write|edit|create_file|append_file|replace_lines|apply_artifact|create_artifact|bash|execute_command|attach_content|delete_file|move_file|copy_file|install_skill)/i;

export function isHeuristicTriPlan(plan: PlanStep[]): boolean {
  if (plan.length < 3) return false;
  const ids = new Set(plan.map((step) => step.id));
  return (
    ids.has(HEURISTIC_STEP.discover) &&
    ids.has(HEURISTIC_STEP.synthesize) &&
    ids.has(HEURISTIC_STEP.deliver)
  );
}

/**
 * 工具成功后推进启发式计划。
 * - discover：任意成功工具 → 完成，进入 synthesize；若已是产出类则再进 deliver
 * - synthesize：产出类或非探索类工具 → 完成，进入 deliver
 * - deliver：保持 running，直到任务收尾
 */
export function advancePlanAfterTool(task: Task, toolName: string, ok: boolean): boolean {
  if (!ok || !isHeuristicTriPlan(task.plan)) return false;
  const running = currentRunningStep(task.plan);
  if (!running) return ensureSomethingRunning(task);

  if (running.id === HEURISTIC_STEP.discover) {
    completeAndStartNext(task, HEURISTIC_STEP.discover, HEURISTIC_STEP.synthesize);
    if (PRODUCE_TOOL.test(toolName)) {
      completeAndStartNext(task, HEURISTIC_STEP.synthesize, HEURISTIC_STEP.deliver);
    }
    return true;
  }

  if (running.id === HEURISTIC_STEP.synthesize) {
    // 纯探索可继续整理；产出或其它动作进入交付
    if (PRODUCE_TOOL.test(toolName) || !EXPLORE_TOOL.test(toolName)) {
      completeAndStartNext(task, HEURISTIC_STEP.synthesize, HEURISTIC_STEP.deliver);
      return true;
    }
  }

  return false;
}

/**
 * 助手发出无工具的终稿时：跳过尚未完成的中间步，进入 deliver。
 */
export function advancePlanAfterFinalAnswer(task: Task): boolean {
  if (!isHeuristicTriPlan(task.plan)) return false;
  const running = currentRunningStep(task.plan);
  if (!running || running.id === HEURISTIC_STEP.deliver) return false;

  let changed = false;
  for (const step of task.plan) {
    if (step.id === HEURISTIC_STEP.deliver) continue;
    if (step.status === 'running' || step.status === 'pending') {
      setStepStatus(task, step.id, 'completed');
      changed = true;
    }
  }
  const deliver = task.plan.find((step) => step.id === HEURISTIC_STEP.deliver);
  if (deliver && deliver.status !== 'completed') {
    setStepStatus(task, HEURISTIC_STEP.deliver, 'running');
    changed = true;
  }
  return changed;
}

/** 任务成功结束：所有未终态步骤标为 completed。 */
export function completePlanOnSuccess(task: Task): boolean {
  return settleOpenSteps(task, 'completed');
}

/** 任务失败/取消：running→failed，其余未完成→cancelled。 */
export function failOpenPlanSteps(task: Task): boolean {
  let changed = false;
  const next = task.plan.map((step) => {
    if (step.status === 'completed' || step.status === 'failed' || step.status === 'cancelled') {
      return step;
    }
    changed = true;
    if (step.status === 'running') return { ...step, status: 'failed' as const };
    return { ...step, status: 'cancelled' as const };
  });
  if (!changed) return false;
  task.plan = next;
  taskEvents.publish({ type: 'plan', taskId: task.id, plan: task.plan });
  return true;
}

/**
 * 续跑时：已 completed 保留；第一个未完成的标 running，其后 pending。
 * （旧逻辑用 index===0，会在首步已完成时让后续全变 pending、无 running。）
 */
export function resumeIncompletePlan(plan: PlanStep[]): PlanStep[] {
  let started = false;
  return plan.map((step) => {
    if (step.status === 'completed') return step;
    if (!started) {
      started = true;
      return { ...step, status: 'running' };
    }
    return { ...step, status: 'pending' };
  });
}

function currentRunningStep(plan: PlanStep[]): PlanStep | undefined {
  return plan.find((step) => step.status === 'running');
}

function ensureSomethingRunning(task: Task): boolean {
  const firstOpen = task.plan.find(
    (step) => step.status === 'pending' || step.status === 'paused' || step.status === 'proposed',
  );
  if (!firstOpen) return false;
  setStepStatus(task, firstOpen.id, 'running');
  return true;
}

function completeAndStartNext(task: Task, doneId: string, nextId: string): void {
  setStepStatus(task, doneId, 'completed');
  const next = task.plan.find((step) => step.id === nextId);
  if (next && next.status !== 'completed' && next.status !== 'failed' && next.status !== 'cancelled') {
    setStepStatus(task, nextId, 'running');
  }
}

function setStepStatus(task: Task, stepId: string, status: PlanStepStatus): void {
  const index = task.plan.findIndex((step) => step.id === stepId);
  if (index < 0) return;
  const previous = task.plan[index]!;
  if (previous.status === status) return;
  const step: PlanStep = { ...previous, status };
  task.plan = task.plan.map((item, i) => (i === index ? step : item));
  taskEvents.publish({ type: 'step_update', taskId: task.id, step });
}

function settleOpenSteps(task: Task, status: 'completed'): boolean {
  let changed = false;
  const next = task.plan.map((step) => {
    if (step.status === 'completed' || step.status === 'failed' || step.status === 'cancelled') {
      return step;
    }
    changed = true;
    return { ...step, status };
  });
  if (!changed) return false;
  task.plan = next;
  taskEvents.publish({ type: 'plan', taskId: task.id, plan: task.plan });
  return true;
}
