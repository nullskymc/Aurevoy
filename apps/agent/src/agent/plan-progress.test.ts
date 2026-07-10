import { describe, expect, it } from 'vitest';
import type { PlanStep, Task } from '@aurevoy/shared';
import {
  advancePlanAfterFinalAnswer,
  advancePlanAfterTool,
  completePlanOnSuccess,
  failOpenPlanSteps,
  isHeuristicTriPlan,
  resumeIncompletePlan,
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
});
