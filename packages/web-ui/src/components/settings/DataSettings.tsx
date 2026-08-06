import { useCallback, useEffect, useState } from "react";
import type {
  DataStatusResponse,
  HealthDiagnosticCheck,
  HealthDiagnosticsResponse,
  RuntimeSettings,
} from "@aurevoy/shared";
import { getHealthDiagnostics } from "../../api";
import { t } from "../../i18n";
import { SettingsActionRow, SettingsGroup, SettingsInfoRow, SettingsNoteRow } from "./layout";
import "./DataSettings.css";

export function DataSettings({
  cleanupDays,
  dataStatus,
  settings,
  onCleanup,
  onExportData,
  onCleanupDaysChange,
}: {
  cleanupDays: number;
  dataStatus: DataStatusResponse | null;
  settings: RuntimeSettings | null;
  onCleanup: (olderThanDays: number) => void | Promise<void>;
  onExportData: (includeTaskMessages: boolean) => void | Promise<void>;
  onCleanupDaysChange: (days: number) => void;
}) {
  const [diagnostics, setDiagnostics] = useState<HealthDiagnosticsResponse | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [includeTaskMessages, setIncludeTaskMessages] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);

  const refreshDiagnostics = useCallback(async () => {
    setDiagnosticsLoading(true);
    setDiagnosticsError(null);
    try {
      setDiagnostics(await getHealthDiagnostics());
    } catch (error) {
      setDiagnosticsError(error instanceof Error ? error.message : String(error));
    } finally {
      setDiagnosticsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshDiagnostics();
  }, [refreshDiagnostics]);

  async function handleExport(): Promise<void> {
    setExporting(true);
    try {
      await onExportData(includeTaskMessages);
    } finally {
      setExporting(false);
    }
  }

  async function handleCleanup(): Promise<void> {
    if (typeof window !== "undefined" && !window.confirm(t("settings.cleanupConfirm"))) return;
    setCleanupBusy(true);
    try {
      await onCleanup(cleanupDays);
      await refreshDiagnostics();
    } finally {
      setCleanupBusy(false);
    }
  }

  const overallStatus = diagnostics
    ? diagnostics.checks.some((check) => check.status === "error")
      ? "error"
      : diagnostics.checks.some((check) => check.status === "warning")
        ? "warning"
        : "ok"
    : "warning";

  return (
    <>
      <SettingsGroup title={t("settings.healthDiagnostics")}>
        <div className="settings-diagnostics-head">
          <div className={`settings-diagnostics-summary settings-diagnostics-${overallStatus}`}>
            <span className="settings-diagnostics-dot" aria-hidden="true" />
            {diagnosticsLoading
              ? t("settings.diagnosticsChecking")
              : diagnosticsError
                ? t("settings.diagnosticsUnavailable")
                : diagnostics
                  ? overallLabel(overallStatus)
                  : t("settings.diagnosticsUnavailable")}
          </div>
          <button type="button" className="settings-secondary-btn" onClick={() => void refreshDiagnostics()} disabled={diagnosticsLoading}>
            {diagnosticsLoading ? t("settings.diagnosticsChecking") : t("settings.refresh")}
          </button>
        </div>
        {diagnosticsError && <p className="settings-diagnostics-error">{diagnosticsError}</p>}
        {diagnostics && (
          <div className="settings-diagnostics-list" role="list" aria-label={t("settings.healthDiagnostics")}>
            {diagnostics.checks.map((check) => <DiagnosticRow key={check.id} check={check} />)}
          </div>
        )}
        {!diagnostics && !diagnosticsError && <SettingsNoteRow title={t("settings.diagnosticsChecking")} description={t("settings.diagnosticsDesc")} />}
        <SettingsNoteRow title={t("settings.diagnosticsDescTitle")} description={t("settings.diagnosticsDesc")} />
      </SettingsGroup>

      <SettingsGroup title={t("settings.localStorage")}>
        <SettingsInfoRow title="SQLite" description={dataStatus?.dbPath ?? settings?.dbPath ?? t("settings.notConnected")} />
        <SettingsInfoRow
          title={t("settings.tasksTracesMemories")}
          description={
            dataStatus
              ? `${dataStatus.counts.tasks} / ${dataStatus.counts.traces} / ${dataStatus.counts.memories} / ${dataStatus.counts.projects}`
              : t("settings.notConnected")
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.dataExport")}>
        <SettingsNoteRow title={t("settings.exportSafeTitle")} description={t("settings.exportSafeDesc")} />
        <SettingsActionRow
          title={t("settings.exportTaskMessagesTitle")}
          description={t("settings.exportTaskMessagesDesc")}
          control={<input type="checkbox" checked={includeTaskMessages} onChange={(event) => setIncludeTaskMessages(event.currentTarget.checked)} />}
        />
        <SettingsActionRow
          title={t("settings.exportTitle")}
          description={t("settings.exportDesc")}
          control={<button type="button" className="settings-secondary-btn" onClick={() => void handleExport()} disabled={exporting}>{exporting ? t("settings.exporting") : t("settings.export")}</button>}
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
                onChange={(event) => onCleanupDaysChange(Math.max(1, Number(event.currentTarget.value) || 1))}
              />
              <button type="button" className="settings-secondary-btn" onClick={() => void handleCleanup()} disabled={cleanupBusy}>
                {cleanupBusy ? t("settings.cleaning") : t("settings.cleanup")}
              </button>
            </div>
          }
        />
        <SettingsNoteRow title={t("settings.cleanupSafetyTitle")} description={t("settings.cleanupSafetyDesc")} />
      </SettingsGroup>
    </>
  );
}

function DiagnosticRow({ check }: { check: HealthDiagnosticCheck }) {
  const label = diagnosticLabel(check);
  const statusLabel = check.status === "ok"
    ? t("settings.diagnosticOk")
    : check.status === "error"
      ? t("settings.diagnosticError")
      : t("settings.diagnosticWarning");
  return (
    <div className="settings-diagnostic-row" role="listitem">
      <span className={`settings-diagnostic-badge settings-diagnostics-${check.status}`}>{statusLabel}</span>
      <span className="settings-diagnostic-copy">
        <strong>{label}</strong>
        <small>{check.summary}</small>
      </span>
    </div>
  );
}

function diagnosticLabel(check: HealthDiagnosticCheck): string {
  switch (check.id) {
    case "llm": return t("settings.diagnosticLlm");
    case "database": return t("settings.diagnosticDatabase");
    case "workspace": return t("settings.diagnosticWorkspace");
    case "embedding": return t("settings.diagnosticEmbedding");
    case "vector_store": return t("settings.diagnosticVectorStore");
    case "knowledge_base": return t("settings.diagnosticKnowledgeBase");
  }
}

function overallLabel(status: "ok" | "warning" | "error"): string {
  if (status === "ok") return t("settings.diagnosticsOverallOk");
  if (status === "error") return t("settings.diagnosticsOverallError");
  return t("settings.diagnosticsOverallWarning");
}
