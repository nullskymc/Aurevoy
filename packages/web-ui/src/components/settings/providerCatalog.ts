import type { PiProviderCatalogEntry, RuntimeSettings } from "@aurevoy/shared";
import { t } from "../../i18n";
import { PI_PROVIDER_OPTIONS } from "../providerIcons";

/** 本地回退目录：服务端未下发 catalog 时保证可连接列表可见 */
const OAUTH_ONLY = new Set(["openai-codex"]);
const OAUTH_CAPABLE = new Set(["anthropic", "openai-codex", "github-copilot", "xai"]);

/** Aurevoy 侧扩展的 OAuth（Pi 内置未声明时仍要在 UI 露出） */
const AUREVOY_OAUTH_OVERLAY: Record<string, { oauthLabel: string }> = {
  xai: { oauthLabel: "xAI (SuperGrok / X Premium+)" },
};

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
          : AUREVOY_OAUTH_OVERLAY[item.value]?.oauthLabel,
  modelCount: 0,
  requiresBaseUrl: item.value === "openai-compatible",
  custom: item.value === "openai-compatible",
}));

/** 把 Aurevoy 扩展 OAuth 叠到服务端 catalog 上（旧 agent / Pi 未声明时仍可登录） */
function applyOauthOverlay(entries: PiProviderCatalogEntry[]): PiProviderCatalogEntry[] {
  return entries.map((entry) => {
    const overlay = AUREVOY_OAUTH_OVERLAY[entry.id];
    if (!overlay) return entry;
    if (entry.supportsOauth && entry.oauthLabel) return entry;
    return {
      ...entry,
      supportsOauth: true,
      oauthLabel: entry.oauthLabel || overlay.oauthLabel,
    };
  });
}

/** 服务端 catalog 优先；缺失或空数组时用本地回退；再叠 Aurevoy OAuth 扩展 */
export function resolveProviderCatalog(
  settings: RuntimeSettings | null | undefined,
): PiProviderCatalogEntry[] {
  const remote = settings?.llm.providerCatalog;
  const base =
    Array.isArray(remote) && remote.length > 0
      ? remote
      : FALLBACK_PROVIDER_CATALOG;
  return applyOauthOverlay(base);
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
  if (entry.supportsOauth && !entry.supportsApiKey) {
    parts.push(entry.oauthLabel || t("settings.providerKindOauth"));
  } else if (entry.supportsOauth && entry.supportsApiKey) {
    parts.push(entry.oauthLabel || t("settings.providerKindApiKeyOauth"));
  } else if (entry.supportsApiKey) {
    parts.push(t("settings.providerKindApiKey"));
  }
  if (entry.modelCount > 0) {
    parts.push(`${entry.modelCount}${t("settings.modelListCountSuffix")}`);
  }
  return parts.join(" · ") || t("settings.providerDesc.generic");
}
