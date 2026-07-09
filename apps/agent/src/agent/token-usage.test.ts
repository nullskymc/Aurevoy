import { describe, expect, it } from "vitest"
import type { Task } from "@aurevoy/shared"
import { buildTokenUsageReport } from "./token-usage.js"

function task(id: string, tokenUsage?: Task["tokenUsage"]): Task {
  return {
    id,
    goal: id,
    title: id,
    titleSource: "truncated",
    status: "completed",
    phase: "finalizing",
    plan: [],
    messages: [],
    tokenUsage,
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z",
  }
}

describe("buildTokenUsageReport", () => {
  it("aggregates measured tasks and groups usage by provider/model", () => {
    const report = buildTokenUsageReport([
      task("a", {
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
      }),
      task("b", {
        available: true,
        provider: "openai",
        model: "gpt-5",
        promptTokens: 20,
        completionTokens: 10,
        totalTokens: 30,
      }),
      task("c", {
        available: true,
        provider: "anthropic",
        model: "claude",
        promptTokens: 7,
        completionTokens: 3,
        totalTokens: 10,
      }),
      task("d", { available: false, provider: "openai", model: "gpt-5" }),
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
  })

  it("keeps report unavailable when no task has provider usage", () => {
    const report = buildTokenUsageReport([
      task("a"),
      task("b", { available: false, provider: "openai", model: "gpt-5" }),
    ])

    expect(report.tasks).toBe(2)
    expect(report.measuredTasks).toBe(0)
    expect(report.available).toBe(false)
    expect(report.totalTokens).toBe(0)
    expect(report.breakdown).toEqual([])
  })
})
