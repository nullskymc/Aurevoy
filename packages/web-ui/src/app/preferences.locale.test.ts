import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectSystemLocale,
  mapLanguageTagToLocale,
} from "../i18n";
import { LOCALE_KEY, readStoredLocale } from "./preferences";

describe("mapLanguageTagToLocale", () => {
  it("maps primary tags and regional variants", () => {
    expect(mapLanguageTagToLocale("zh")).toBe("zh");
    expect(mapLanguageTagToLocale("zh-CN")).toBe("zh");
    expect(mapLanguageTagToLocale("zh-TW")).toBe("zh");
    expect(mapLanguageTagToLocale("zh-Hans-CN")).toBe("zh");
    expect(mapLanguageTagToLocale("ja")).toBe("ja");
    expect(mapLanguageTagToLocale("ja-JP")).toBe("ja");
    expect(mapLanguageTagToLocale("ko")).toBe("ko");
    expect(mapLanguageTagToLocale("ko-KR")).toBe("ko");
    expect(mapLanguageTagToLocale("en")).toBe("en");
    expect(mapLanguageTagToLocale("en-US")).toBe("en");
    expect(mapLanguageTagToLocale("en_GB")).toBe("en");
  });

  it("returns null for unsupported languages", () => {
    expect(mapLanguageTagToLocale("fr")).toBeNull();
    expect(mapLanguageTagToLocale("de-DE")).toBeNull();
    expect(mapLanguageTagToLocale("")).toBeNull();
  });
});

describe("detectSystemLocale", () => {
  it("picks the first supported language in preference order", () => {
    expect(detectSystemLocale(["fr-FR", "zh-CN", "en"])).toBe("zh");
    expect(detectSystemLocale(["ja-JP"])).toBe("ja");
    expect(detectSystemLocale(["ko"])).toBe("ko");
  });

  it("falls back to en when nothing matches", () => {
    expect(detectSystemLocale([])).toBe("en");
    expect(detectSystemLocale(["fr", "de"])).toBe("en");
  });
});

describe("readStoredLocale", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      },
    });
    vi.stubGlobal("navigator", {
      language: "en-US",
      languages: ["en-US"],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefers an explicit stored locale over the system language", () => {
    store.set(LOCALE_KEY, "ja");
    vi.stubGlobal("navigator", {
      language: "zh-CN",
      languages: ["zh-CN"],
    });
    expect(readStoredLocale()).toBe("ja");
  });

  it("detects system language when nothing is stored", () => {
    vi.stubGlobal("navigator", {
      language: "zh-CN",
      languages: ["zh-CN", "en-US"],
    });
    expect(readStoredLocale()).toBe("zh");
  });

  it("ignores invalid stored values and falls back to system detection", () => {
    store.set(LOCALE_KEY, "fr");
    vi.stubGlobal("navigator", {
      language: "ko-KR",
      languages: ["ko-KR"],
    });
    expect(readStoredLocale()).toBe("ko");
  });
});
