import { describe, expect, it } from "vitest";
import {
  avgTokensPerTask,
  buildCompositionRows,
  composeInputShare,
  composeOutputShare,
  dailyBarHeight,
  formatCost,
  formatDayLabel,
  formatExactTokens,
  formatPct,
  formatTokenCount,
  pct,
  shareBarWidth,
  shouldShowDayLabel,
  summarizeDailyActivity,
} from "./usageFormat";

describe("formatTokenCount", () => {
  it("formats compact magnitudes for glance UI", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(42)).toBe("42");
    expect(formatTokenCount(1_000)).toBe("1.00k");
    expect(formatTokenCount(12_500)).toBe("12.5k");
    expect(formatTokenCount(1_250_000)).toBe("1.25M");
    expect(formatTokenCount(12_500_000)).toBe("12.5M");
  });

  it("guards invalid input", () => {
    expect(formatTokenCount(-3)).toBe("0");
    expect(formatTokenCount(Number.NaN)).toBe("0");
  });
});

describe("formatCost", () => {
  it("shows em dash when cost is missing or non-positive", () => {
    expect(formatCost(0)).toBe("—");
    expect(formatCost(-0.01)).toBe("—");
    expect(formatCost(Number.NaN)).toBe("—");
  });

  it("uses finer precision for tiny costs", () => {
    expect(formatCost(0.0042)).toBe("$0.0042");
    expect(formatCost(0.42)).toBe("$0.420");
    expect(formatCost(3.2)).toBe("$3.20");
  });
});

describe("pct / formatPct / shareBarWidth", () => {
  it("computes share of total", () => {
    expect(pct(25, 100)).toBe(25);
    expect(pct(1, 3)).toBeCloseTo(33.333, 2);
  });

  it("returns 0 for empty whole or invalid parts", () => {
    expect(pct(10, 0)).toBe(0);
    expect(pct(-1, 10)).toBe(0);
    expect(pct(Number.NaN, 10)).toBe(0);
  });

  it("formats percent labels with em dash when whole is empty", () => {
    expect(formatPct(50, 100)).toBe("50.0%");
    expect(formatPct(1, 3, 0)).toBe("33%");
    expect(formatPct(5, 0)).toBe("—");
  });

  it("keeps non-zero bars visible with a minimum width", () => {
    expect(shareBarWidth(1, 10_000)).toBe(1.5);
    expect(shareBarWidth(5000, 10_000)).toBe(50);
    expect(shareBarWidth(0, 10_000)).toBe(0);
  });
});

describe("buildCompositionRows", () => {
  it("always includes input and output rows", () => {
    const rows = buildCompositionRows({
      totalTokens: 100,
      promptTokens: 70,
      completionTokens: 30,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(rows.map((r) => r.id)).toEqual(["prompt", "completion"]);
    expect(rows[0]?.shareOfTotal).toBe(70);
    expect(rows[1]?.shareOfTotal).toBe(30);
  });

  it("adds reasoning and cache buckets only when present", () => {
    const rows = buildCompositionRows({
      totalTokens: 200,
      promptTokens: 120,
      completionTokens: 80,
      reasoningTokens: 20,
      cacheReadTokens: 40,
      cacheWriteTokens: 5,
    });
    expect(rows.map((r) => r.id)).toEqual([
      "prompt",
      "completion",
      "reasoning",
      "cache-read",
      "cache-write",
    ]);
    const reasoning = rows.find((r) => r.id === "reasoning");
    expect(reasoning?.relativeOf).toBe("output");
    expect(reasoning?.relativeShare).toBe(25);
    const cache = rows.find((r) => r.id === "cache-read");
    expect(cache?.relativeOf).toBe("input");
    expect(cache?.relativeShare).toBeCloseTo(33.333, 2);
  });

  it("handles zero-total unmeasured-style aggregates", () => {
    const rows = buildCompositionRows({
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.shareOfTotal === 0 && r.value === 0)).toBe(true);
  });
});

describe("compose shares and avg", () => {
  it("splits stacked bar by input vs output of their sum", () => {
    expect(composeInputShare(75, 25)).toBe(75);
    expect(composeOutputShare(75, 25)).toBe(25);
    expect(composeInputShare(0, 0)).toBe(0);
  });

  it("averages tokens per measured task", () => {
    expect(avgTokensPerTask(300, 3)).toBe(100);
    expect(avgTokensPerTask(100, 0)).toBe(0);
    expect(avgTokensPerTask(-1, 2)).toBe(0);
  });
});

describe("formatExactTokens", () => {
  it("round-trips to a locale token label", () => {
    expect(formatExactTokens(1234)).toMatch(/1,?234 tokens/);
    expect(formatExactTokens(0)).toBe("0 tokens");
  });
});

describe("daily activity helpers", () => {
  it("summarizes window tokens, active days, peak and today", () => {
    const summary = summarizeDailyActivity([
      { date: "2026-07-13", totalTokens: 0 },
      { date: "2026-07-14", totalTokens: 200 },
      { date: "2026-07-15", totalTokens: 50 },
    ]);
    expect(summary.windowTokens).toBe(250);
    expect(summary.activeDays).toBe(2);
    expect(summary.peakTokens).toBe(200);
    expect(summary.peakDate).toBe("2026-07-14");
    expect(summary.todayTokens).toBe(50);
  });

  it("maps bar height against peak with a visible floor", () => {
    expect(dailyBarHeight(0, 100)).toBe(0);
    expect(dailyBarHeight(100, 100)).toBe(100);
    expect(dailyBarHeight(1, 1000)).toBe(6);
    expect(dailyBarHeight(50, 0)).toBe(0);
  });

  it("formats day labels and decides axis tick density", () => {
    expect(formatDayLabel("2026-07-15")).toBe("7/15");
    expect(formatDayLabel("bad")).toBe("bad");
    expect(shouldShowDayLabel(0, 14)).toBe(true);
    expect(shouldShowDayLabel(13, 14)).toBe(true);
    expect(shouldShowDayLabel(3, 14)).toBe(true);
    expect(shouldShowDayLabel(1, 14)).toBe(false);
  });
});
