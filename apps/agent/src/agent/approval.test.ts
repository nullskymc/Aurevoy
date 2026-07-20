import { describe, expect, it } from "vitest"
import {
  approvalConfigFromTask,
  createInitialAutoModeState,
  decideToolPermission,
  syncAutoModeState,
} from "./approval.js"
import type { Task } from "@aurevoy/shared"

const autoConfig = {
  autoModeLevel: "auto" as const,
  autoModePaused: false,
}

describe("decideToolPermission", () => {
  it("allows safe tools", () => {
    expect(decideToolPermission(autoConfig, "web_fetch", "safe").allowed).toBe(true)
    expect(decideToolPermission(autoConfig, "list_directory", "safe").allowed).toBe(true)
  })

  it("auto-approves non-safe tools", () => {
    const result = decideToolPermission(autoConfig, "bash", "dangerous")
    expect(result.allowed).toBe(true)
    expect(result.autoApproved).toBe(true)
  })

  it("respects paused state", () => {
    const result = decideToolPermission(
      { ...autoConfig, autoModePaused: true },
      "bash",
      "dangerous",
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("paused")
  })

  it("allows caution-risk tools when not paused", () => {
    const result = decideToolPermission(autoConfig, "web_fetch", "caution")
    expect(result.allowed).toBe(true)
  })
})

describe("approvalConfigFromTask", () => {
  it("inherits paused state and the parent's execution mode", () => {
    const task = {
      autoModeState: {
        level: "auto" as const,
        autoApprovedCalls: 2,
        blockedByRules: 0,
        paused: true,
      },
    }
    const config = approvalConfigFromTask(task)
    expect(config).toEqual({
      autoModeLevel: "auto",
      autoModePaused: true,
    })
  })

  it("preserves plan mode when creating and syncing state", () => {
    const task = { autoModeState: undefined } as Task
    expect(createInitialAutoModeState("plan").level).toBe("plan")
    expect(syncAutoModeState(task, "plan").level).toBe("plan")
  })
})

describe("syncAutoModeState", () => {
  it("creates auto state and preserves counters", () => {
    const task = { autoModeState: undefined } as Task
    const first = syncAutoModeState(task)
    expect(first.level).toBe("auto")
    expect(createInitialAutoModeState().level).toBe("auto")

    task.autoModeState = { ...first, autoApprovedCalls: 3 }
    const second = syncAutoModeState(task)
    expect(second.autoApprovedCalls).toBe(3)
    expect(second.level).toBe("auto")
  })
})
