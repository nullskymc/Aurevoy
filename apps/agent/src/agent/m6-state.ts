import { randomUUID } from 'node:crypto';
import type {
  AggregatedTokenUsage,
  BudgetExceededInfo,
  BudgetLimitName,
  BudgetScope,
  BudgetUsage,
  ClarificationRequest,
  Task,
  TaskArtifact,
  TaskArtifactStatus,
  TaskBudget,
  TaskCheckpoint,
  TokenUsage,
} from '@aurevoy/shared';
import { getPiProviderName } from '../llm/pi-provider.js';
import { config } from '../config.js';

/** @deprecated 使用 defaultRunBudget()；保留别名避免外部脚本硬编码断裂。 */
export const DEFAULT_TASK_BUDGET: Required<TaskBudget> = {
  maxIterations: 120,
  maxToolCalls: 300,
  maxWallTimeMs: 45 * 60 * 1000,
  maxOutputBytes: 2 * 1024 * 1024,
};

/** 单次 harness 执行的默认预算（来自 config / 环境变量 / 设置）。 */
export function defaultRunBudget(): Required<TaskBudget> {
  return { ...config.budget.run };
}

/** 任务寿命默认预算。 */
export function defaultLifetimeBudget(): Required<TaskBudget> {
  return { ...config.budget.lifetime };
}

