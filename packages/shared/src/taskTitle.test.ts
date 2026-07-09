import { describe, expect, it } from "vitest";
import { formatTaskTitle, taskDisplayTitle, TASK_TITLE_MAX_LENGTH } from "./index.js";

describe("formatTaskTitle", () => {
  it("collapses whitespace and newlines", () => {
    expect(formatTaskTitle("hello\n\nworld")).toBe("hello world");
  });

  it("truncates long text to max length with ellipsis", () => {
    const long = "a".repeat(TASK_TITLE_MAX_LENGTH + 20);
    const title = formatTaskTitle(long);
    expect([...title].length).toBe(TASK_TITLE_MAX_LENGTH);
    expect(title.endsWith("…")).toBe(true);
  });

  it("prefers explicit title in taskDisplayTitle", () => {
    expect(taskDisplayTitle({ goal: "full goal text", title: "Short" })).toBe("Short");
  });
});
