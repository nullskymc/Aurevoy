import { describe, expect, it } from "vitest";
import { shouldVirtualizeText, VIRTUAL_TEXT_LINE_THRESHOLD } from "./VirtualTextSource";

describe("shouldVirtualizeText", () => {
  it("keeps ordinary previews on the existing source renderer", () => {
    expect(shouldVirtualizeText("line 1\nline 2")).toBe(false);
  });

  it("virtualizes source content beyond the line safety threshold", () => {
    const content = Array.from({ length: VIRTUAL_TEXT_LINE_THRESHOLD + 1 }, (_, index) => `line ${index}`).join("\n");
    expect(shouldVirtualizeText(content)).toBe(true);
  });
});
