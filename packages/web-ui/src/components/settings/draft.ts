import type { RuntimeSettings } from "@aurevoy/shared";
import type { SettingsDraft } from "./types";

export function makeDraft(settings: RuntimeSettings | null): SettingsDraft {
  return {
    provider: settings?.llm.provider ?? "openai",
    baseUrl: settings?.llm.baseUrl ?? "",
    model: settings?.llm.model ?? "",
    apiKey: "",
    workspaceDir: settings?.workspaceDir ?? "",
    maxTokens: settings?.llm.maxTokens ?? 8192,
    commandExecutionEnabled: settings?.commandExecutionEnabled ?? false,
    autoModeSafetyEnabled: settings?.autoModeSafetyEnabled ?? true,
    agentToolExecution: settings?.agentToolExecution ?? "parallel",
    mcpServersJson: settings?.mcpServersJson ?? "",
    cleanupPolicyDays: settings?.cleanupPolicyDays ?? 30,
    budgetRunMaxIterations: settings?.budget?.run.maxIterations ?? 120,
    budgetRunMaxToolCalls: settings?.budget?.run.maxToolCalls ?? 300,
    budgetRunMaxWallTimeMin: Math.max(
      1,
      Math.round((settings?.budget?.run.maxWallTimeMs ?? 45 * 60 * 1000) / 60_000),
    ),
    budgetLifetimeMaxIterations: settings?.budget?.lifetime.maxIterations ?? 500,
    budgetLifetimeMaxToolCalls: settings?.budget?.lifetime.maxToolCalls ?? 1500,
    budgetLifetimeMaxWallTimeMin: Math.max(
      1,
      Math.round((settings?.budget?.lifetime.maxWallTimeMs ?? 3 * 60 * 60 * 1000) / 60_000),
    ),
    // 默认复用 LLM 配置（都是 OpenAI 兼容 API）
    embeddingProvider: settings?.embedding?.provider ?? "off",
    embeddingModel: settings?.embedding?.model ?? "nomic-embed-text",
    embeddingBaseUrl: settings?.embedding?.baseUrl || settings?.llm.baseUrl || "",
    embeddingApiKey: "",
    searchProvider: settings?.search?.provider ?? "duckduckgo_lite",
    searchBaseUrl: settings?.search?.baseUrl ?? "",
    searchApiKey: "",
  };
}
