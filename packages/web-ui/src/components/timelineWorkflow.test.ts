import { describe, expect, it } from "vitest";
import {
  classifyTimelineToolStatus,
  isCancelledToolError,
  shouldHideToolFromWorkflow,
} from "./timelineWorkflow";

describe("timelineWorkflow", () => {
  it("hides only internally represented activities", () => {
    expect(shouldHideToolFromWorkflow("update_plan")).toBe(true);
    expect(shouldHideToolFromWorkflow("delegate")).toBe(true);
    expect(shouldHideToolFromWorkflow("read")).toBe(false);
  });

  it("distinguishes cancellation text from an ordinary tool failure", () => {
    expect(isCancelledToolError("任务被取消")).toBe(true);
    expect(isCancelledToolError("permission denied")).toBe(false);
    expect(classifyTimelineToolStatus({ ok: false, error: "aborted by user" }, false)).toBe("cancelled");
    expect(classifyTimelineToolStatus({ ok: false, error: "permission denied" }, false)).toBe("failed");
    expect(classifyTimelineToolStatus(undefined, true)).toBe("cancelled");
  });
});
