import { describe, expect, it } from "vitest";
import {
  detectSystemLocale,
  getLocale,
  mapLanguageTagToLocale,
  setLocale,
  t,
} from "./index";

describe("i18n", () => {
  it("defaults module locale to en until setLocale is called", () => {
    // 模块默认 en；应用启动时由 readStoredLocale → setLocale 覆盖为系统或用户选择
    setLocale("en");
    expect(getLocale()).toBe("en");
  });

  it("maps system language tags used at first launch", () => {
    expect(mapLanguageTagToLocale("zh-CN")).toBe("zh");
    expect(detectSystemLocale(["zh-Hans-CN", "en"])).toBe("zh");
  });

  it("resolves known translation keys in zh", () => {
    setLocale("zh");
    expect(t("status.completed")).toBe("已完成");
    expect(t("action.retry")).toBe("重试");
    expect(t("nav.conversations")).toBe("对话");
  });

  it("resolves known translation keys in en", () => {
    setLocale("en");
    expect(getLocale()).toBe("en");
    expect(t("status.completed")).toBe("Completed");
    expect(t("action.retry")).toBe("Retry");
    expect(t("nav.conversations")).toBe("Conversations");
  });

  it("resolves known translation keys in ko", () => {
    setLocale("ko");
    expect(getLocale()).toBe("ko");
    expect(t("status.completed")).toBe("완료");
    expect(t("action.retry")).toBe("재시도");
    expect(t("nav.conversations")).toBe("대화");
  });

  it("resolves known translation keys in ja", () => {
    setLocale("ja");
    expect(getLocale()).toBe("ja");
    expect(t("status.completed")).toBe("完了");
    expect(t("action.retry")).toBe("再試行");
    expect(t("nav.conversations")).toBe("会話");
  });
});
