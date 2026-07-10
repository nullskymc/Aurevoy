import type { DataStatusResponse, RuntimeSettings } from "@aurevoy/shared";
import { t } from "../../i18n";
import { SettingsActionRow, SettingsGroup, SettingsInfoRow } from "./layout";

export function DataSettings({
  cleanupDays,
  dataStatus,
  settings,
  onCleanup,
  onCleanupDaysChange,
}: {
  cleanupDays: number;
  dataStatus: DataStatusResponse | null;
  settings: RuntimeSettings | null;
  onCleanup: (olderThanDays: number) => void;
  onCleanupDaysChange: (days: number) => void;
}) {
  return (
    <>
      <SettingsGroup title={t("settings.localStorage")}>
        <SettingsInfoRow title="SQLite" description={dataStatus?.dbPath ?? settings?.dbPath ?? t("settings.notConnected")} />
        <SettingsInfoRow
          title={t("settings.tasksTracesMemories")}
          description={
            dataStatus
              ? `${dataStatus.counts.tasks} / ${dataStatus.counts.traces} / ${dataStatus.counts.memories}`
              : t("settings.notConnected")
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.dataCleanup")}>
        <SettingsActionRow
          title={t("settings.cleanupTitle")}
          description={t("settings.cleanupDesc")}
          control={
            <div className="settings-cleanup-control">
              <input
                className="settings-number-input"
                type="number"
                min={1}
                max={3650}
                value={cleanupDays}
                onChange={(event) => onCleanupDaysChange(Number(event.currentTarget.value))}
              />
              <button type="button" className="settings-secondary-btn" onClick={() => onCleanup(cleanupDays)}>
                {t("settings.cleanup")}
              </button>
            </div>
          }
        />
      </SettingsGroup>
    </>
  );
}
