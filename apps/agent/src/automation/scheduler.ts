import { randomUUID } from 'node:crypto';
import type { Automation, AutomationRun, Task, TaskBudget } from '@aurevoy/shared';
import { createTask, runHarnessTask } from '../agent/harness-controller.js';
import { automationStore, taskStore, traceStore } from '../store/db.js';
import { automationCadenceMs, nextScheduledAutomationRunAt } from './cadence.js';

const DEFAULT_TICK_MS = 15_000;
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE_AUTOMATION_STATUSES = new Set([
  'running',
  'waiting_approval',
  'waiting_clarification',
  'waiting_budget',
  'waiting_completion',
]);

export interface AutomationStartResult {
  automation: Automation;
  run: AutomationRun;
  task: Task;
}

export interface AutomationSchedulerOptions {
  tickMs?: number;
  createTask?: typeof createTask;
  runTask?: typeof runHarnessTask;
}

/**
 * 本地自动化调度器：只负责创建普通 Aurevoy 任务，不拥有第二套 Agent loop。
 * 审批、预算、工具风险和暂停状态全部继续由现有 harness 控制。
 */
export class AutomationScheduler {
  private readonly tickMs: number;
  private readonly createTaskFn: typeof createTask;
  private readonly runTaskFn: typeof runHarnessTask;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(options: AutomationSchedulerOptions = {}) {
    this.tickMs = Math.max(5_000, options.tickMs ?? DEFAULT_TICK_MS);
    this.createTaskFn = options.createTask ?? createTask;
    this.runTaskFn = options.runTask ?? runHarnessTask;
  }

  start(): void {
    if (this.timer) return;
    automationStore.recoverOrphanedClaims();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async runNow(automationId: string): Promise<AutomationStartResult> {
    return this.startAutomation(automationId, true);
  }

  /** 保存前试跑仍复用普通 harness；试跑不创建 automation 配方或运行历史。 */
  async testDraft(draft: {
    goal: string;
    projectId?: string;
    executionMode?: 'auto' | 'plan';
    budget?: TaskBudget;
    lifetimeBudget?: TaskBudget;
  }): Promise<Task> {
    const task = this.createTaskFn(
      draft.goal,
      draft.budget,
      draft.projectId,
      undefined,
      draft.lifetimeBudget,
      draft.executionMode,
    );
    void this.runTaskFn(task).catch(() => {
      // harness 自身负责持久化失败状态；这里仅避免未处理 Promise 污染服务器。
    });
    return task;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.reconcileRunningRuns();
      const now = Date.now();
      for (const automation of automationStore.list()) {
        if (!automation.enabled || automation.cadence === 'manual') continue;
        if (automation.lastStatus && ACTIVE_AUTOMATION_STATUSES.has(automation.lastStatus)) continue;
        if (!automation.nextRunAt || automation.nextRunAt > new Date().toISOString()) continue;
        const interval = automationCadenceMs(automation.cadence);
        const scheduledAt = Date.parse(automation.nextRunAt);
        // 明确的跳过策略：停机超过两个周期时记录 missed，并只推进到下一个未来周期。
        if (interval !== undefined && Number.isFinite(scheduledAt) && now - scheduledAt > interval * 2) {
          automationStore.markMissed(
            automation.id,
            nextScheduledAutomationRunAt(automation.cadence, automation.nextRunAt, now),
            `错过调度：引擎离线约 ${Math.round((now - scheduledAt) / 60_000)} 分钟，已跳过过期周期`,
          );
          continue;
        }
        try {
          await this.startAutomation(automation.id, false);
        } catch {
          // 单个配方失败不应阻塞其他配方；失败已在 claim 级别持久化。
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async startAutomation(automationId: string, force: boolean): Promise<AutomationStartResult> {
    const now = new Date().toISOString();
    const automation = automationStore.claimForRun(automationId, now, force);
    if (!automation) {
      throw new Error(force ? 'automation is already running or unavailable' : 'automation is not due');
    }

    try {
      const task = this.createTaskFn(
        automation.goal,
        automation.budget,
        automation.projectId,
        undefined,
        automation.lifetimeBudget,
        automation.executionMode,
        undefined,
        automation.id,
      );
      automationStore.setLastTask(automation.id, task.id);
      const run: AutomationRun = {
        id: randomUUID(),
        automationId: automation.id,
        taskId: task.id,
        status: 'running',
        startedAt: now,
      };
      automationStore.createRun(run);
      void this.runTaskFn(task).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const current = automationStore.get(automation.id);
        automationStore.finishRun(
          run.id,
          'failed',
          current ? nextScheduledAutomationRunAt(current.cadence, current.nextRunAt) : undefined,
          message,
        );
      });
      return {
        automation: automationStore.get(automation.id) ?? automation,
        run,
        task,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = automationStore.get(automation.id);
      automationStore.failClaim(
        automation.id,
        message,
        current ? nextScheduledAutomationRunAt(current.cadence, current.nextRunAt) : undefined,
      );
      throw error;
    }
  }

  private reconcileRunningRuns(): void {
    for (const run of automationStore.listRunningRuns()) {
      const task = taskStore.get(run.taskId);
      if (!task) {
        automationStore.finishRun(run.id, 'failed', undefined, '自动化任务记录不存在');
        continue;
      }
      if (!TERMINAL_TASK_STATUSES.has(task.status)) {
        const waitingStatus = automationWaitingStatus(task.phase);
        automationStore.setRunStatus(run.id, waitingStatus ?? 'running');
        continue;
      }
      const lastError = task.status === 'failed'
        ? traceStore.list(task.id).slice().reverse().find((trace) => trace.errorMessage)?.errorMessage
        : undefined;
      const automation = automationStore.get(run.automationId);
      automationStore.finishRun(
        run.id,
        task.status as 'completed' | 'failed' | 'cancelled',
        automation?.enabled ? nextScheduledAutomationRunAt(automation.cadence, automation.nextRunAt) : undefined,
        lastError,
      );
    }
  }
}

function automationWaitingStatus(taskPhase: Task['phase']): 'waiting_approval' | 'waiting_clarification' | 'waiting_budget' | 'waiting_completion' | undefined {
  if (taskPhase === 'waiting_approval') return 'waiting_approval';
  if (taskPhase === 'waiting_clarification') return 'waiting_clarification';
  if (taskPhase === 'waiting_budget') return 'waiting_budget';
  if (taskPhase === 'waiting_completion') return 'waiting_completion';
  return undefined;
}
