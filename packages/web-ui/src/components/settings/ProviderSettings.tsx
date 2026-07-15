import { useEffect, useState, type MouseEvent } from "react";
import type { RuntimeSettings } from "@aurevoy/shared";
import { t } from "../../i18n";
import { isPopularProvider, ProviderIcon, providerLabel } from "../providerIcons";
import type { SettingsDraft } from "./types";
import { SettingsChoiceGroup } from "./layout";
import {
  catalogFor,
  providerCatalogSummary,
  resolveProviderCatalog,
} from "./providerCatalog";
import { OauthLoginPanel } from "./OauthLoginPanel";

export function ProviderSettings({
  draft,
  settings,
  saving,
  onDraftChange,
  onSaveConnection,
  onRemoveProvider,
  onRefreshSettings,
  onNotice,
}: {
  draft: SettingsDraft;
  settings: RuntimeSettings | null;
  saving: boolean;
  onDraftChange: (draft: SettingsDraft) => void;
  onSaveConnection: (draft: SettingsDraft, options?: { silent?: boolean }) => void | Promise<void>;
  onRemoveProvider: (provider: string) => void;
  onRefreshSettings?: () => void;
  onNotice?: (message: string, tone?: "info" | "success" | "error") => void;
}) {
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [showApiKeyAlt, setShowApiKeyAlt] = useState(false);

  useEffect(() => {
    if (!connectionOpen) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setConnectionOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [connectionOpen]);

  // 编辑中的 draft.provider 可能与当前激活不同
  const editingSlot = settings?.llm.providers?.find((slot) => slot.provider === draft.provider);
  const isEditingActive = !settings || draft.provider === settings.llm.provider;
  const apiKeyConfigured = isEditingActive
    ? Boolean(settings?.llm.apiKeyConfigured)
    : Boolean(editingSlot?.apiKeyConfigured);
  const oauthConfigured = isEditingActive
    ? Boolean(settings?.llm.oauthConfigured)
    : Boolean(editingSlot?.oauthConfigured);
  const configuredProviders = settings?.llm.providers ?? [];
  const connectedIds = new Set(configuredProviders.map((slot) => slot.provider));
  /** 服务端 catalog 优先，缺失时本地回退，保证可连接列表始终可见。 */
  const providerCatalog = resolveProviderCatalog(settings);
  const availableToConnect = providerCatalog.filter((entry) => !connectedIds.has(entry.id));
  const popularToConnect = availableToConnect.filter((entry) => isPopularProvider(entry.id));
  const moreToConnect = availableToConnect.filter((entry) => !isPopularProvider(entry.id));
  const editingCatalog = catalogFor(settings, draft.provider);
  const supportsOauth = Boolean(editingCatalog?.supportsOauth);
  const supportsApiKey = Boolean(
    !editingCatalog || editingCatalog.supportsApiKey || editingCatalog.custom,
  );
  const oauthOnly = supportsOauth && !supportsApiKey;
  const hybridAuth = supportsOauth && supportsApiKey;
  // 混合鉴权：OAuth / API Key 互斥，不同时展示
  const apiKeyMode = hybridAuth
    ? showApiKeyAlt || (apiKeyConfigured && !oauthConfigured)
    : supportsApiKey && !supportsOauth;
  const showOauthPanel = supportsOauth && !apiKeyMode;
  const showApiKeyField = supportsApiKey && (!supportsOauth || apiKeyMode);
  const requiresBaseUrl = Boolean(editingCatalog?.requiresBaseUrl);
  const showBaseUrlField = !oauthOnly || requiresBaseUrl || Boolean(draft.baseUrl);
  const showMaxTokensField = !oauthOnly;
  const baseUrlPlaceholder = editingCatalog?.defaultBaseUrl
    || (requiresBaseUrl ? "https://api.example.com/v1" : "");
  const needsManualSave = showApiKeyField || showBaseUrlField || showMaxTokensField;

  function selectProvider(nextProvider: string): void {
    const slot = settings?.llm.providers?.find((item) => item.provider === nextProvider);
    const isActive = settings?.llm.provider === nextProvider;
    const savedBase = slot?.baseUrl
      ?? (isActive ? (settings?.llm.baseUrl ?? "") : "");
    const nextCatalog = catalogFor(settings, nextProvider);
    const nextSupportsOauth = Boolean(nextCatalog?.supportsOauth);
    const nextSupportsApiKey = Boolean(
      !nextCatalog || nextCatalog.supportsApiKey || nextCatalog.custom,
    );
    const nextApiKeyConfigured = isActive
      ? Boolean(settings?.llm.apiKeyConfigured)
      : Boolean(slot?.apiKeyConfigured);
    const nextOauthConfigured = isActive
      ? Boolean(settings?.llm.oauthConfigured)
      : Boolean(slot?.oauthConfigured);
    // 混合鉴权：仅「有 Key 且无 OAuth」时默认进密钥模式，否则 OAuth
    setShowApiKeyAlt(
      Boolean(
        nextSupportsOauth
        && nextSupportsApiKey
        && nextApiKeyConfigured
        && !nextOauthConfigured,
      ),
    );
    onDraftChange({
      ...draft,
      provider: nextProvider,
      // 有保存值用保存值；否则留空表示用提供商默认端点
      baseUrl: savedBase,
      model: slot?.model
        ?? (isActive ? (settings?.llm.model ?? "") : draft.model),
      apiKey: "",
    });
  }

  function openConnection(nextProvider: string): void {
    selectProvider(nextProvider);
    setConnectionOpen(true);
  }

  function closeConnection(): void {
    setConnectionOpen(false);
  }

  function handleDisconnect(provider: string, event: MouseEvent): void {
    event.stopPropagation();
    if (saving) return;
    const name = providerLabel(provider, catalogFor(settings, provider)?.name);
    if (!confirm(t("settings.disconnectConfirm").replace("{name}", name))) return;
    if (draft.provider === provider) {
      setConnectionOpen(false);
    }
    onRemoveProvider(provider);
  }

  function handleSaveConnection(): void {
    onSaveConnection(draft);
  }

  function handleOauthAuthChanged(event: "login" | "logout"): void {
    if (event === "login") {
      // 登录成功：激活槽位；silent 避免覆盖 OAuth 成功 toast
      void Promise.resolve(onSaveConnection({ ...draft, apiKey: "" }, { silent: true }))
        .then(() => onRefreshSettings?.());
      return;
    }
    // 退出：禁止 silent-save（会把空槽重新标成「已连接」）
    if (oauthOnly) {
      // 纯订阅：退出即断开槽位，离开「已连接」列表
      setConnectionOpen(false);
      onRemoveProvider(draft.provider);
      return;
    }
    onRefreshSettings?.();
  }

  function providerKindLabel(slot: { provider: string; baseUrl: string; apiKeyConfigured: boolean }): string {
    const entry = catalogFor(settings, slot.provider);
    if (entry?.custom || slot.provider === "openai-compatible") {
      return t("settings.providerKindCustom");
    }
    if (entry?.supportsOauth && !entry.supportsApiKey) {
      return t("settings.providerKindOauth");
    }
    if (entry?.supportsOauth) {
      return t("settings.providerKindApiKeyOauth");
    }
    return t("settings.providerKindApiKey");
  }

  function slotModelSummary(slot: {
    provider: string;
    model: string;
    availableModels: string[];
    apiKeyConfigured: boolean;
    oauthConfigured?: boolean;
  }): string {
    const entry = catalogFor(settings, slot.provider);
    const parts: string[] = [];
    parts.push(
      slot.oauthConfigured
        ? t("settings.oauthConfiguredShort")
        : slot.apiKeyConfigured
          ? t("settings.apiKeyConfiguredShort")
          : entry?.supportsOauth && !entry.supportsApiKey
            ? t("settings.oauthNotConnectedShort")
            : t("settings.apiKeyMissingShort"),
    );
    if (slot.availableModels.length > 0) {
      parts.push(
        `${t("settings.modelDescFetchedPrefix")}${slot.availableModels.length}${t("settings.modelListCountSuffix")}`,
      );
    } else if (entry && entry.modelCount > 0) {
      parts.push(
        `${t("settings.catalogModelCountPrefix")}${entry.modelCount}${t("settings.modelListCountSuffix")}`,
      );
    } else {
      parts.push(t("settings.modelEmptyShort"));
    }
    return parts.join(" · ");
  }

  return (
    <>
    <SettingsChoiceGroup title={t("settings.connectedProviders")}>
      {configuredProviders.length === 0 ? (
        <div className="settings-provider-empty">
          <p>{t("settings.connectedProvidersEmpty")}</p>
        </div>
      ) : (
        <div className="settings-provider-sheet" role="list" aria-label={t("settings.connectedProviders")}>
          {configuredProviders.map((slot) => {
            const active = slot.provider === settings?.llm.provider;
            const label = providerLabel(slot.provider, catalogFor(settings, slot.provider)?.name);
            return (
              <div
                key={slot.provider}
                className="settings-provider-line"
                data-active={active}
                role="listitem"
              >
                <button
                  type="button"
                  className="settings-provider-line-main"
                  onClick={() => openConnection(slot.provider)}
                  title={`${slot.provider}${slot.model ? ` · ${slot.model}` : ""}`}
                >
                  <ProviderIcon provider={slot.provider} />
                  <span className="settings-provider-line-text">
                    <span className="settings-provider-line-title">
                      <strong>{label}</strong>
                      <em className="settings-provider-kind">{providerKindLabel(slot)}</em>
                      {active && (
                        <em className="settings-provider-kind" data-kind="active">
                          {t("settings.providerActive")}
                        </em>
                      )}
                    </span>
                    <small>{slotModelSummary(slot)}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className="settings-provider-line-action"
                  disabled={saving}
                  onClick={(event) => handleDisconnect(slot.provider, event)}
                >
                  {t("settings.disconnectProvider")}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </SettingsChoiceGroup>

    {(popularToConnect.length > 0 || moreToConnect.length > 0) && (
      <SettingsChoiceGroup title={t("settings.popularProviders")}>
        <div className="settings-provider-sheet" role="list" aria-label={t("settings.popularProviders")}>
          {[...popularToConnect, ...moreToConnect].map((entry) => (
            <div key={entry.id} className="settings-provider-line" role="listitem">
              <div className="settings-provider-line-main" data-static="true">
                <ProviderIcon provider={entry.id} />
                <span className="settings-provider-line-text">
                  <span className="settings-provider-line-title">
                    <strong>{entry.name}</strong>
                  </span>
                  <small>{providerCatalogSummary(entry)}</small>
                </span>
              </div>
              <button
                type="button"
                className="settings-provider-connect-btn"
                disabled={saving}
                onClick={() => openConnection(entry.id)}
              >
                <span aria-hidden="true">+</span>
                {t("settings.connectProvider")}
              </button>
            </div>
          ))}
        </div>
      </SettingsChoiceGroup>
    )}

    {connectionOpen && (
      <div
        className="settings-modal-backdrop"
        role="presentation"
        onClick={closeConnection}
      >
        <div
          className="settings-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-connection-dialog-title"
          data-auth={oauthOnly ? "oauth" : hybridAuth ? "hybrid" : "apikey"}
          onClick={(event) => event.stopPropagation()}
        >
          <header className="settings-modal-head">
            <div className="settings-modal-title-row">
              <ProviderIcon provider={draft.provider} />
              <div>
                <h2 id="settings-connection-dialog-title">
                  {providerLabel(draft.provider, editingCatalog?.name)}
                </h2>
                <p>
                  {oauthOnly
                    ? t("settings.providerKindOauth")
                    : hybridAuth
                      ? t("settings.providerKindApiKeyOauth")
                      : t("settings.connectionConfig")}
                </p>
              </div>
            </div>
            <button
              type="button"
              className="settings-modal-close"
              onClick={closeConnection}
              aria-label={t("action.close")}
            >
              ×
            </button>
          </header>

          <div className="settings-modal-body">
            {showOauthPanel && (
              <>
                <OauthLoginPanel
                  provider={draft.provider}
                  oauthLabel={editingCatalog?.oauthLabel}
                  oauthConfigured={oauthConfigured}
                  disabled={saving}
                  onNotice={onNotice}
                  onAuthChanged={handleOauthAuthChanged}
                />
                {hybridAuth && (
                  <button
                    type="button"
                    className="settings-link-btn settings-oauth-alt-link"
                    onClick={() => setShowApiKeyAlt(true)}
                  >
                    {t("settings.useApiKeyInstead")}
                  </button>
                )}
              </>
            )}

            {showApiKeyField && (
              <label className="settings-modal-field">
                <span>{editingCatalog?.apiKeyLabel ?? "API Key"}</span>
                <small>
                  {apiKeyConfigured
                    ? t("settings.apiKeyConfigured")
                    : hybridAuth
                      ? t("settings.apiKeyAltHint")
                      : t("settings.apiKeyMissing")}
                </small>
                <input
                  className="settings-modal-input"
                  type="password"
                  value={draft.apiKey}
                  autoFocus={!supportsOauth || apiKeyMode}
                  placeholder={
                    apiKeyConfigured
                      ? t("settings.apiKeyKeepPlaceholder")
                      : t("settings.apiKeyInputPlaceholder")
                  }
                  onChange={(event) => onDraftChange({ ...draft, apiKey: event.currentTarget.value })}
                />
                {hybridAuth && (
                  <button
                    type="button"
                    className="settings-link-btn"
                    onClick={() => {
                      setShowApiKeyAlt(false);
                      onDraftChange({ ...draft, apiKey: "" });
                    }}
                  >
                    {t("settings.backToOauth")}
                  </button>
                )}
              </label>
            )}

            {showBaseUrlField && (
              <label className="settings-modal-field">
                <span>Base URL</span>
                <small>
                  {requiresBaseUrl
                    ? t("settings.baseUrlRequiredDesc")
                    : t("settings.baseUrlOptionalDesc")}
                </small>
                <input
                  className="settings-modal-input"
                  value={draft.baseUrl}
                  placeholder={baseUrlPlaceholder}
                  onChange={(event) => onDraftChange({ ...draft, baseUrl: event.currentTarget.value })}
                />
              </label>
            )}

            {showMaxTokensField && (
              <label className="settings-modal-field">
                <span>{t("settings.maxTokensTitle")}</span>
                <small>{t("settings.maxTokensDesc")}</small>
                <input
                  className="settings-modal-input settings-modal-input-narrow"
                  type="number"
                  min={256}
                  step={256}
                  value={draft.maxTokens}
                  onChange={(event) =>
                    onDraftChange({ ...draft, maxTokens: Number(event.currentTarget.value) })
                  }
                />
              </label>
            )}
          </div>

          <footer className="settings-modal-foot">
            {needsManualSave ? (
              <>
                <button type="button" className="settings-secondary-btn" onClick={closeConnection}>
                  {t("action.cancel")}
                </button>
                <button
                  type="button"
                  className="settings-primary-btn"
                  disabled={saving}
                  onClick={handleSaveConnection}
                >
                  {saving ? t("settings.saving") : t("settings.saveConnectionTitle")}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="settings-primary-btn"
                onClick={closeConnection}
              >
                {t("settings.oauthDone")}
              </button>
            )}
          </footer>
        </div>
      </div>
    )}
    </>
  );
}
