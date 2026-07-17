import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { openOauthAuthUrl } from "./oauthOpenAuthUrl";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../../");

describe("openOauthAuthUrl (shipped OAuth open path)", () => {
  it("uses openExternal only when available (no window.open dual path)", async () => {
    const openExternal = vi.fn(async () => undefined);
    const openWindow = vi.fn();
    const url = "https://auth.openai.com/oauth/authorize?client_id=x&redirect_uri=y";

    const result = await openOauthAuthUrl(openExternal, url, openWindow);

    expect(result).toEqual({ via: "openExternal" });
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(url);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("awaits openExternal and propagates rejection", async () => {
    const openExternal = vi.fn(async () => {
      throw new Error("ForbiddenUrl");
    });
    const openWindow = vi.fn();

    await expect(
      openOauthAuthUrl(openExternal, "https://x.com/i/oauth2/authorize", openWindow),
    ).rejects.toThrow("ForbiddenUrl");
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("propagates sync openExternal throws", async () => {
    const openExternal = vi.fn(() => {
      throw new Error("sync fail");
    });
    const openWindow = vi.fn();

    await expect(
      openOauthAuthUrl(openExternal, "https://claude.ai/oauth/authorize", openWindow),
    ).rejects.toThrow("sync fail");
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("falls back to window.open only when openExternal is missing", async () => {
    const openWindow = vi.fn(() => ({ closed: false }));
    const result = await openOauthAuthUrl(undefined, "https://example.com/oauth", openWindow);
    expect(result).toEqual({ via: "window.open" });
    expect(openWindow).toHaveBeenCalledWith(
      "https://example.com/oauth",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("rejects when window.open is blocked (null return)", async () => {
    const openWindow = vi.fn(() => null);
    await expect(
      openOauthAuthUrl(undefined, "https://example.com/oauth", openWindow),
    ).rejects.toThrow("window.open blocked");
  });
});

describe("OAuth open path wiring (structural)", () => {
  it("OauthLoginPanel awaits openOauthAuthUrl and surfaces open failures", () => {
    const panel = readFileSync(resolve(here, "OauthLoginPanel.tsx"), "utf8");
    expect(panel).toContain('from "./oauthOpenAuthUrl"');
    expect(panel).toContain("await openOauthAuthUrl(platform.openExternal, url)");
    expect(panel).toContain('onNotice?.(message, "error")');
    expect(panel).toMatch(/event\.type === "auth_url"/);
    expect(panel).toMatch(/event\.type === "device_code"/);
    expect(panel).toContain("void openAuthUrl(event.url)");
    expect(panel).toContain("void openAuthUrl(event.verificationUri)");
    expect(panel).toContain("settings.oauthCopyUrl");
  });

  it("desktop adapter opens via @tauri-apps/plugin-opener openUrl", () => {
    const adapter = readFileSync(
      resolve(repoRoot, "apps/desktop/src/platform/tauriPlatformAdapter.ts"),
      "utf8",
    );
    expect(adapter).toContain("async openExternal(url: string)");
    expect(adapter).toContain("await import('@tauri-apps/plugin-opener')");
    expect(adapter).toContain("await openUrl(url)");
  });

  it("desktop main injects tauriPlatformAdapter into PlatformContext", () => {
    const main = readFileSync(resolve(repoRoot, "apps/desktop/src/main.tsx"), "utf8");
    expect(main).toContain("tauriPlatformAdapter");
    expect(main).toContain("PlatformContext.Provider");
  });

  it("Tauri registers opener plugin and allow-open-url for http(s)", () => {
    const lib = readFileSync(resolve(repoRoot, "apps/desktop/src-tauri/src/lib.rs"), "utf8");
    expect(lib).toContain("tauri_plugin_opener::init()");

    const caps = readFileSync(
      resolve(repoRoot, "apps/desktop/src-tauri/capabilities/default.json"),
      "utf8",
    );
    expect(caps).toContain("opener:allow-open-url");
    expect(caps).toContain("https://*");
    expect(caps).toContain("http://*");
  });

  it("agent OAuth only notifies auth events — never opens a browser itself", () => {
    const oauthLogin = readFileSync(
      resolve(repoRoot, "apps/agent/src/llm/oauth-login.ts"),
      "utf8",
    );
    expect(oauthLogin).toContain("notify(event)");
    expect(oauthLogin).toContain("session.events.push(event)");
    expect(oauthLogin).not.toMatch(/openExternal|openUrl|window\.open|child_process|exec\(/);

    const xai = readFileSync(resolve(repoRoot, "apps/agent/src/llm/xai-oauth.ts"), "utf8");
    expect(xai).toContain("type: 'auth_url'");
    expect(xai).toContain("type: 'device_code'");
  });
});
