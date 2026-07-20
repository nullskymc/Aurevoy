import { describe, expect, it } from "vitest"
import { buildPlanSteps } from "./update-plan.js"

describe("buildPlanSteps", () => {
  it("keeps every future step proposed in Plan mode", () => {
    const plan = buildPlanSteps([
      { id: "research", description: "核对开放时间", status: "completed" },
      { id: "route", description: "规划路线", status: "running", dependsOn: ["research"] },
    ], "plan")

    expect(plan.map((step) => step.status)).toEqual(["proposed", "proposed"])
    expect(plan[1]?.dependsOn).toEqual(["research"])
    expect(plan.every((step) => step.source === "llm")).toBe(true)
  })

  it("preserves explicit progress in Agent mode and filters unknown dependencies", () => {
    const plan = buildPlanSteps([
      { id: "scan", description: "扫描材料", status: "completed" },
      { id: "write", description: "整理结果", status: "running", dependsOn: ["scan", "missing"] },
    ], "auto")

    expect(plan.map((step) => step.status)).toEqual(["completed", "running"])
    expect(plan[1]?.dependsOn).toEqual(["scan"])
  })
})
