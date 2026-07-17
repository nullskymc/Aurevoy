import { useEffect, useState } from "react";
import type { DataStatusResponse, RuntimeSettings } from "@aurevoy/shared";
import type { AppUpdateInfo } from "../../platform/types";
import { usePlatform } from "../../platform/context";
import { t } from "../../i18n";
import { setBaseUrl, testOutboundProxy } from "../../api";
import type { WorkMode } from "../../app/types";
import type { SettingsDraft } from "./types";
import {
  SettingsActionRow,
  SettingsBudgetField,
  SettingsChoiceGroup,
  SettingsGroup,
  SettingsInfoRow,
  SettingsNoteRow,
  SettingsSelectRow,
  SettingsSwitchRow,
} from "./layout";

type UpdateUiState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate"; currentVersion?: string }
  | { kind: "available"; info: AppUpdateInfo }
  | { kind: "downloading"; percent: number | null; version?: string }
  | { kind: "installing"; version?: string }
  | { kind: "error"; message: string };

export function GeneralSettings({
  draft,
  dataStatus,
  settings,
  saving,
  workMode,
  onDraftChange,
  onWorkModeChange,
  onSave,
  onConnectionChange,
}: {
  draft: SettingsDraft;
  dataStatus: DataStatusResponse | null;
  settings: RuntimeSettings | null;
  saving: boolean;
  workMode: WorkMode;
  onDraftChange: (draft: SettingsDraft) => void;
  onWorkModeChange: (mode: WorkMode) => void;
  onSave: (draft: SettingsDraft, options?: { silent?: boolean }) => void | Promise<void>;
  onConnectionChange?: () => void;
}) {
  const platform = usePlatform();
  const [agentUrl, setAgentUrl] = useState<string>(
    typeof window !== "undefined" ? window.localStorage.getItem("aurevoy.agentBaseUrl") ?? "" : ""
  );
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateUiState>({ kind: "idle" });
  const [proxyTestState, setProxyTestState] = useState<
    "idle" | "testing" | "ok" | "fail"
  >("idle");
  const [proxyTestDetail, setProxyTestDetail] = useState<string | null>(null);
  const canCheckUpdate = typeof platform.checkForAppUpdate === "function";

  useEffect(() => {
    let cancelled = false;
    void platform.getAppVersion?.().then((version) => {
      if (!cancelled) setAppVersion(version);
    });
    return () => {
      cancelled = true;
    };
  }, [platform]);

  async function testAndConnect() {
    const url = agentUrl.replace(/\/+$/, '');
    if (!url) return;
    setTestState('testing');
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) {
        setTestState('ok');
        setBaseUrl(url);
        onConnectionChange?.();
      } else {
        setTestState('fail');
      }
    } catch {
      setTestState('fail');
    }
  }

  async function handleTestProxy() {
    setProxyTestState("testing");
    setProxyTestDetail(null);
    try {
      const result = await testOutboundProxy();
      const via =
        result.proxyEnabled && result.viaProxy
          ? ` · via ${result.viaProxy}`
          : result.proxyEnabled === false
            ? " · direct"
            : "";
      if (result.ok) {
        setProxyTestState("ok");
        setProxyTestDetail(
          t("settings.proxyTestOk")
            .replace("{ms}", String(result.latencyMs))
            .replace("{status}", String(result.status ?? "")) + via,
        );
      } else {
        setProxyTestState("fail");
        setProxyTestDetail((result.error || t("settings.proxyTestFail")) + via);
      }
    } catch (err) {
      setProxyTestState("fail");
      setProxyTestDetail(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCheckUpdate() {
    if (!platform.checkForAppUpdate) return;
    setUpdateState({ kind: "checking" });
    try {
      const info = await platform.checkForAppUpdate();
      if (info.currentVersion) setAppVersion(info.currentVersion);
      if (!info.available) {
        setUpdateState({ kind: "upToDate", currentVersion: info.currentVersion });
        return;
      }
      setUpdateState({ kind: "available", info });
    } catch (error) {
      setUpdateState({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function handleInstallUpdate() {
    if (!platform.installAppUpdate) return;
    const version =
      updateState.kind === "available" ? updateState.info.version : undefined;
    setUpdateState({ kind: "downloading", percent: null, version });
    try {
      await platform.installAppUpdate({
        relaunch: true,
        onProgress: (progress) => {
          if (progress.event === "Started" || progress.event === "Progress") {
            const total = progress.contentLength ?? null;
            const downloaded = progress.downloaded ?? 0;
            const percent =
              total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
            setUpdateState({ kind: "downloading", percent, version });
          } else if (progress.event === "Finished") {
            setUpdateState({ kind: "installing", version });
          }
        },
      });
    } catch (error) {
      setUpdateState({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function updateStatusText(): string {
    switch (updateState.kind) {
      case "checking":
        return t("settings.updateChecking");
      case "upToDate":
        return t("settings.updateUpToDate");
      case "available":
        return t("settings.updateAvailable").replace("{version}", updateState.info.version ?? "");
      case "downloading":
        return updateState.percent == null
          ? t("settings.updateDownloading")
          : t("settings.updateDownloadingPercent").replace("{percent}", String(updateState.percent));
      case "installing":
        return t("settings.updateInstalling");
      case "error":
        return updateState.message || t("settings.updateFailed");
      default:
        return t("settings.updateHint");
    }
  }

  const busy =
    updateState.kind === "checking" ||
    updateState.kind === "downloading" ||
    updateState.kind === "installing";

  return (
    <>
      <SettingsChoiceGroup title={t("settings.workMode")}>
        <div className="settings-card-choice-grid">
          <label className="settings-choice-card" data-active={workMode === "coding"}>
            <span>
              <strong>{t("settings.workModeCodingTitle")}</strong>
              <small>{t("settings.workModeCodingDesc")}</small>
            </span>
            <input
              type="radio"
              name="work-mode"
              checked={workMode === "coding"}
              onChange={() => onWorkModeChange("coding")}
            />
          </label>
          <label className="settings-choice-card" data-active={workMode === "daily"}>
            <span>
              <strong>{t("settings.workModeDailyTitle")}</strong>
              <small>{t("settings.workModeDailyDesc")}</small>
            </span>
            <input
              type="radio"
              name="work-mode"
              checked={workMode === "daily"}
              onChange={() => onWorkModeChange("daily")}
            />
          </label>
        </div>
      </SettingsChoiceGroup>

      <SettingsGroup title={t("settings.permissions")}>
        <SettingsSwitchRow
          title={t("settings.commandExecTitle")}
          description={t("settings.commandExecDesc")}
          checked={draft.commandExecutionEnabled}
          onChange={(checked) => onDraftChange({ ...draft, commandExecutionEnabled: checked })}
        />
        <SettingsSwitchRow
          title={t("settings.autoModeSafetyTitle")}
          description={t("settings.autoModeSafetyDesc")}
          checked={draft.autoModeSafetyEnabled}
          onChange={(checked) => onDraftChange({ ...draft, autoModeSafetyEnabled: checked })}
        />
        <SettingsActionRow
          title={t("settings.workspaceTitle")}
          description={t("settings.workspaceDesc")}
          control={
            <input
              className="settings-inline-input"
              value={draft.workspaceDir}
              onChange={(event) => onDraftChange({ ...draft, workspaceDir: event.currentTarget.value })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.agentRuntime")}>
        <SettingsSelectRow
          title={t("settings.toolExecutionTitle")}
          description={t("settings.toolExecutionDesc")}
          value={draft.agentToolExecution}
          options={[
            { value: "parallel", label: t("settings.toolExecutionParallel") },
            { value: "sequential", label: t("settings.toolExecutionSequential") },
          ]}
          onChange={(value) => onDraftChange({ ...draft, agentToolExecution: value })}
        />
        <SettingsNoteRow title={t("settings.thinkingLevelTitle")} description={t("settings.thinkingLevelMovedHint")} />
      </SettingsGroup>

      <SettingsGroup title={t("settings.taskBudget")}>
        <SettingsNoteRow title={t("settings.taskBudget")} description={t("settings.taskBudgetHint")} />
        <div className="settings-budget-block">
          <div className="settings-budget-block-head">
            <strong>{t("settings.budgetRunSection")}</strong>
            <small>{t("settings.budgetRunSectionDesc")}</small>
          </div>
          <div className="settings-budget-grid">
            <SettingsBudgetField
              label={t("settings.budgetRunIterations")}
              hint={t("settings.budgetUnitTurns")}
              value={draft.budgetRunMaxIterations}
              onChange={(value) => onDraftChange({ ...draft, budgetRunMaxIterations: value })}
            />
            <SettingsBudgetField
              label={t("settings.budgetRunToolCalls")}
              hint={t("settings.budgetUnitCalls")}
              value={draft.budgetRunMaxToolCalls}
              onChange={(value) => onDraftChange({ ...draft, budgetRunMaxToolCalls: value })}
            />
            <SettingsBudgetField
              label={t("settings.budgetRunWallMin")}
              hint={t("settings.budgetUnitMinutes")}
              value={draft.budgetRunMaxWallTimeMin}
              onChange={(value) => onDraftChange({ ...draft, budgetRunMaxWallTimeMin: value })}
            />
          </div>
        </div>
        <div className="settings-budget-block is-last">
          <div className="settings-budget-block-head">
            <strong>{t("settings.budgetLifetimeSection")}</strong>
            <small>{t("settings.budgetLifetimeSectionDesc")}</small>
          </div>
          <div className="settings-budget-grid">
            <SettingsBudgetField
              label={t("settings.budgetLifetimeIterations")}
              hint={t("settings.budgetUnitTurns")}
              value={draft.budgetLifetimeMaxIterations}
              onChange={(value) => onDraftChange({ ...draft, budgetLifetimeMaxIterations: value })}
            />
            <SettingsBudgetField
              label={t("settings.budgetLifetimeToolCalls")}
              hint={t("settings.budgetUnitCalls")}
              value={draft.budgetLifetimeMaxToolCalls}
              onChange={(value) => onDraftChange({ ...draft, budgetLifetimeMaxToolCalls: value })}
            />
            <SettingsBudgetField
              label={t("settings.budgetLifetimeWallMin")}
              hint={t("settings.budgetUnitMinutes")}
              value={draft.budgetLifetimeMaxWallTimeMin}
              onChange={(value) => onDraftChange({ ...draft, budgetLifetimeMaxWallTimeMin: value })}
            />
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("settings.proxyGroup")}>
        <SettingsNoteRow
          title={t("settings.proxyGroup")}
          description={t("settings.proxyGroupDesc")}
        />
        <SettingsSwitchRow
          title={t("settings.proxyEnabledTitle")}
          description={t("settings.proxyEnabledDesc")}
          checked={draft.proxyEnabled}
          onChange={(checked) => onDraftChange({ ...draft, proxyEnabled: checked })}
        />
        <SettingsActionRow
          title={t("settings.proxyUrlTitle")}
          description={t("settings.proxyUrlDesc")}
          control={
            <input
              className="settings-inline-input"
              placeholder="http://127.0.0.1:7890"
              value={draft.proxyUrl}
              onChange={(event) =>
                onDraftChange({ ...draft, proxyUrl: event.currentTarget.value })
              }
            />
          }
        />
        <SettingsActionRow
          title={t("settings.proxyNoProxyTitle")}
          description={t("settings.proxyNoProxyDesc")}
          control={
            <input
              className="settings-inline-input"
              placeholder="127.0.0.1,localhost,::1"
              value={draft.proxyNoProxy}
              onChange={(event) =>
                onDraftChange({ ...draft, proxyNoProxy: event.currentTarget.value })
              }
            />
          }
        />
        <SettingsActionRow
          title={t("settings.proxyTestTitle")}
          description={
            proxyTestDetail
              ?? (proxyTestState === "testing"
                ? t("settings.proxyTestRunning")
                : t("settings.proxyTestDesc"))
          }
          control={
            <button
              type="button"
              className="settings-secondary-btn"
              disabled={proxyTestState === "testing" || saving}
              onClick={() => void handleTestProxy()}
            >
              {proxyTestState === "testing"
                ? t("settings.proxyTestRunning")
                : t("settings.proxyTestButton")}
            </button>
          }
        />
        {proxyTestState === "ok" && proxyTestDetail && (
          <SettingsNoteRow title={t("settings.proxyTestSuccessTitle")} description={proxyTestDetail} />
        )}
        {proxyTestState === "fail" && proxyTestDetail && (
          <SettingsNoteRow title={t("settings.proxyTestFailTitle")} description={proxyTestDetail} />
        )}
      </SettingsGroup>

      <SettingsGroup title={t("settings.general")}>
        <SettingsSelectRow
          title={t("settings.logLevelTitle")}
          description={t("settings.logLevelDesc")}
          value={draft.logLevel}
          options={[
            { value: "debug", label: t("settings.logLevelDebug") },
            { value: "info", label: t("settings.logLevelInfo") },
            { value: "warn", label: t("settings.logLevelWarn") },
            { value: "error", label: t("settings.logLevelError") },
          ]}
          onChange={(value) => onDraftChange({ ...draft, logLevel: value })}
        />
        <SettingsInfoRow
          title={t("settings.logFileTitle")}
          description={settings?.logging?.logFile ?? t("settings.notConnected")}
        />
        <SettingsSelectRow
          title={t("settings.cleanupPolicyTitle")}
          description={t("settings.cleanupPolicyDesc")}
          value={String(draft.cleanupPolicyDays)}
          options={[
            { value: "7", label: `7 ${t("settings.unitDays")}` },
            { value: "30", label: `30 ${t("settings.unitDays")}` },
            { value: "90", label: `90 ${t("settings.unitDays")}` },
            { value: "365", label: `365 ${t("settings.unitDays")}` },
          ]}
          onChange={(value) => onDraftChange({ ...draft, cleanupPolicyDays: Number(value) })}
        />
        <SettingsInfoRow
          title={t("settings.localDb")}
          description={dataStatus?.dbPath ?? settings?.dbPath ?? t("settings.notConnected")}
        />
        <SettingsActionRow
          title={t("settings.saveRuntimeTitle")}
          description={t("settings.saveRuntimeDesc")}
          control={
            <button
              type="button"
              className="settings-primary-btn"
              disabled={saving}
              onClick={() => void onSave(draft)}
            >
              {saving ? t("settings.saving") : t("settings.saveSettings")}
            </button>
          }
        />
        <SettingsActionRow
          title={t("settings.agentServerUrl")}
          description={t("settings.agentServerUrlDesc")}
          control={
            <div className="settings-inline-row">
              <input
                className="settings-inline-input"
                type="url"
                placeholder={t("settings.agentServerUrlPlaceholder")}
                value={agentUrl}
                onChange={(e) => { setAgentUrl(e.currentTarget.value); setTestState('idle'); }}
              />
              <button
                type="button"
                className="settings-inline-btn"
                disabled={!agentUrl.trim() || testState === 'testing'}
                onClick={testAndConnect}
              >
                {testState === 'testing'
                  ? t("settings.testing")
                  : testState === 'ok'
                    ? t("settings.connectionSuccess")
                    : testState === 'fail'
                      ? t("settings.connectionFailed")
                      : t("settings.testConnection")}
              </button>
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.about")}>
        <SettingsInfoRow
          title={t("settings.appVersion")}
          description={appVersion ? `v${appVersion}` : t("settings.appVersionUnknown")}
        />
        {canCheckUpdate ? (
          <>
            <SettingsActionRow
              title={t("settings.updateTitle")}
              description={updateStatusText()}
              control={
                <div className="settings-inline-row">
                  <button
                    type="button"
                    className="settings-inline-btn"
                    disabled={busy}
                    onClick={() => void handleCheckUpdate()}
                  >
                    {updateState.kind === "checking"
                      ? t("settings.updateChecking")
                      : t("settings.checkForUpdates")}
                  </button>
                  {updateState.kind === "available" && (
                    <button
                      type="button"
                      className="settings-primary-btn"
                      disabled={busy}
                      onClick={() => void handleInstallUpdate()}
                    >
                      {t("settings.installUpdate")}
                    </button>
                  )}
                </div>
              }
            />
            {updateState.kind === "available" && updateState.info.notes ? (
              <SettingsNoteRow
                title={t("settings.updateNotes")}
                description={updateState.info.notes}
              />
            ) : null}
            {updateState.kind === "error" ? (
              <SettingsNoteRow title={t("settings.updateFailed")} description={updateState.message} />
            ) : null}
          </>
        ) : (
          <SettingsNoteRow
            title={t("settings.updateTitle")}
            description={t("settings.updateDesktopOnly")}
          />
        )}
      </SettingsGroup>
    </>
  );
}
