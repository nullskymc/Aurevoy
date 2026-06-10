import { describe, expect, it } from "vitest";
import { t, getLocale } from "./index";

describe("i18n", () => {
  it("defaults to the zh locale", () => {
    expect(getLocale()).toBe("zh");
  });

  it("resolves known translation keys", () => {
    expect(t("status.completed")).toBe("已完成");
    expect(t("action.retry")).toBe("重试");
    expect(t("mode.artifacts")).toBe("产物");
  });
});
