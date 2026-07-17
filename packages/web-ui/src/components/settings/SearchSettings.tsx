import type { SettingsDraft } from "./types";
import { t } from "../../i18n";
import { SettingsActionRow, SettingsGroup } from "./layout";

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
  return (
    <>
      <SettingsGroup title={t("settings.searchTitle")}>
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
              onClick={() => void onSave(draft)}
            >
              {saving ? t("settings.saving") : t("action.save")}
            </button>
          }
        />
      </SettingsGroup>
    </>
  );
}
