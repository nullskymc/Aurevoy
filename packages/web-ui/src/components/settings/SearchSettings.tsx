import { useState } from "react";
import type { SettingsDraft } from "./types";
import { t } from "../../i18n";
import { SettingsActionRow, SettingsGroup, SettingsSwitchRow } from "./layout";

export function SearchSettings({
  draft,
  saving,
  onDraftChange,
  onSave,
}: {
  draft: SettingsDraft;
  saving: boolean;
  onDraftChange: (draft: SettingsDraft) => void;
  onSave: (draft: SettingsDraft, options?: { silent?: boolean }) => void | Promise<void>;
}) {
  const [saveError, setSaveError] = useState<string | null>(null);

  /** 搜索配置保存失败时留在当前设置项，并消费异步异常。 */
  async function handleSave(): Promise<void> {
    setSaveError(null);
    try {
      await Promise.resolve(onSave(draft));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setSaveError(`${t("notice.saveSettingsFailed")}${detail}`);
    }
  }

  return (
    <>
      <SettingsGroup title={t("settings.searchTitle")}>
        <SettingsSwitchRow
          title={t("settings.preferNativeSearchTitle")}
          description={t("settings.preferNativeSearchDesc")}
          checked={draft.searchPreferNative}
          onChange={(checked) => onDraftChange({ ...draft, searchPreferNative: checked })}
        />
        <SettingsActionRow
          title={t("settings.searchProviderTitle")}
          description={t("settings.searchProviderDesc")}
          control={
            <select
              className="settings-inline-select"
              value={draft.searchProvider}
              onChange={(event) => onDraftChange({ ...draft, searchProvider: event.currentTarget.value })}
            >
              <option value="duckduckgo_lite">{t("settings.searchProviderDdg")}</option>
              <option value="tavily">Tavily</option>
              <option value="searxng">SearXNG</option>
              <option value="custom">{t("settings.searchProviderCustom")}</option>
            </select>
          }
        />
        {draft.searchProvider !== "duckduckgo_lite" && (
          <>
            <SettingsActionRow
              title={t("settings.searchBaseUrlTitle")}
              description={t("settings.searchBaseUrlDesc")}
              control={
                <input
                  className="settings-inline-input"
                  value={draft.searchBaseUrl}
                  placeholder={t("settings.searchBaseUrlPlaceholder")}
                  onChange={(event) => onDraftChange({ ...draft, searchBaseUrl: event.currentTarget.value })}
                />
              }
            />
            <SettingsActionRow
              title={t("settings.searchApiKeyTitle")}
              description={t("settings.searchApiKeyDesc")}
              control={
                <input
                  className="settings-inline-input"
                  type="password"
                  value={draft.searchApiKey}
                  placeholder={t("settings.apiKeyKeepPlaceholder")}
                  onChange={(event) => onDraftChange({ ...draft, searchApiKey: event.currentTarget.value })}
                />
              }
            />
          </>
        )}
        <SettingsActionRow
          title={t("settings.saveProviderTitle")}
          description={t("settings.saveProviderDesc")}
          control={
            <button
              type="button"
              className="settings-primary-btn"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              {saving ? t("settings.saving") : t("action.save")}
            </button>
          }
        />
        {saveError && <p className="settings-action-error" role="alert">{saveError}</p>}
      </SettingsGroup>
    </>
  );
}
