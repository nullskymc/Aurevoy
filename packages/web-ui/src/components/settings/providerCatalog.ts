import type { PiProviderCatalogEntry, RuntimeSettings } from "@aurevoy/shared";
import { t } from "../../i18n";
import { PI_PROVIDER_OPTIONS } from "../providerIcons";

/** 本地回退目录：服务端未下发 catalog 时保证可连接列表可见 */
const OAUTH_ONLY = new Set(["openai-codex"]);
const OAUTH_CAPABLE = new Set(["anthropic", "openai-codex", "github-copilot"]);

const FALLBACK_PROVIDER_CATALOG: PiProviderCatalogEntry[] = PI_PROVIDER_OPTIONS.map((item) => ({
  id: item.value,
  name: item.label,
  defaultBaseUrl: "",
  apis: [],
  supportsApiKey: !OAUTH_ONLY.has(item.value),
  apiKeyLabel: "API key",
  supportsOauth: OAUTH_CAPABLE.has(item.value),
  oauthLabel:
    item.value === "anthropic"
      ? "Anthropic (Claude Pro/Max)"
      : item.value === "openai-codex"
        ? "OpenAI (ChatGPT Plus/Pro)"
        : item.value === "github-copilot"
          ? "GitHub Copilot"
          : undefined,
  modelCount: 0,
  requiresBaseUrl: item.value === "openai-compatible",
  custom: item.value === "openai-compatible",
}));

/** 服务端 catalog 优先；缺失或空数组时用本地回退 */
export function resolveProviderCatalog(
  settings: RuntimeSettings | null | undefined,
): PiProviderCatalogEntry[] {
  const remote = settings?.llm.providerCatalog;
  if (Array.isArray(remote) && remote.length > 0) return remote;
  return FALLBACK_PROVIDER_CATALOG;
}

export function catalogFor(
  settings: RuntimeSettings | null | undefined,
  providerId: string,
): PiProviderCatalogEntry | undefined {
  return resolveProviderCatalog(settings).find((entry) => entry.id === providerId);
}

/** 连接列表副文案：鉴权形态 + 模型数，不暴露内部协议细节 */
export function providerCatalogSummary(entry: PiProviderCatalogEntry | undefined): string {
  if (!entry) return t("settings.providerDesc.generic");
  const parts: string[] = [];
  if (entry.supportsOauth && entry.oauthLabel) {
    parts.push(entry.oauthLabel);
  } else if (entry.supportsApiKey) {
    parts.push(t("settings.providerKindApiKey"));
  }
  if (entry.modelCount > 0) {
    parts.push(`${entry.modelCount}${t("settings.modelListCountSuffix")}`);
  }
  return parts.join(" · ") || t("settings.providerDesc.generic");
}
