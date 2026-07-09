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
  planApproved: false,
}

const planPendingConfig = {
  autoModeLevel: "plan" as const,
  autoModePaused: false,
  planApproved: false,
}

const planApprovedConfig = {
  autoModeLevel: "plan" as const,
  autoModePaused: false,
  planApproved: true,
}

describe("decideToolPermission", () => {
  it("allows safe tools in every mode", () => {
    expect(decideToolPermission(autoConfig, "web_fetch", "safe").allowed).toBe(true)
    expect(decideToolPermission(planPendingConfig, "list_directory", "safe").allowed).toBe(true)
    expect(decideToolPermission(planApprovedConfig, "get_current_time", "safe").allowed).toBe(true)
  })

  it("auto-approves all non-safe tools in auto mode", () => {
    const result = decideToolPermission(autoConfig, "bash", "dangerous")
    expect(result.allowed).toBe(true)
    expect(result.autoApproved).toBe(true)
  })

  it("blocks non-safe tools in plan mode before plan approval", () => {
    const result = decideToolPermission(planPendingConfig, "write", "dangerous")
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("plan approval")
  })

  it("auto-approves non-safe tools in plan mode after plan approval", () => {
    const result = decideToolPermission(planApprovedConfig, "write", "dangerous")
    expect(result.allowed).toBe(true)
    expect(result.autoApproved).toBe(true)
  })

  it("respects paused state even in auto mode", () => {
    const result = decideToolPermission(
      { ...autoConfig, autoModePaused: true },
      "bash",
      "dangerous",
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("paused")
  })

  it("respects paused state even after plan approval", () => {
    const result = decideToolPermission(
      { ...planApprovedConfig, autoModePaused: true },
      "bash",
      "dangerous",
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("paused")
  })

  it("allows caution-risk tools in auto mode", () => {
    const result = decideToolPermission(autoConfig, "web_fetch", "caution")
    expect(result.allowed).toBe(true)
  })
})

describe("approvalConfigFromTask", () => {
  it("inherits paused and planApproved from parent task state", () => {
    const task = {
      autoModeState: {
        level: "plan" as const,
        autoApprovedCalls: 2,
        blockedByRules: 0,
        paused: true,
        planApproved: true,
      },
    }
    const config = approvalConfigFromTask(task, "plan")
    expect(config).toEqual({
      autoModeLevel: "plan",
      autoModePaused: true,
      planApproved: true,
    })
  })
})

describe("syncAutoModeState", () => {
  it("creates state and preserves planApproved across sync", () => {
    const task = { autoModeState: undefined } as Task
    const first = syncAutoModeState(task, "plan")
    expect(first.planApproved).toBe(false)
    expect(createInitialAutoModeState("plan").planApproved).toBe(false)

    task.autoModeState = { ...first, planApproved: true, autoApprovedCalls: 3 }
    const second = syncAutoModeState(task, "plan")
    expect(second.planApproved).toBe(true)
    expect(second.autoApprovedCalls).toBe(3)
    expect(second.level).toBe("plan")
  })
})
