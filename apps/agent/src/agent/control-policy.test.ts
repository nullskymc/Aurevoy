import { describe, expect, it } from 'vitest';
import type { BudgetExceededInfo, PlanStep, Task } from '@aurevoy/shared';
import {
  COMPLETION_GATE_COMPLETE_MARKER,
  COMPLETION_GATE_NEEDS_ATTENTION_MARKER,
  MAX_STEPS_CRITICAL_HEADER,
  applyQuestionFirstSteering,
  buildCompletionGatePrompt,
  buildMaxStepsPrompt,
  buildMaxStepsWrapUpMessage,
  buildResumeProgressInjection,
  decideMaxStepsAfterTurn,
  extractCompletionGateVerdict,
  isQuestionOrStatusAsk,
  maxStepsToolsDisabledReason,
  shouldStartCompletionGate,
  stripCompletionGateMarker,
} from './control-policy.js';
import {
  createInitialPlanSteps,
  markRunningPlanBlocked,
  resumeIncompletePlan,
  shouldUseMultiStepPlan,
} from './plan-progress.js';

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    goal: '配置项目的外部集成',
    title: '配置集成',
    status: 'running',
    phase: 'calling_tool',
    plan: [],
    messages: [],
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    ...overrides,
  };
}

const sampleBudgetInfo: BudgetExceededInfo = {
  scope: 'run',
  limitName: 'maxIterations',
  used: 5,
  limit: 5,
  reason: '本轮执行预算超限：工作回合 已使用 5，上限 5',
  runUsage: { iterations: 5, toolCalls: 10, wallTimeMs: 1000, outputBytes: 100 },
  lifetimeUsage: { iterations: 5, toolCalls: 10, wallTimeMs: 1000, outputBytes: 100 },
  runBudget: { maxIterations: 5, maxToolCalls: 100, maxWallTimeMs: 60_000, maxOutputBytes: 1_000_000 },
  lifetimeBudget: { maxIterations: 50, maxToolCalls: 500, maxWallTimeMs: 600_000, maxOutputBytes: 5_000_000 },
};

describe('control-policy max-steps', () => {
  it('decideMaxStepsAfterTurn starts wrap-up then finishes after wrap-up', () => {
    expect(
      decideMaxStepsAfterTurn({ budgetInfo: null, wrapUpPending: false, wrapUpDone: false }),
    ).toEqual({ action: 'continue' });

    const start = decideMaxStepsAfterTurn({
      budgetInfo: sampleBudgetInfo,
      wrapUpPending: false,
      wrapUpDone: false,
    });
    expect(start).toEqual({ action: 'start_wrap_up', info: sampleBudgetInfo });

    const finish = decideMaxStepsAfterTurn({
      budgetInfo: sampleBudgetInfo,
      wrapUpPending: true,
      wrapUpDone: false,
    });
    expect(finish.action).toBe('finish_after_wrap_up');

    const hardStop = decideMaxStepsAfterTurn({
      budgetInfo: sampleBudgetInfo,
      wrapUpPending: false,
      wrapUpDone: true,
    });
    expect(hardStop).toEqual({ action: 'stop', info: sampleBudgetInfo });
  });

  it('buildMaxStepsPrompt disables tools and requires text summary fields', () => {
    const plan: PlanStep[] = [
      { id: 'discover', description: '定位入口', status: 'completed' },
      { id: 'synthesize', description: '写入配置', status: 'running' },
      { id: 'deliver', description: '验证', status: 'pending' },
    ];
    const prompt = buildMaxStepsPrompt(baseTask({ plan }), sampleBudgetInfo);
    expect(prompt).toContain(MAX_STEPS_CRITICAL_HEADER);
    expect(prompt).toMatch(/Tools are DISABLED/i);
    expect(prompt).toMatch(/Do NOT make any tool calls/i);
    expect(prompt).toMatch(/text only/i);
    expect(prompt).toContain('定位入口');
    expect(prompt).toContain(sampleBudgetInfo.reason);
    expect(prompt).toContain('配置项目的外部集成');
    expect(maxStepsToolsDisabledReason()).toMatch(/tools are disabled/i);
  });

  it('buildMaxStepsWrapUpMessage lists completed and open plan steps', () => {
    const plan: PlanStep[] = [
      { id: 'discover', description: '定位入口', status: 'completed' },
      { id: 'synthesize', description: '写入配置', status: 'blocked', blockedReason: 'Connection closed' },
      { id: 'deliver', description: '验证', status: 'pending' },
    ];
    const text = buildMaxStepsWrapUpMessage(baseTask({ plan }), sampleBudgetInfo);
    expect(text).toContain(sampleBudgetInfo.reason);
    expect(text).toContain('定位入口');
    expect(text).toMatch(/\[blocked\]/);
    expect(text).toMatch(/可继续本任务|继续/);
  });
});

