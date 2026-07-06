import { randomUUID } from 'node:crypto';
import type {
  AggregatedTokenUsage,
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

export const DEFAULT_TASK_BUDGET: Required<TaskBudget> = {
  maxIterations: 40,
  maxToolCalls: 80,
  maxWallTimeMs: 10 * 60 * 1000,
  maxOutputBytes: 1024 * 1024,
};

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

export function effectiveBudget(task: Task): Required<TaskBudget> {
  return { ...DEFAULT_TASK_BUDGET, ...(task.budget ?? {}) };
}

export function updateWallTime(task: Task, startedAtMs: number): BudgetUsage {
  const usage = task.budgetUsage ?? initialBudgetUsage();
  usage.wallTimeMs = Math.max(0, Date.now() - startedAtMs);
  task.budgetUsage = usage;
  return usage;
}

export function assertBudgetWithinLimits(task: Task): void {
  const usage = task.budgetUsage ?? initialBudgetUsage();
  const budget = effectiveBudget(task);
  if (usage.iterations > budget.maxIterations) {
    throw new BudgetExceededError('maxIterations', usage.iterations, budget.maxIterations);
  }
  if (usage.toolCalls > budget.maxToolCalls) {
    throw new BudgetExceededError('maxToolCalls', usage.toolCalls, budget.maxToolCalls);
  }
  if (usage.wallTimeMs > budget.maxWallTimeMs) {
    throw new BudgetExceededError('maxWallTimeMs', usage.wallTimeMs, budget.maxWallTimeMs);
  }
  if (usage.outputBytes > budget.maxOutputBytes) {
    throw new BudgetExceededError('maxOutputBytes', usage.outputBytes, budget.maxOutputBytes);
  }
}

export class BudgetExceededError extends Error {
  constructor(
    readonly limitName: keyof Required<TaskBudget>,
    readonly used: number,
    readonly limit: number,
  ) {
    super(`任务预算超限：${limitName} 已使用 ${used}，上限 ${limit}`);
    this.name = 'BudgetExceededError';
  }
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
}): TaskArtifact {
  return {
    id: randomUUID(),
    type: args.type ?? 'text',
    name: args.name,
    content: args.content,
    mimeType: args.mimeType,
    sourceCallId: args.sourceCallId,
    status: 'draft',
    createdAt: new Date().toISOString(),
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
  const next = { ...artifacts[index], status };
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
