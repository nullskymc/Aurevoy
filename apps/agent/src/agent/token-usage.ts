import type {
  AggregatedTokenUsage,
  Task,
  TokenUsageDailyPoint,
  TokenUsageReport,
  TokenUsageReportBreakdown,
} from '@aurevoy/shared';

type MutableBreakdown = TokenUsageReportBreakdown & { latestTime: number };

/** Default activity window for the usage dashboard chart. */
export const TOKEN_USAGE_DAILY_WINDOW_DAYS = 14;

export function buildTokenUsageReport(
  tasks: Task[],
  options?: { dailyDays?: number; now?: Date },
): TokenUsageReport {
  let measuredTasks = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let estimatedCostUsd = 0;
  const byModel = new Map<string, MutableBreakdown>();
  const byDay = new Map<string, TokenUsageDailyPoint>();

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

    const day = resolveUsageDayKey(task, usage);
    if (day) {
      const bucket = byDay.get(day) ?? {
        date: day,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        estimatedCostUsd: 0,
        tasks: 0,
      };
      bucket.totalTokens += total;
      bucket.promptTokens += prompt;
      bucket.completionTokens += completion;
      bucket.estimatedCostUsd += cost;
      bucket.tasks += 1;
      byDay.set(day, bucket);
    }
  }

  const dailyDays = Math.max(1, Math.min(90, options?.dailyDays ?? TOKEN_USAGE_DAILY_WINDOW_DAYS));
  const daily = fillDailyWindow(byDay, dailyDays, options?.now ?? new Date());
  const peakDay = pickPeakDay(daily);

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
    daily,
    peakDay,
  };
}

/**
 * Attribute a task's measured usage to a local calendar day.
 * Prefer usage.updatedAt (last provider report), then task.updatedAt, then createdAt.
 */
export function resolveUsageDayKey(task: Task, usage: AggregatedTokenUsage): string | null {
  const candidates = [usage.updatedAt, task.updatedAt, task.createdAt];
  for (const iso of candidates) {
    if (!iso) continue;
    const key = toLocalDayKey(iso);
    if (key) return key;
  }
  return null;
}

/** Local calendar day YYYY-MM-DD from an ISO timestamp. */
export function toLocalDayKey(isoOrDate: string | Date): string | null {
  const date = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function fillDailyWindow(
  byDay: Map<string, TokenUsageDailyPoint>,
  days: number,
  now: Date,
): TokenUsageDailyPoint[] {
  const end = startOfLocalDay(now);
  const out: TokenUsageDailyPoint[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(end);
    day.setDate(end.getDate() - i);
    const key = toLocalDayKey(day);
    if (!key) continue;
    out.push(
      byDay.get(key) ?? {
        date: key,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        estimatedCostUsd: 0,
        tasks: 0,
      },
    );
  }
  return out;
}

export function pickPeakDay(
  daily: TokenUsageDailyPoint[],
): { date: string; totalTokens: number } | null {
  let best: { date: string; totalTokens: number } | null = null;
  for (const point of daily) {
    if (point.totalTokens <= 0) continue;
    if (!best || point.totalTokens > best.totalTokens) {
      best = { date: point.date, totalTokens: point.totalTokens };
    }
  }
  return best;
}

function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function isMeasuredUsage(usage: AggregatedTokenUsage | undefined): usage is AggregatedTokenUsage {
  return !!usage?.available;
}

function safeNumber(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
