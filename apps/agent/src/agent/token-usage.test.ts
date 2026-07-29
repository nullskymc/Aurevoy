import { describe, expect, it } from "vitest"
import type { Task } from "@aurevoy/shared"
import {
  buildTokenUsageReport,
  fillDailyWindow,
  pickPeakDay,
  resolveUsageDayKey,
  toLocalDayKey,
} from "./token-usage.js"

function task(
  id: string,
  opts?: {
    tokenUsage?: Task["tokenUsage"]
    createdAt?: string
    updatedAt?: string
  },
): Task {
  return {
    id,
    goal: id,
    title: id,
    titleSource: "truncated",
    status: "completed",
    phase: "finalizing",
    plan: [],
    messages: [],
    tokenUsage: opts?.tokenUsage,
    createdAt: opts?.createdAt ?? "2026-07-06T00:00:00.000Z",
    updatedAt: opts?.updatedAt ?? "2026-07-06T00:00:00.000Z",
  }
}

describe("buildTokenUsageReport", () => {
  it("aggregates measured tasks and groups usage by provider/model", () => {
    const report = buildTokenUsageReport([
      task("a", {
        tokenUsage: {
          available: true,
          provider: "openai",
          model: "gpt-5",
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          reasoningTokens: 20,
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
          estimatedCostUsd: 0.01,
        },
      }),
      task("b", {
        tokenUsage: {
          available: true,
          provider: "openai",
          model: "gpt-5",
          promptTokens: 20,
          completionTokens: 10,
          totalTokens: 30,
        },
      }),
      task("c", {
        tokenUsage: {
          available: true,
          provider: "anthropic",
          model: "claude",
          promptTokens: 7,
          completionTokens: 3,
          totalTokens: 10,
        },
      }),
      task("d", { tokenUsage: { available: false, provider: "openai", model: "gpt-5" } }),
      task("e"),
    ])

    expect(report.tasks).toBe(5)
    expect(report.measuredTasks).toBe(3)
    expect(report.available).toBe(true)
    expect(report.promptTokens).toBe(127)
    expect(report.completionTokens).toBe(63)
    expect(report.totalTokens).toBe(190)
    expect(report.reasoningTokens).toBe(20)
    expect(report.cacheReadTokens).toBe(10)
    expect(report.cacheWriteTokens).toBe(5)
    expect(report.estimatedCostUsd).toBe(0.01)
    expect(report.breakdown).toMatchObject([
      { provider: "openai", model: "gpt-5", tasks: 2, totalTokens: 180 },
      { provider: "anthropic", model: "claude", tasks: 1, totalTokens: 10 },
    ])
    expect(report.daily).toHaveLength(14)
  })

  it("keeps report unavailable when no task has provider usage", () => {
    const report = buildTokenUsageReport([
      task("a"),
      task("b", { tokenUsage: { available: false, provider: "openai", model: "gpt-5" } }),
    ])

    expect(report.tasks).toBe(2)
    expect(report.measuredTasks).toBe(0)
    expect(report.available).toBe(false)
    expect(report.totalTokens).toBe(0)
    expect(report.breakdown).toEqual([])
    expect(report.daily).toHaveLength(14)
    expect(report.daily.every((d) => d.totalTokens === 0 && d.tasks === 0)).toBe(true)
    expect(report.peakDay).toBeNull()
  })

  it("counts usage even when provider field was polluted with provider:model legacy format", () => {
    const report = buildTokenUsageReport([
      task("legacy", {
        tokenUsage: {
          available: true,
          provider: "openai:gpt-4o-mini",
          model: "gpt-4o-mini",
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 12,
        },
      }),
    ])
    expect(report.available).toBe(true)
    expect(report.totalTokens).toBe(12)
    expect(report.breakdown[0]?.provider).toBe("openai:gpt-4o-mini")
  })

  it("builds daily series from usage.updatedAt with task timestamp fallback", () => {
    const now = new Date(2026, 6, 15, 12, 0, 0) // local Jul 15 2026
    const dayA = new Date(2026, 6, 10, 9, 0, 0)
    const dayB = new Date(2026, 6, 14, 18, 0, 0)
    const dayC = new Date(2026, 6, 15, 8, 0, 0)

    const report = buildTokenUsageReport(
      [
        task("a", {
          tokenUsage: {
            available: true,
            provider: "openai",
            model: "gpt-5",
            promptTokens: 80,
            completionTokens: 20,
            totalTokens: 100,
            estimatedCostUsd: 0.02,
            updatedAt: dayA.toISOString(),
          },
          updatedAt: dayB.toISOString(),
        }),
        // prefers usage.updatedAt over task.updatedAt
        task("b", {
          tokenUsage: {
            available: true,
            provider: "openai",
            model: "gpt-5",
            promptTokens: 40,
            completionTokens: 10,
            totalTokens: 50,
            updatedAt: dayB.toISOString(),
          },
          updatedAt: dayC.toISOString(),
        }),
        // no usage.updatedAt → task.updatedAt
        task("c", {
          tokenUsage: {
            available: true,
            provider: "anthropic",
            model: "claude",
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
          },
          updatedAt: dayC.toISOString(),
          createdAt: dayA.toISOString(),
        }),
        // outside window still counts in lifetime totals
        task("old", {
          tokenUsage: {
            available: true,
            provider: "openai",
            model: "gpt-5",
            totalTokens: 999,
            promptTokens: 900,
            completionTokens: 99,
            updatedAt: new Date(2026, 5, 1).toISOString(),
          },
        }),
      ],
      { dailyDays: 7, now },
    )

    expect(report.daily).toHaveLength(7)
    expect(report.daily[0]?.date).toBe(toLocalDayKey(new Date(2026, 6, 9)))
    expect(report.daily[6]?.date).toBe(toLocalDayKey(now))

    const map = Object.fromEntries(report.daily.map((d) => [d.date, d]))
    const keyA = toLocalDayKey(dayA)!
    const keyB = toLocalDayKey(dayB)!
    const keyC = toLocalDayKey(dayC)!

    expect(map[keyA]?.totalTokens).toBe(100)
    expect(map[keyA]?.tasks).toBe(1)
    expect(map[keyB]?.totalTokens).toBe(50)
    expect(map[keyC]?.totalTokens).toBe(15)
    expect(map[keyC]?.tasks).toBe(1)

    // lifetime still includes out-of-window task
    expect(report.totalTokens).toBe(100 + 50 + 15 + 999)
    expect(report.peakDay).toEqual({ date: keyA, totalTokens: 100 })
  })
})

