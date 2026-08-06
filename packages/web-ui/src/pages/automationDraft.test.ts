import { describe, expect, it } from "vitest";
import { budgetFromDraft, parseBudgetLimit } from "./automationDraft";

describe("automationDraft", () => {
  it("accepts only positive integer budget limits", () => {
    expect(parseBudgetLimit("12")).toBe(12);
    expect(parseBudgetLimit("0")).toBeUndefined();
    expect(parseBudgetLimit("1.5")).toBeUndefined();
    expect(parseBudgetLimit("")).toBeUndefined();
  });

  it("keeps empty budget scopes unset and maps explicit limits", () => {
    expect(budgetFromDraft("", "")).toBeUndefined();
    expect(budgetFromDraft("20", "80")).toEqual({ maxIterations: 20, maxToolCalls: 80 });
  });
});