export function normalizeBudget(budget?: TaskBudget): TaskBudget | undefined {
  if (!budget) return undefined;
  const normalized: TaskBudget = {};
  if (isPositiveNumber(budget.maxIterations)) normalized.maxIterations = Math.floor(budget.maxIterations);
  if (isPositiveNumber(budget.maxToolCalls)) normalized.maxToolCalls = Math.floor(budget.maxToolCalls);
  if (isPositiveNumber(budget.maxWallTimeMs)) normalized.maxWallTimeMs = Math.floor(budget.maxWallTimeMs);
  if (isPositiveNumber(budget.maxOutputBytes)) normalized.maxOutputBytes = Math.floor(budget.maxOutputBytes);
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function initialBudgetUsage(): BudgetUsage {
  return { iterations: 0, toolCalls: 0, wallTimeMs: 0, outputBytes: 0 };
}

/** 任务级有效 run 预算：创建快照优先，缺省字段回落默认。 */
export function effectiveBudget(task: Task): Required<TaskBudget> {
  return mergeBudget(defaultRunBudget(), task.budget);
}

/** 任务级有效寿命预算。 */
export function effectiveLifetimeBudget(task: Task): Required<TaskBudget> {
  return ensureLifetimeCoversRun(effectiveBudget(task), mergeBudget(defaultLifetimeBudget(), task.lifetimeBudget));
}

/**
 * 创建任务时固化预算快照，避免设置变更影响已在跑的任务，
 * 并保证 lifetime 每个维度都不小于 run。
 */
export function snapshotTaskBudgets(args?: {
  budget?: TaskBudget;
  lifetimeBudget?: TaskBudget;
}): {
  budget: Required<TaskBudget>;
  lifetimeBudget: Required<TaskBudget>;
} {
  const run = mergeBudget(defaultRunBudget(), normalizeBudget(args?.budget));
  const lifetime = ensureLifetimeCoversRun(
    run,
    mergeBudget(defaultLifetimeBudget(), normalizeBudget(args?.lifetimeBudget)),
  );
  return { budget: run, lifetimeBudget: lifetime };
}

export function mergeBudget(
  base: Required<TaskBudget>,
  override?: TaskBudget,
): Required<TaskBudget> {
  if (!override) return { ...base };
  return {
    maxIterations: isPositiveNumber(override.maxIterations)
      ? Math.floor(override.maxIterations)
      : base.maxIterations,
    maxToolCalls: isPositiveNumber(override.maxToolCalls)
      ? Math.floor(override.maxToolCalls)
      : base.maxToolCalls,
    maxWallTimeMs: isPositiveNumber(override.maxWallTimeMs)
      ? Math.floor(override.maxWallTimeMs)
      : base.maxWallTimeMs,
    maxOutputBytes: isPositiveNumber(override.maxOutputBytes)
      ? Math.floor(override.maxOutputBytes)
      : base.maxOutputBytes,
  };
}

/** 寿命上限至少覆盖单次 run，避免一上来就不可执行。 */
export function ensureLifetimeCoversRun(
  run: Required<TaskBudget>,
  lifetime: Required<TaskBudget>,
): Required<TaskBudget> {
  return {
    maxIterations: Math.max(lifetime.maxIterations, run.maxIterations),
    maxToolCalls: Math.max(lifetime.maxToolCalls, run.maxToolCalls),
    maxWallTimeMs: Math.max(lifetime.maxWallTimeMs, run.maxWallTimeMs),
    maxOutputBytes: Math.max(lifetime.maxOutputBytes, run.maxOutputBytes),
  };
}

/** 将增量加到寿命预算上限上。 */
export function addBudgetGrant(
  base: Required<TaskBudget>,
  grant?: TaskBudget,
): Required<TaskBudget> {
  const normalized = normalizeBudget(grant);
  if (!normalized) return { ...base };
  return {
    maxIterations: base.maxIterations + (normalized.maxIterations ?? 0),
    maxToolCalls: base.maxToolCalls + (normalized.maxToolCalls ?? 0),
    maxWallTimeMs: base.maxWallTimeMs + (normalized.maxWallTimeMs ?? 0),
    maxOutputBytes: base.maxOutputBytes + (normalized.maxOutputBytes ?? 0),
  };
}

export function updateWallTime(task: Task, startedAtMs: number): BudgetUsage {
  const usage = task.budgetUsage ?? initialBudgetUsage();
  usage.wallTimeMs = Math.max(0, Date.now() - startedAtMs);
  task.budgetUsage = usage;
  return usage;
}

/**
 * 在 run 开始时重置本轮用量；寿命用量保留。
 * 返回本 run 开始前已累计的寿命墙钟，便于把本 run 墙钟叠加上去。
 */
export function beginRunBudget(task: Task): { lifetimeWallAtRunStart: number } {
  const lifetime = task.lifetimeUsage ?? initialBudgetUsage();
  task.lifetimeUsage = lifetime;
  task.budgetUsage = initialBudgetUsage();
  task.budgetExceeded = undefined;
  return { lifetimeWallAtRunStart: lifetime.wallTimeMs };
}

/** 将本 run 的墙钟累加到寿命用量（run 结束时调用一次）。 */
export function finalizeRunWallTime(task: Task, lifetimeWallAtRunStart: number, taskStartedAtMs: number): void {
  const runWall = Math.max(0, Date.now() - taskStartedAtMs);
  task.budgetUsage = task.budgetUsage ?? initialBudgetUsage();
  task.budgetUsage.wallTimeMs = runWall;
  task.lifetimeUsage = task.lifetimeUsage ?? initialBudgetUsage();
  task.lifetimeUsage.wallTimeMs = lifetimeWallAtRunStart + runWall;
}

export function recordIteration(task: Task): void {
  task.budgetUsage = task.budgetUsage ?? initialBudgetUsage();
  task.lifetimeUsage = task.lifetimeUsage ?? initialBudgetUsage();
  task.budgetUsage.iterations += 1;
  task.lifetimeUsage.iterations += 1;
}

export function recordToolCall(task: Task): void {
  task.budgetUsage = task.budgetUsage ?? initialBudgetUsage();
  task.lifetimeUsage = task.lifetimeUsage ?? initialBudgetUsage();
  task.budgetUsage.toolCalls += 1;
  task.lifetimeUsage.toolCalls += 1;
}

export function recordOutputBytes(task: Task, delta: string): void {
  const bytes = Buffer.byteLength(delta, 'utf8');
  task.budgetUsage = task.budgetUsage ?? initialBudgetUsage();
  task.lifetimeUsage = task.lifetimeUsage ?? initialBudgetUsage();
  task.budgetUsage.outputBytes += bytes;
  task.lifetimeUsage.outputBytes += bytes;
}

/**
 * 检查 run 与 lifetime 是否触顶。
 * 使用 >= ：本轮完整结束后即停，不再开启下一轮。
 */
export function evaluateBudgetStop(
  task: Task,
  taskStartedAtMs: number,
  lifetimeWallAtRunStart: number,
): BudgetExceededInfo | null {
  updateWallTime(task, taskStartedAtMs);
  const runUsage = task.budgetUsage ?? initialBudgetUsage();
  const lifetimeUsage: BudgetUsage = {
    ...(task.lifetimeUsage ?? initialBudgetUsage()),
    // 寿命墙钟 = 历史累计 + 本 run 已进行时间
    wallTimeMs: lifetimeWallAtRunStart + runUsage.wallTimeMs,
  };
  // 保持 lifetimeUsage.wallTimeMs 为「仅历史」在 run 中不提前写入；评估用合成值
  const runBudget = effectiveBudget(task);
  const lifetimeBudget = effectiveLifetimeBudget(task);

  const runHit = firstExceededLimit(runUsage, runBudget);
  if (runHit) {
    return buildExceededInfo('run', runHit, runUsage, lifetimeUsage, runBudget, lifetimeBudget);
  }
  const lifetimeHit = firstExceededLimit(lifetimeUsage, lifetimeBudget);
  if (lifetimeHit) {
    return buildExceededInfo('lifetime', lifetimeHit, runUsage, lifetimeUsage, runBudget, lifetimeBudget);
  }
  return null;
}

function firstExceededLimit(
  usage: BudgetUsage,
  budget: Required<TaskBudget>,
): { limitName: BudgetLimitName; used: number; limit: number } | null {
  if (usage.iterations >= budget.maxIterations) {
    return { limitName: 'maxIterations', used: usage.iterations, limit: budget.maxIterations };
  }
  if (usage.toolCalls >= budget.maxToolCalls) {
    return { limitName: 'maxToolCalls', used: usage.toolCalls, limit: budget.maxToolCalls };
  }
  if (usage.wallTimeMs >= budget.maxWallTimeMs) {
    return { limitName: 'maxWallTimeMs', used: usage.wallTimeMs, limit: budget.maxWallTimeMs };
  }
  if (usage.outputBytes >= budget.maxOutputBytes) {
    return { limitName: 'maxOutputBytes', used: usage.outputBytes, limit: budget.maxOutputBytes };
  }
  return null;
}

function buildExceededInfo(
  scope: BudgetScope,
  hit: { limitName: BudgetLimitName; used: number; limit: number },
  runUsage: BudgetUsage,
  lifetimeUsage: BudgetUsage,
  runBudget: Required<TaskBudget>,
  lifetimeBudget: Required<TaskBudget>,
): BudgetExceededInfo {
  const label = budgetLimitLabel(hit.limitName);
  const scopeLabel = scope === 'run' ? '本轮执行' : '任务寿命';
  return {
    scope,
    limitName: hit.limitName,
    used: hit.used,
    limit: hit.limit,
    reason: `${scopeLabel}预算超限：${label} 已使用 ${formatBudgetValue(hit.limitName, hit.used)}，上限 ${formatBudgetValue(hit.limitName, hit.limit)}`,
    runUsage: { ...runUsage },
    lifetimeUsage: { ...lifetimeUsage },
    runBudget: { ...runBudget },
    lifetimeBudget: { ...lifetimeBudget },
  };
}

export function budgetLimitLabel(name: BudgetLimitName): string {
  switch (name) {
    case 'maxIterations':
      return '工作回合';
    case 'maxToolCalls':
      return '工具调用';
    case 'maxWallTimeMs':
      return '运行时间';
    case 'maxOutputBytes':
      return '输出字节';
  }
}

function formatBudgetValue(name: BudgetLimitName, value: number): string {
  if (name === 'maxWallTimeMs') {
    if (value >= 60_000) return `${Math.round(value / 60_000)} 分钟`;
    return `${Math.round(value / 1000)} 秒`;
  }
  if (name === 'maxOutputBytes') {
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
    if (value >= 1024) return `${Math.round(value / 1024)} KiB`;
    return `${value} B`;
  }
  return String(value);
}

/**
 * 寿命预算不足时抬升上限，保证下一 run 能跑满一整轮 run budget。
 * - 若传入 additionalLifetime，先按增量叠加
 * - 再 floor 到 usage + run（每个维度）
 */
export function ensureLifetimeAllowsAnotherRun(task: Task, additional?: TaskBudget): Required<TaskBudget> {
  const run = effectiveBudget(task);
  const usage = task.lifetimeUsage ?? initialBudgetUsage();
  let lifetime = effectiveLifetimeBudget(task);

  const explicit = normalizeBudget(additional);
  if (explicit) {
    lifetime = addBudgetGrant(lifetime, explicit);
  }

  lifetime = {
    maxIterations: Math.max(lifetime.maxIterations, usage.iterations + run.maxIterations),
    maxToolCalls: Math.max(lifetime.maxToolCalls, usage.toolCalls + run.maxToolCalls),
    maxWallTimeMs: Math.max(lifetime.maxWallTimeMs, usage.wallTimeMs + run.maxWallTimeMs),
    maxOutputBytes: Math.max(lifetime.maxOutputBytes, usage.outputBytes + run.maxOutputBytes),
  };

  task.lifetimeBudget = lifetime;
  return lifetime;
}

export function addTokenUsage(task: Task, usage: TokenUsage | null | undefined): AggregatedTokenUsage {
  const now = new Date().toISOString();
  const current: AggregatedTokenUsage = task.tokenUsage ?? {
    available: false,
    provider: getPiProviderName(),
    model: config.llm.model,
  };
  if (!usage || Object.keys(usage).length === 0) {
    task.tokenUsage = { ...current, available: current.available, updatedAt: now };
    return task.tokenUsage;
  }
  task.tokenUsage = {
    available: true,
    provider: getPiProviderName(),
    model: config.llm.model,
    promptTokens: addOptional(current.promptTokens, usage.promptTokens),
    completionTokens: addOptional(current.completionTokens, usage.completionTokens),
    totalTokens: addOptional(current.totalTokens, usage.totalTokens),
    reasoningTokens: addOptional(current.reasoningTokens, usage.reasoningTokens),
    cacheReadTokens: addOptional(current.cacheReadTokens, usage.cacheReadTokens),
    cacheWriteTokens: addOptional(current.cacheWriteTokens, usage.cacheWriteTokens),
    estimatedCostUsd: addOptional(current.estimatedCostUsd, usage.estimatedCostUsd),
    updatedAt: now,
  };
  return task.tokenUsage;
}

export function createClarification(args: {
  callId: string;
  question: string;
  options?: string[];
  context?: string;
}): ClarificationRequest {
  return {
    id: randomUUID(),
    callId: args.callId,
    question: args.question,
    options: args.options?.filter((item) => item.trim().length > 0),
    context: args.context,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
}

export function resolveClarification(
  task: Task,
  clarificationId: string,
  status: 'answered' | 'timeout' | 'cancelled',
  answer?: string,
): ClarificationRequest | undefined {
  const clarifications = task.clarifications ?? [];
  const index = clarifications.findIndex((item) => item.id === clarificationId);
  if (index < 0) return undefined;
  const next: ClarificationRequest = {
    ...clarifications[index],
    status,
    answer,
    answeredAt: new Date().toISOString(),
  };
  clarifications[index] = next;
  task.clarifications = clarifications;
  return next;
}

export function createArtifact(args: {
  name: string;
  content: string;
  type?: TaskArtifact['type'];
  mimeType?: string;
  sourceCallId?: string;
  sourceTaskId?: string;
}): TaskArtifact {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    type: args.type ?? 'text',
    name: args.name,
    content: args.content,
    mimeType: args.mimeType,
    sourceCallId: args.sourceCallId,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    sourceTaskId: args.sourceTaskId,
    sizeBytes: Buffer.byteLength(args.content, 'utf8'),
  };
}

export function updateArtifactStatus(
  task: Task,
  artifactId: string,
  status: TaskArtifactStatus,
): TaskArtifact | undefined {
  const artifacts = task.artifacts ?? [];
  const index = artifacts.findIndex((item) => item.id === artifactId);
  if (index < 0) return undefined;
  const next = { ...artifacts[index], status, updatedAt: new Date().toISOString() };
  artifacts[index] = next;
  task.artifacts = artifacts;
  return next;
}

export function markArtifactApplied(
  task: Task,
  artifactId: string,
  appliedPath: string,
): TaskArtifact | undefined {
  const artifacts = task.artifacts ?? [];
  const index = artifacts.findIndex((item) => item.id === artifactId);
  if (index < 0) return undefined;
  const next: TaskArtifact = {
    ...artifacts[index],
    status: 'applied',
    updatedAt: new Date().toISOString(),
    appliedAt: new Date().toISOString(),
    appliedPath,
  };
  artifacts[index] = next;
  task.artifacts = artifacts;
  return next;
}

export function createCheckpoint(args: {
  label: string;
  stepId?: string;
  message?: string;
  data?: unknown;
}): TaskCheckpoint {
  return {
    id: randomUUID(),
    label: args.label,
    stepId: args.stepId,
    message: args.message,
    data: args.data,
    createdAt: new Date().toISOString(),
  };
}

function addOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (right === undefined) return left;
  return (left ?? 0) + right;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