describe("daily helpers", () => {
  it("resolveUsageDayKey prefers usage.updatedAt then task times", () => {
    const t = task("x", {
      tokenUsage: {
        available: true,
        provider: "openai",
        model: "m",
        totalTokens: 1,
        updatedAt: "2026-07-12T10:00:00.000Z",
      },
      updatedAt: "2026-07-14T10:00:00.000Z",
      createdAt: "2026-07-01T10:00:00.000Z",
    })
    expect(resolveUsageDayKey(t, t.tokenUsage!)).toBe(
      toLocalDayKey("2026-07-12T10:00:00.000Z"),
    )

    const noUsageAt = task("y", {
      tokenUsage: { available: true, provider: "openai", model: "m", totalTokens: 1 },
      updatedAt: "2026-07-14T10:00:00.000Z",
      createdAt: "2026-07-01T10:00:00.000Z",
    })
    expect(resolveUsageDayKey(noUsageAt, noUsageAt.tokenUsage!)).toBe(
      toLocalDayKey("2026-07-14T10:00:00.000Z"),
    )
  })

  it("fillDailyWindow pads zeros and pickPeakDay ignores empty days", () => {
    const now = new Date(2026, 6, 15)
    const key = toLocalDayKey(new Date(2026, 6, 14))!
    const map = new Map([
      [
        key,
        {
          date: key,
          totalTokens: 42,
          promptTokens: 30,
          completionTokens: 12,
          estimatedCostUsd: 0.01,
          tasks: 2,
        },
      ],
    ])
    const daily = fillDailyWindow(map, 3, now)
    expect(daily).toHaveLength(3)
    expect(daily.map((d) => d.totalTokens)).toEqual([0, 42, 0])
    expect(pickPeakDay(daily)).toEqual({ date: key, totalTokens: 42 })
    expect(pickPeakDay(fillDailyWindow(new Map(), 3, now))).toBeNull()
  })
})
