import { describe, expect, it } from "vitest";
import { t, getLocale, setLocale } from "./index";

describe("i18n", () => {
  it("defaults to the en locale", () => {
    expect(getLocale()).toBe("en");
  });

  it("resolves known translation keys in zh", () => {
    setLocale("zh");
    expect(t("status.completed")).toBe("已完成");
    expect(t("action.retry")).toBe("重试");
    expect(t("mode.artifacts")).toBe("产物");
  });

  it("resolves known translation keys in en", () => {
    setLocale("en");
    expect(getLocale()).toBe("en");
    expect(t("status.completed")).toBe("Completed");
    expect(t("action.retry")).toBe("Retry");
    expect(t("mode.artifacts")).toBe("Artifacts");
  });

  it("resolves known translation keys in ko", () => {
    setLocale("ko");
    expect(getLocale()).toBe("ko");
    expect(t("status.completed")).toBe("완료");
    expect(t("action.retry")).toBe("재시도");
    expect(t("mode.artifacts")).toBe("산출물");
  });

  it("resolves known translation keys in ja", () => {
    setLocale("ja");
    expect(getLocale()).toBe("ja");
    expect(t("status.completed")).toBe("完了");
    expect(t("action.retry")).toBe("再試行");
    expect(t("mode.artifacts")).toBe("成果物");
  });
});
