import type { PlanStep, PlanStepStatus, Task } from '@aurevoy/shared';
import { taskEvents } from './events.js';

/** 启发式三步模板 id（createInitialPlan 产出）。 */
export const HEURISTIC_STEP = {
  discover: 'discover',
  synthesize: 'synthesize',
  deliver: 'deliver',
} as const;

/**
 * Whether the goal should get a real multi-step plan (not a single fake `exec` step).
 * OpenCode-style: multi-step work needs visible progress; only trivial turns stay single-step.
 */
export function shouldUseMultiStepPlan(goal: string): boolean {
  const g = goal.trim();
  if (!g) return false;
  // Pure greetings / one-shot pings stay single-step
  if (/^(你好|您好|hi|hello|hey|哈喽|在吗|ping|测试一下?|test)\s*[!！.。]*$/i.test(g)) {
    return false;
  }
  // Explicit multi-step / deliverable / configure / fix language
  if (
    /(整理|报告|Markdown|材料|多步|计划|配置|接入|安装|部署|设置|修复|实现|重构|调研|简报|mcp|setup|config|install|integrat|report|markdown|plan|summari[sz]e|organize|fix|implement|debug)/i.test(
      g,
    )
  ) {
    return true;
  }
  // Longer goals are almost always multi-step
  if (g.length >= 24) return true;
  // Short but action-like
  if (/(帮我|请|需要|实现|写|改|查|找)/.test(g) && g.length >= 8) return true;
  return false;
}

/** Create durable initial plan steps for a task goal. */
export function createInitialPlanSteps(goal: string): PlanStep[] {
  if (!shouldUseMultiStepPlan(goal)) {
    return [{ id: 'exec', description: 'Agent 执行任务', status: 'running', source: 'heuristic' }];
  }
  const configureLike = /(配置|接入|安装|mcp|setup|config|install|integrat)/i.test(goal);
  if (configureLike) {
    return [
      {
        id: HEURISTIC_STEP.discover,
        description: '定位二进制/入口与当前配置状态',
        status: 'running',
        source: 'heuristic',
        verifiable: true,
      },
      {
        id: HEURISTIC_STEP.synthesize,
        description: '写入或应用配置（最小改动）',
        status: 'pending',
        source: 'heuristic',
        verifiable: true,
      },
      {
        id: HEURISTIC_STEP.deliver,
        description: '验证结果并向用户汇报（成功或阻塞原因）',
        status: 'pending',
        source: 'heuristic',
        verifiable: true,
      },
    ];
  }
  return [
    {
      id: HEURISTIC_STEP.discover,
      description: '搜集并确认本地材料与约束',
      status: 'running',
      source: 'heuristic',
    },
    {
      id: HEURISTIC_STEP.synthesize,
      description: '整理关键信息并形成结构/改动',
      status: 'pending',
      source: 'heuristic',
    },
    {
      id: HEURISTIC_STEP.deliver,
      description: '输出最终结果并检查完整性',
      status: 'pending',
      source: 'heuristic',
      verifiable: true,
    },
  ];
}

/** Mark the current running step as blocked (incomplete until user/env unblocks). */
export function markRunningPlanBlocked(task: Task, reason: string): boolean {
  const running = currentRunningStep(task.plan);
  if (!running) return false;
  const index = task.plan.findIndex((step) => step.id === running.id);
  if (index < 0) return false;
  const step: PlanStep = {
    ...task.plan[index]!,
    status: 'blocked',
    blockedReason: reason,
  };
  task.plan = task.plan.map((item, i) => (i === index ? step : item));
  taskEvents.publish({ type: 'step_update', taskId: task.id, step });
  return true;
}

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
  if (!ok) return false;
  // 模型计划由 update_plan 显式维护；自动猜测工具与步骤的对应关系会制造虚假进度。
  if (!isHeuristicTriPlan(task.plan)) return false;
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
 * 续跑时：已 completed 保留；第一个未完成的（含 failed/cancelled/blocked/paused）标 running，其后 pending。
 * cancel / failOpenPlanSteps / 进程崩溃 recovery 会把 open 步标成 failed/cancelled；
 * 用户 resume 必须重新打开第一步未完成工作，否则没有 currentRunningStep。
 */
export function resumeIncompletePlan(plan: PlanStep[]): PlanStep[] {
  let started = false;
  return plan.map((step) => {
    if (step.status === 'completed') return step;
    if (!started) {
      started = true;
      // Clear prior failure labels so advancePlanAfterTool can proceed
      const { blockedReason: _blocked, ...rest } = step;
      return { ...rest, status: 'running' as const };
    }
    return { ...step, status: 'pending' as const, blockedReason: undefined };
  });
}

function currentRunningStep(plan: PlanStep[]): PlanStep | undefined {
  return plan.find((step) => step.status === 'running');
}

function ensureSomethingRunning(task: Task): boolean {
  const firstOpen = task.plan.find(
    (step) =>
      step.status === 'pending' ||
      step.status === 'paused' ||
      step.status === 'proposed' ||
      step.status === 'blocked',
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
