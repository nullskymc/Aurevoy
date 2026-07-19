import { describe, expect, it } from 'vitest';
import type { PlanStep, Task } from '@aurevoy/shared';
import {
  advancePlanAfterFinalAnswer,
  advancePlanAfterTool,
  completePlanOnSuccess,
  createInitialPlanSteps,
  failOpenPlanSteps,
  isHeuristicTriPlan,
  markRunningPlanBlocked,
  resumeIncompletePlan,
  shouldUseMultiStepPlan,
} from './plan-progress.js';

function triPlan(statuses: [PlanStep['status'], PlanStep['status'], PlanStep['status']]): PlanStep[] {
  return [
    { id: 'discover', description: '搜集并确认本地材料', status: statuses[0] },
    { id: 'synthesize', description: '整理关键信息并形成结构', status: statuses[1] },
    { id: 'deliver', description: '输出最终结果并检查完整性', status: statuses[2] },
  ];
}

function taskWithPlan(plan: PlanStep[]): Task {
  return {
    id: 't1',
    goal: '整理报告',
    title: '整理报告',
    status: 'running',
    phase: 'calling_tool',
    plan,
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('plan-progress', () => {
  it('detects heuristic tri-step plan', () => {
    expect(isHeuristicTriPlan(triPlan(['running', 'pending', 'pending']))).toBe(true);
    expect(isHeuristicTriPlan([{ id: 'exec', description: '执行', status: 'running' }])).toBe(false);
  });

  it('advances discover → synthesize after first successful explore tool', () => {
    const task = taskWithPlan(triPlan(['running', 'pending', 'pending']));
    expect(advancePlanAfterTool(task, 'read', true)).toBe(true);
    expect(task.plan.map((s) => s.status)).toEqual(['completed', 'running', 'pending']);
  });

  it('skips to deliver when first tool is produce', () => {
    const task = taskWithPlan(triPlan(['running', 'pending', 'pending']));
    expect(advancePlanAfterTool(task, 'write', true)).toBe(true);
    expect(task.plan.map((s) => s.status)).toEqual(['completed', 'completed', 'running']);
  });

  it('advances synthesize → deliver on produce tool', () => {
    const task = taskWithPlan(triPlan(['completed', 'running', 'pending']));
    expect(advancePlanAfterTool(task, 'create_file', true)).toBe(true);
    expect(task.plan.map((s) => s.status)).toEqual(['completed', 'completed', 'running']);
  });

  it('keeps synthesize on pure explore tools', () => {
    const task = taskWithPlan(triPlan(['completed', 'running', 'pending']));
    expect(advancePlanAfterTool(task, 'grep', true)).toBe(false);
    expect(task.plan.map((s) => s.status)).toEqual(['completed', 'running', 'pending']);
  });

  it('does not advance on failed tools', () => {
    const task = taskWithPlan(triPlan(['running', 'pending', 'pending']));
    expect(advancePlanAfterTool(task, 'read', false)).toBe(false);
    expect(task.plan[0]?.status).toBe('running');
  });

  it('final answer jumps to deliver', () => {
    const task = taskWithPlan(triPlan(['running', 'pending', 'pending']));
    expect(advancePlanAfterFinalAnswer(task)).toBe(true);
    expect(task.plan.map((s) => s.status)).toEqual(['completed', 'completed', 'running']);
  });

  it('completes all open steps on success', () => {
    const task = taskWithPlan(triPlan(['completed', 'completed', 'running']));
    expect(completePlanOnSuccess(task)).toBe(true);
    expect(task.plan.every((s) => s.status === 'completed')).toBe(true);
  });

  it('fails running and cancels pending on failure', () => {
    const task = taskWithPlan(triPlan(['completed', 'running', 'pending']));
    expect(failOpenPlanSteps(task)).toBe(true);
    expect(task.plan.map((s) => s.status)).toEqual(['completed', 'failed', 'cancelled']);
  });

  it('resumeIncompletePlan starts first incomplete step', () => {
    const plan = resumeIncompletePlan(triPlan(['completed', 'pending', 'pending']));
    expect(plan.map((s) => s.status)).toEqual(['completed', 'running', 'pending']);
  });

  it('createInitialPlanSteps uses configure template for MCP goals', () => {
    expect(shouldUseMultiStepPlan('配置这个 mcp')).toBe(true);
    const plan = createInitialPlanSteps('配置这个 mcp');
    expect(plan).toHaveLength(3);
    expect(plan[0]?.description).toMatch(/定位|配置/);
    expect(plan.every((s) => s.status === 'completed')).toBe(false);
  });

  it('keeps incomplete/blocked statuses until resolved', () => {
    const task = taskWithPlan(triPlan(['running', 'pending', 'pending']));
    expect(markRunningPlanBlocked(task, 'need user')).toBe(true);
    expect(task.plan[0]?.status).toBe('blocked');
    expect(task.plan[1]?.status).toBe('pending');
    // blocked is not completed — real multi-step surface
    expect(task.plan.some((s) => s.status === 'completed')).toBe(false);
  });

  it('cancel → failOpenPlanSteps → resumeIncompletePlan reopens failed work as running', () => {
    const task = taskWithPlan(triPlan(['completed', 'running', 'pending']));
    expect(failOpenPlanSteps(task)).toBe(true);
    // running → failed, pending → cancelled (cancel / interrupt shape)
    expect(task.plan.map((s) => s.status)).toEqual(['completed', 'failed', 'cancelled']);

    const resumed = resumeIncompletePlan(task.plan);
    expect(resumed.map((s) => s.status)).toEqual(['completed', 'running', 'pending']);
    // advancePlanAfterTool needs a current running step after resume
    const afterResume = taskWithPlan(resumed);
    expect(advancePlanAfterTool(afterResume, 'write', true)).toBe(true);
    expect(afterResume.plan.map((s) => s.status)).toEqual(['completed', 'completed', 'running']);
  });

  it('crash-recovery shape (all non-completed failed) reopens first incomplete on resume', () => {
    // markInterruptedTasksAfterRestart maps non-completed → failed
    const crashed = triPlan(['completed', 'failed', 'failed']);
    const resumed = resumeIncompletePlan(crashed);
    expect(resumed.map((s) => s.status)).toEqual(['completed', 'running', 'pending']);
  });
});
