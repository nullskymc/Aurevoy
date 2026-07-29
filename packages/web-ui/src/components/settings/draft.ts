import type { RuntimeSettings } from "@aurevoy/shared";
import type { SettingsDraft } from "./types";

const DEFAULT_NO_PROXY = "127.0.0.1,localhost,::1";

/**
 * 从服务端 RuntimeSettings 构建表单草稿。
 * @param previous 可选：当服务端响应缺少较新字段（如 proxy）时，保留本地草稿，避免「保存后被清空」。
 */
export function makeDraft(
  settings: RuntimeSettings | null,
  previous?: SettingsDraft | null,
): SettingsDraft {
  // 旧 Agent 进程可能不返回 proxy；此时绝不能用 ?? "" 抹掉用户刚输入的地址
  const proxyFromServer = settings != null && "proxy" in settings && settings.proxy != null;

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
    memoryRecallEnabled: settings?.memoryRecallEnabled ?? false,
    kbRecallEnabled: settings?.kbRecallEnabled ?? false,
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
    embeddingProvider: settings?.embedding?.provider ?? "off",
    embeddingModel: settings?.embedding?.model ?? "nomic-embed-text",
    embeddingBaseUrl: settings?.embedding?.baseUrl || settings?.llm.baseUrl || "",
    embeddingApiKey: "",
    searchPreferNative: settings?.search?.preferNative ?? false,
    searchProvider: settings?.search?.provider ?? "duckduckgo_lite",
    searchBaseUrl: settings?.search?.baseUrl ?? "",
    searchApiKey: "",
    logLevel: settings?.logging?.level ?? "info",
    proxyEnabled: proxyFromServer
      ? Boolean(settings!.proxy!.enabled)
      : (previous?.proxyEnabled ?? false),
    proxyUrl: proxyFromServer
      ? (settings!.proxy!.url ?? "")
      : (previous?.proxyUrl ?? ""),
    proxyNoProxy: proxyFromServer
      ? (settings!.proxy!.noProxy || DEFAULT_NO_PROXY)
      : (previous?.proxyNoProxy ?? DEFAULT_NO_PROXY),
  };
}

/** 服务端是否支持出站代理配置（响应含 proxy 字段）。 */
export function settingsSupportsProxy(settings: RuntimeSettings | null | undefined): boolean {
  return Boolean(settings && typeof settings === "object" && "proxy" in settings && settings.proxy != null);
}
