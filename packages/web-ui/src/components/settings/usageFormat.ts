/**
 * Pure helpers for the Settings → Usage dashboard.
 * Kept free of React/i18n so unit tests can drive the shipped formatters.
 */

export type UsageMetricTone =
  | "is-input"
  | "is-output"
  | "is-reasoning"
  | "is-cache"
  | "is-cache-write";

export interface UsageCompositionInput {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface UsageCompositionRow {
  id: string;
  value: number;
  /** Share of totalTokens (0–100). */
  shareOfTotal: number;
  /** Secondary relative share (e.g. of input / of output), 0–100 when applicable. */
  relativeShare: number | null;
  relativeOf: "total" | "input" | "output";
  tone: UsageMetricTone;
}

/** Safe percentage: part / whole * 100; 0 when invalid. */
export function pct(part: number, whole: number): number {
  if (!whole || whole <= 0 || !Number.isFinite(part) || part < 0) return 0;
  return (part / whole) * 100;
}

/** Compact token count for glance UI (1.2k, 3.45M). */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}k`;
  return String(Math.round(n));
}

/** Exact token label for title tooltips. */
export function formatExactTokens(n: number): string {
  const safe = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  return `${safe.toLocaleString()} tokens`;
}

/**
 * Estimated USD cost. Missing / non-positive cost stays "—" so zeros never look like free usage.
 */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "—";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** One-decimal percentage label, or "—" when whole is empty. */
export function formatPct(part: number, whole: number, digits = 1): string {
  if (!whole || whole <= 0) return "—";
  return `${pct(part, whole).toFixed(digits)}%`;
}

/**
 * Bar width in percent for share visuals.
 * Non-zero values get a small minimum so they remain visible.
 */
export function shareBarWidth(part: number, whole: number, minVisible = 1.5): number {
  const share = pct(part, whole);
  if (share <= 0) return 0;
  return Math.max(share, minVisible);
}

/**
 * Composition rows for the dashboard: always input + output when total > 0;
 * reasoning / cache appear only when present (Claude-style cost buckets).
 */
export function buildCompositionRows(input: UsageCompositionInput): UsageCompositionRow[] {
  const {
    totalTokens,
    promptTokens,
    completionTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
  } = input;

  const rows: UsageCompositionRow[] = [
    {
      id: "prompt",
      value: promptTokens,
      shareOfTotal: pct(promptTokens, totalTokens),
      relativeShare: null,
      relativeOf: "total",
      tone: "is-input",
    },
    {
      id: "completion",
      value: completionTokens,
      shareOfTotal: pct(completionTokens, totalTokens),
      relativeShare: null,
      relativeOf: "total",
      tone: "is-output",
    },
  ];

  if (reasoningTokens > 0) {
    rows.push({
      id: "reasoning",
      value: reasoningTokens,
      shareOfTotal: pct(reasoningTokens, totalTokens),
      relativeShare: pct(reasoningTokens, completionTokens),
      relativeOf: "output",
      tone: "is-reasoning",
    });
  }

  if (cacheReadTokens > 0) {
    rows.push({
      id: "cache-read",
      value: cacheReadTokens,
      shareOfTotal: pct(cacheReadTokens, totalTokens),
      relativeShare: pct(cacheReadTokens, promptTokens),
      relativeOf: "input",
      tone: "is-cache",
    });
  }

  if (cacheWriteTokens > 0) {
    rows.push({
      id: "cache-write",
      value: cacheWriteTokens,
      shareOfTotal: pct(cacheWriteTokens, totalTokens),
      relativeShare: null,
      relativeOf: "total",
      tone: "is-cache-write",
    });
  }

  return rows;
}

/** Input share of prompt+completion for the stacked compose bar (0–100). */
export function composeInputShare(promptTokens: number, completionTokens: number): number {
  return pct(promptTokens, promptTokens + completionTokens);
}

/** Output share of prompt+completion for the stacked compose bar (0–100). */
export function composeOutputShare(promptTokens: number, completionTokens: number): number {
  return pct(completionTokens, promptTokens + completionTokens);
}

/** Average tokens per measured task; 0 when no measured tasks. */
export function avgTokensPerTask(totalTokens: number, measuredTasks: number): number {
  if (!measuredTasks || measuredTasks <= 0 || !Number.isFinite(totalTokens) || totalTokens < 0) {
    return 0;
  }
  return totalTokens / measuredTasks;
}

export interface UsageDailyPointLike {
  date: string;
  totalTokens: number;
  tasks?: number;
}

/**
 * Bar height percent for a daily activity column (0–100).
 * Non-zero values keep a small minimum so sparse days stay visible.
 */
export function dailyBarHeight(
  tokens: number,
  peakTokens: number,
  minVisible = 6,
): number {
  if (!peakTokens || peakTokens <= 0 || !Number.isFinite(tokens) || tokens <= 0) return 0;
  const raw = (tokens / peakTokens) * 100;
  return Math.min(100, Math.max(raw, minVisible));
}

/** Sum tokens / active days in a daily window (honest zeros stay zero). */
export function summarizeDailyActivity(daily: UsageDailyPointLike[]): {
  windowTokens: number;
  activeDays: number;
  peakTokens: number;
  peakDate: string | null;
  todayTokens: number;
} {
  let windowTokens = 0;
  let activeDays = 0;
  let peakTokens = 0;
  let peakDate: string | null = null;
  for (const point of daily) {
    const tokens = Number.isFinite(point.totalTokens) ? Math.max(0, point.totalTokens) : 0;
    windowTokens += tokens;
    if (tokens > 0) activeDays += 1;
    if (tokens > peakTokens) {
      peakTokens = tokens;
      peakDate = point.date;
    }
  }
  const today = daily.length > 0 ? daily[daily.length - 1] : null;
  const todayTokens =
    today && Number.isFinite(today.totalTokens) ? Math.max(0, today.totalTokens) : 0;
  return { windowTokens, activeDays, peakTokens, peakDate, todayTokens };
}

/** Short axis label from YYYY-MM-DD → M/D (locale-agnostic digits). */
export function formatDayLabel(dateKey: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) return dateKey;
  return `${Number(m[2])}/${Number(m[3])}`;
}

/** Whether to show a label under a daily bar (first, last, and every Nth). */
export function shouldShowDayLabel(index: number, length: number, every = 3): boolean {
  if (length <= 0) return false;
  if (index === 0 || index === length - 1) return true;
  return index % every === 0;
}
