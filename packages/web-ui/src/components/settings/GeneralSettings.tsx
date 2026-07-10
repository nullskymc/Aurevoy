import { useState } from "react";
import type { DataStatusResponse, RuntimeSettings } from "@aurevoy/shared";
import { t } from "../../i18n";
import { setBaseUrl } from "../../api";
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
  onSave: (draft: SettingsDraft) => void;
  onConnectionChange?: () => void;
}) {
  const [agentUrl, setAgentUrl] = useState<string>(
    typeof window !== "undefined" ? window.localStorage.getItem("aurevoy.agentBaseUrl") ?? "" : ""
  );
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');

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

      <SettingsGroup title={t("settings.general")}>
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
              onClick={() => onSave(draft)}
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
    </>
  );
}
