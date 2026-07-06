import { describe, expect, it } from "vitest"
import { decideToolPermission } from "./approval.js"

const baseConfig = {
  autoModeLevel: "off" as const,
  autoModePaused: false,
}

describe("decideToolPermission", () => {
  it("allows safe tools in every mode", () => {
    const result = decideToolPermission(baseConfig, "web_fetch", "safe")

    expect(result.allowed).toBe(true)
  })

  it("requires one-time approval for non-safe tools when auto mode is off", () => {
    const result = decideToolPermission(baseConfig, "bash", "dangerous")

    expect(result.allowed).toBe(false)
  })

  it("keeps plan mode read-only by blocking non-safe tools", () => {
    const result = decideToolPermission(
      { ...baseConfig, autoModeLevel: "plan" },
      "write",
      "dangerous",
    )

    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("Plan mode")
  })

  it("allows workspace file edits in auto-edit mode", () => {
    const result = decideToolPermission(
      { ...baseConfig, autoModeLevel: "auto-edit" },
      "edit",
      "dangerous",
    )

    expect(result.allowed).toBe(true)
  })

  it("does not allow shell commands in auto-edit mode", () => {
    const result = decideToolPermission(
      { ...baseConfig, autoModeLevel: "auto-edit" },
      "bash",
      "dangerous",
    )

    expect(result.allowed).toBe(false)
  })

  it("allows dangerous tools in full auto mode", () => {
    const result = decideToolPermission(
      { ...baseConfig, autoModeLevel: "full" },
      "bash",
      "dangerous",
    )

    expect(result.allowed).toBe(true)
  })

  it("respects paused auto mode before non-safe tools", () => {
    const result = decideToolPermission(
      { ...baseConfig, autoModeLevel: "full", autoModePaused: true },
      "bash",
      "dangerous",
    )

    expect(result.allowed).toBe(false)
  })
})

