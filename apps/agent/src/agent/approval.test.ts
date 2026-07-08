import { describe, expect, it } from "vitest"
import { decideToolPermission } from "./approval.js"

const baseConfig = {
  autoModeLevel: "auto" as const,
  autoModePaused: false,
}

describe("decideToolPermission", () => {
  it("allows safe tools in every mode", () => {
    const result = decideToolPermission(baseConfig, "web_fetch", "safe")

    expect(result.allowed).toBe(true)
  })

  it("auto-approves all non-safe tools in auto mode", () => {
    const result = decideToolPermission(baseConfig, "bash", "dangerous")

    expect(result.allowed).toBe(true)
  })

  it("blocks non-safe tools in plan mode before plan approval", () => {
    const result = decideToolPermission(
      { ...baseConfig, autoModeLevel: "plan" },
      "write",
      "dangerous",
    )

    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("plan approval")
  })

  it("respects paused state even in auto mode", () => {
    const result = decideToolPermission(
      { ...baseConfig, autoModePaused: true },
      "bash",
      "dangerous",
    )

    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("paused")
  })

  it("allows caution-risk tools in auto mode", () => {
    const result = decideToolPermission(baseConfig, "web_fetch", "caution")

    expect(result.allowed).toBe(true)
  })
})
