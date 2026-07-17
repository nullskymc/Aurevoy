import type { McpServerStatus } from "@aurevoy/shared";
import { t } from "../../i18n";
import type { SettingsDraft } from "./types";
import { SettingsGroup, SettingsInfoRow } from "./layout";

export function McpSettings({
  draft,
  mcpServers,
  saving,
  onDraftChange,
  onSave,
}: {
  draft: SettingsDraft;
  mcpServers: McpServerStatus[];
  saving: boolean;
  onDraftChange: (draft: SettingsDraft) => void;
  onSave: (draft: SettingsDraft, options?: { silent?: boolean }) => void | Promise<void>;
}) {
  return (
    <>
      <SettingsGroup title={t("settings.mcpServers")}>
        <textarea
          className="settings-textarea"
          rows={9}
          value={draft.mcpServersJson}
          onChange={(event) => onDraftChange({ ...draft, mcpServersJson: event.currentTarget.value })}
        />
        <div className="settings-footer-actions">
          <button
            type="button"
            className="settings-primary-btn"
            disabled={saving}
            onClick={() => void onSave(draft)}
          >
            {saving ? t("settings.saving") : t("settings.saveMcp")}
          </button>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("settings.connectionStatus")}>
        {mcpServers.length === 0 ? (
          <SettingsInfoRow title={t("settings.mcpEmptyTitle")} description={t("settings.mcpEmptyDesc")} />
        ) : (
          mcpServers.map((server) => (
            <SettingsInfoRow
              key={server.name}
              title={server.name}
              description={`tools: ${server.registeredTools}${server.error ? ` / ${server.error}` : ""}`}
              value={server.connected ? t("settings.connected") : server.enabled ? t("settings.failed") : t("settings.disabled")}
            />
          ))
        )}
      </SettingsGroup>
    </>
  );
}
