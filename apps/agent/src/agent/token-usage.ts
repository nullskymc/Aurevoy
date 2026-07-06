import type { AggregatedTokenUsage, Task, TokenUsageReport, TokenUsageReportBreakdown } from '@aurevoy/shared';

type MutableBreakdown = TokenUsageReportBreakdown & { latestTime: number };

export function buildTokenUsageReport(tasks: Task[]): TokenUsageReport {
  let measuredTasks = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let estimatedCostUsd = 0;
  const byModel = new Map<string, MutableBreakdown>();

  for (const task of tasks) {
    const usage = task.tokenUsage;
    if (!isMeasuredUsage(usage)) continue;
    measuredTasks += 1;

    const prompt = safeNumber(usage.promptTokens);
    const completion = safeNumber(usage.completionTokens);
    const total = safeNumber(usage.totalTokens);
    const reasoning = safeNumber(usage.reasoningTokens);
    const cacheRead = safeNumber(usage.cacheReadTokens);
    const cacheWrite = safeNumber(usage.cacheWriteTokens);
    const cost = safeNumber(usage.estimatedCostUsd);

    promptTokens += prompt;
    completionTokens += completion;
    totalTokens += total;
    reasoningTokens += reasoning;
    cacheReadTokens += cacheRead;
    cacheWriteTokens += cacheWrite;
    estimatedCostUsd += cost;

    const provider = usage.provider || 'unknown';
    const model = usage.model || 'unknown';
    const key = `${provider}\u0000${model}`;
    const updatedTime = usage.updatedAt ? Date.parse(usage.updatedAt) : 0;
    const item = byModel.get(key) ?? {
      provider,
      model,
      tasks: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0,
      updatedAt: usage.updatedAt,
      latestTime: Number.isFinite(updatedTime) ? updatedTime : 0,
    };
    item.tasks += 1;
    item.promptTokens += prompt;
    item.completionTokens += completion;
    item.totalTokens += total;
    item.reasoningTokens += reasoning;
    item.cacheReadTokens += cacheRead;
    item.cacheWriteTokens += cacheWrite;
    item.estimatedCostUsd += cost;
    if (Number.isFinite(updatedTime) && updatedTime > item.latestTime) {
      item.latestTime = updatedTime;
      item.updatedAt = usage.updatedAt;
    }
    byModel.set(key, item);
  }

  return {
    tasks: tasks.length,
    measuredTasks,
    available: measuredTasks > 0,
    promptTokens,
    completionTokens,
    totalTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    estimatedCostUsd,
    breakdown: [...byModel.values()]
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .map(({ latestTime: _latestTime, ...item }) => item),
  };
}

function isMeasuredUsage(usage: AggregatedTokenUsage | undefined): usage is AggregatedTokenUsage {
  return !!usage?.available;
}

function safeNumber(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
