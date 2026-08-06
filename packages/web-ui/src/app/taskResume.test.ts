import { describe, expect, it } from "vitest";
import { canResumeTask } from "./taskResume";

describe("canResumeTask", () => {
  it("allows failed and cancelled tasks when the agent is idle", () => {
    expect(canResumeTask({ status: "failed", phase: "failed" }, false)).toBe(true);
    expect(canResumeTask({ status: "cancelled", phase: "cancelled" }, false)).toBe(true);
  });

  it("keeps running, planning and completed tasks out of the resume action", () => {
    expect(canResumeTask({ status: "running", phase: "calling_tool" }, false)).toBe(false);
    expect(canResumeTask({ status: "planning", phase: "planning" }, false)).toBe(false);
    expect(canResumeTask({ status: "completed", phase: null }, false)).toBe(false);
    expect(canResumeTask({ status: "failed", phase: "failed" }, true)).toBe(false);
  });

  it("only resumes paused tasks waiting on budget or completion gates", () => {
    expect(canResumeTask({ status: "paused", phase: "waiting_budget" }, false)).toBe(true);
    expect(canResumeTask({ status: "paused", phase: "waiting_completion" }, false)).toBe(true);
    expect(canResumeTask({ status: "paused", phase: "waiting_approval" }, false)).toBe(false);
    expect(canResumeTask({ status: "paused", phase: "waiting_clarification" }, false)).toBe(false);
  });
});
