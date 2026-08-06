import { describe, expect, it } from "vitest";
import {
  buildBrowserManualHandoff,
  classifyBrowserFailure,
  extractSafeBrowserUrl,
} from "./browserRecovery";

describe("browser recovery classification", () => {
  it("classifies missing login state and strips query credentials from the page URL", () => {
    const plan = classifyBrowserFailure(
      "browser_snapshot failed: login required at https://example.com/account?state=secret-token",
      "browser_snapshot",
    );

    expect(plan).toEqual({ kind: "login_required", url: "https://example.com/account" });
  });

  it("distinguishes changed pages, unavailable elements and failed downloads", () => {
    expect(classifyBrowserFailure("page changed after navigation", "browser_snapshot")?.kind).toBe("page_changed");
    expect(classifyBrowserFailure("locator button.submit is not found", "browser_click")?.kind).toBe("element_unavailable");
    expect(classifyBrowserFailure("download failed for report.pdf", "browser_download")?.kind).toBe("download_failed");
  });

  it("does not classify unrelated tool errors as browser failures", () => {
    expect(classifyBrowserFailure("write failed: permission denied", "write")).toBeNull();
    expect(extractSafeBrowserUrl("no URL here")).toBeUndefined();
  });

  it("creates a handoff summary without copying query tokens or secret values", () => {
    const plan = { kind: "login_required" as const, url: "https://example.com/login" };
    const handoff = buildBrowserManualHandoff(
      "login failed at https://example.com/login?token=abc password=cleartext",
      plan,
    );

    expect(handoff).toContain("https://example.com/login");
    expect(handoff).not.toContain("token=abc");
    expect(handoff).not.toContain("password=cleartext");
    expect(handoff).toContain("password=[REDACTED]");
  });
});