describe('control-policy resume progress', () => {
  it('injects plan progress and forbids restarting discovery', () => {
    const plan: PlanStep[] = [
      { id: 'discover', description: '定位二进制', status: 'completed' },
      { id: 'synthesize', description: '写配置', status: 'running' },
      { id: 'deliver', description: '验证', status: 'pending' },
    ];
    const injection = buildResumeProgressInjection(baseTask({ plan }));
    expect(injection).toBeTruthy();
    expect(injection!).toContain('<progress_checkpoint>');
    expect(injection!).toMatch(/Do NOT redo investigation or actions already completed/i);
    expect(injection!).not.toMatch(/GitHub README|MCP client|zotero/i);
    expect(injection!).toContain('[completed] discover');
    expect(injection!).toContain('Next focus');
    expect(injection!).toContain('写配置');
  });

  it('does not inject on brand-new multi-step plan (discover already running)', () => {
    const plan = createInitialPlanSteps('配置这个 mcp 服务');
    expect(plan[0]?.status).toBe('running');
    expect(plan.some((s) => s.status === 'completed')).toBe(false);
    const injection = buildResumeProgressInjection(baseTask({ plan, goal: '配置这个 mcp 服务' }));
    expect(injection).toBeNull();
  });

  it('includes checkpoint label when present', () => {
    const plan: PlanStep[] = [{ id: 'exec', description: '执行', status: 'running' }];
    const injection = buildResumeProgressInjection(
      baseTask({
        plan,
        checkpoints: [
          {
            id: 'cp1',
            label: 'after-write',
            stepId: 'exec',
            createdAt: '2026-07-19T00:00:00.000Z',
          },
        ],
      }),
    );
    expect(injection).toContain('after-write');
  });
});

describe('control-policy question-first', () => {
  it('detects status/progress questions without requiring incident-specific phrases', () => {
    expect(isQuestionOrStatusAsk('进度如何')).toBe(true);
    expect(isQuestionOrStatusAsk('什么问题')).toBe(true);
    expect(isQuestionOrStatusAsk('what happened?')).toBe(true);
    expect(isQuestionOrStatusAsk('any error?')).toBe(true);
    expect(isQuestionOrStatusAsk('继续写入配置到工作区')).toBe(false);
  });

  it('applyQuestionFirstSteering prefixes only question/status messages', () => {
    const q = applyQuestionFirstSteering('进度如何');
    expect(q).toContain('<system-reminder>');
    expect(q).toMatch(/Answer in user-visible text THIS turn/i);
    expect(q).toContain('进度如何');

    const plain = applyQuestionFirstSteering('请继续完成当前任务');
    expect(plain).toBe('请继续完成当前任务');
  });
});

describe('control-policy completion gate', () => {
  it('only audits substantive Agent runs after a text-only candidate final turn', () => {
    expect(shouldStartCompletionGate({
      executionMode: 'auto',
      toolCallsThisRun: 2,
      currentTurnHadToolCall: false,
      alreadyRequested: false,
    })).toBe(true);
    expect(shouldStartCompletionGate({
      executionMode: 'plan',
      toolCallsThisRun: 2,
      currentTurnHadToolCall: false,
      alreadyRequested: false,
    })).toBe(false);
    expect(shouldStartCompletionGate({
      executionMode: 'auto',
      toolCallsThisRun: 0,
      currentTurnHadToolCall: false,
      alreadyRequested: false,
    })).toBe(false);
    expect(shouldStartCompletionGate({
      executionMode: 'auto',
      toolCallsThisRun: 2,
      currentTurnHadToolCall: true,
      alreadyRequested: false,
    })).toBe(false);
    expect(shouldStartCompletionGate({
      executionMode: 'auto',
      toolCallsThisRun: 2,
      currentTurnHadToolCall: false,
      alreadyRequested: true,
    })).toBe(false);
  });

  it('uses a short follow-up and strips internal verdict markers', () => {
    const prompt = buildCompletionGatePrompt();
    expect(prompt).toContain('CONTINUE');
    expect(prompt).toContain(COMPLETION_GATE_COMPLETE_MARKER);
    expect(prompt).toContain(COMPLETION_GATE_NEEDS_ATTENTION_MARKER);
    expect(prompt.length).toBeLessThan(1_200);

    expect(extractCompletionGateVerdict(COMPLETION_GATE_COMPLETE_MARKER)).toBe('complete');
    expect(extractCompletionGateVerdict(`blocked\n${COMPLETION_GATE_NEEDS_ATTENTION_MARKER}`))
      .toBe('needs_attention');
    expect(extractCompletionGateVerdict('continue working')).toBeNull();
    expect(stripCompletionGateMarker(`blocked\n${COMPLETION_GATE_NEEDS_ATTENTION_MARKER}`)).toBe('blocked');
  });
});

describe('plan multi-step + blocked', () => {
  it('uses multi-step plan for configure goals instead of single exec', () => {
    expect(shouldUseMultiStepPlan('配置这个 mcp')).toBe(true);
    expect(shouldUseMultiStepPlan('你好')).toBe(false);
    const plan = createInitialPlanSteps('配置这个 mcp 并接入当前应用');
    expect(plan.length).toBe(3);
    expect(plan.map((s) => s.id)).toEqual(['discover', 'synthesize', 'deliver']);
    expect(plan[0]?.status).toBe('running');
    expect(plan[1]?.status).toBe('pending');
    expect(plan.some((s) => s.id === 'exec')).toBe(false);
  });

  it('markRunningPlanBlocked sets blocked status with reason', () => {
    const task = baseTask({ plan: createInitialPlanSteps('配置 mcp 服务') });
    expect(markRunningPlanBlocked(task, 'dependency offline')).toBe(true);
    expect(task.plan[0]?.status).toBe('blocked');
    expect(task.plan[0]?.blockedReason).toBe('dependency offline');
  });

  it('resumeIncompletePlan reopens blocked step as running', () => {
    const plan = resumeIncompletePlan([
      { id: 'discover', description: 'a', status: 'completed' },
      { id: 'synthesize', description: 'b', status: 'blocked', blockedReason: 'x' },
      { id: 'deliver', description: 'c', status: 'pending' },
    ]);
    expect(plan.map((s) => s.status)).toEqual(['completed', 'running', 'pending']);
  });
});
