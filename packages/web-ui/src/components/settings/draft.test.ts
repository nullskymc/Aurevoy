import { describe, expect, it } from "vitest";
import type { RuntimeSettings } from "@aurevoy/shared";
import { makeDraft, settingsSupportsProxy } from "./draft";
import type { SettingsDraft } from "./types";

function baseSettings(overrides: Partial<RuntimeSettings> = {}): RuntimeSettings {
  return {
    llm: {
      provider: "openai",
      baseUrl: "",
      model: "gpt",
      availableModels: [],
      enabledModels: [],
      imageInputModels: [],
      temperature: 0.7,
      timeoutMs: 120_000,
      maxTokens: 8192,
      apiKeyConfigured: false,
      oauthConfigured: false,
      providers: [],
      providerCatalog: [],
    },
    workspaceDir: "/w",
    commandExecutionEnabled: false,
    mcpServersJson: "[]",
    cleanupPolicyDays: 30,
    autoModeLevel: "auto",
    autoModeSafetyEnabled: true,
    agentThinkingLevel: "off",
    agentToolExecution: "parallel",
    agentCacheRetention: "long",
    budget: {
      run: { maxIterations: 120, maxToolCalls: 300, maxWallTimeMs: 1, maxOutputBytes: 1 },
      lifetime: { maxIterations: 500, maxToolCalls: 1500, maxWallTimeMs: 1, maxOutputBytes: 1 },
    },
    dbPath: "/db",
    embedding: { provider: "off", model: "", baseUrl: "", apiKeyConfigured: false },
    pythonPath: "",
    search: {
      preferNative: false,
      provider: "duckduckgo_lite",
      baseUrl: "",
      apiKeyConfigured: false,
    },
    logging: { level: "info", logFile: "/log" },
    proxy: { enabled: false, url: "", noProxy: "localhost" },
    agentAutoCompact: true,
    autoResumeInterruptedTasks: true,
    memoryRecallEnabled: false,
    kbRecallEnabled: false,
    ...overrides,
  };
}

describe("makeDraft proxy handling", () => {
  it("loads proxy from server when present", () => {
    const draft = makeDraft(
      baseSettings({
        proxy: { enabled: true, url: "http://127.0.0.1:7890", noProxy: "localhost" },
      }),
    );
    expect(draft.proxyEnabled).toBe(true);
    expect(draft.proxyUrl).toBe("http://127.0.0.1:7890");
  });

  it("preserves local proxy when server omits proxy field (stale agent)", () => {
    const previous = makeDraft(baseSettings());
    previous.proxyEnabled = true;
    previous.proxyUrl = "http://127.0.0.1:7890";

    const stale = baseSettings();
    // Simulate old agent JSON without proxy key
    const { proxy: _drop, ...withoutProxy } = stale as RuntimeSettings & { proxy?: unknown };
    const draft = makeDraft(withoutProxy as RuntimeSettings, previous as SettingsDraft);

    expect(settingsSupportsProxy(withoutProxy as RuntimeSettings)).toBe(false);
    expect(draft.proxyUrl).toBe("http://127.0.0.1:7890");
    expect(draft.proxyEnabled).toBe(true);
  });

  it("allows clearing proxy when server explicitly returns empty url", () => {
    const previous = makeDraft(baseSettings());
    previous.proxyUrl = "http://127.0.0.1:7890";
    const draft = makeDraft(
      baseSettings({ proxy: { enabled: false, url: "", noProxy: "localhost" } }),
      previous,
    );
    expect(draft.proxyUrl).toBe("");
    expect(draft.proxyEnabled).toBe(false);
  });
});
