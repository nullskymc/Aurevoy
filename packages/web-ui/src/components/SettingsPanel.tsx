import { useEffect, useMemo, useState, type MouseEvent } from "react";
import type {
  DataStatusResponse,
  McpServerStatus,
  MemoryCategory,
  MemoryEntry,
  RuntimeSettings,
  TokenUsageReport,
} from "@aurevoy/shared";
import { filterChatModelIds, isChatModelId } from "@aurevoy/shared";
import { t, type Locale, type TranslationKey } from "../i18n";
import { getTokenUsageReport, setBaseUrl } from "../api";
import {
  PI_PROVIDER_OPTIONS,
  ProviderIcon,
  providerLabel,
} from "./providerIcons";
import "./SettingsPanel.css";

interface KbDir {
  id: string;
  dirPath: string;
  recursive: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface KbIndexStatus {
  totalFiles: number;
  totalChunks: number;
  lastIndexed: string | null;
}

interface SettingsDraft {
  provider: string;
  baseUrl: string;
  model: string;
  visionModel: string;
  apiKey: string;
  workspaceDir: string;
  /** Pi harness 仍读取 maxTokens；temperature/timeout 已不再驱动主循环，故不暴露 UI */
  maxTokens: number;
  commandExecutionEnabled: boolean;
  autoModeSafetyEnabled: boolean;
  agentToolExecution: string;
  mcpServersJson: string;
  cleanupPolicyDays: number;
  /** 新建任务默认：单次执行 / 任务寿命预算 */
  budgetRunMaxIterations: number;
  budgetRunMaxToolCalls: number;
  budgetRunMaxWallTimeMin: number;
  budgetLifetimeMaxIterations: number;
  budgetLifetimeMaxToolCalls: number;
  budgetLifetimeMaxWallTimeMin: number;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  searchProvider: string;
  searchBaseUrl: string;
  searchApiKey: string;
}

interface SettingsPanelProps {
  settings: RuntimeSettings | null;
  mcpServers: McpServerStatus[];
  dataStatus: DataStatusResponse | null;
  memories: MemoryEntry[];
  saving: boolean;
  fetchingModels: boolean;
  chatFontSize: number;
  uiFontSize: number;
  codeFontSize: number;
  workMode: WorkMode;
  themeMode: ThemeMode;
  locale: Locale;
  initialSection?: SettingsSectionId;
  onClose: () => void;
  onSave: (draft: SettingsDraft) => void;
  /** Provider 连接专用：只保存 key / baseUrl / maxTokens */
  onSaveConnection: (draft: SettingsDraft) => void;
  onCleanup: (olderThanDays: number) => void;
  onRefresh: () => void;
  onFetchModels: () => void;
  onFetchModelsForProvider: (provider: string) => void;
  onSaveEnabledModels: (models: string[]) => void;
  onSaveSlotEnabledModels: (provider: string, models: string[]) => void;
  /** 点击模型名：切换并保存当前主模型 */
  onSelectModel: (provider: string, model: string) => void;
  onSaveVisionModel: (visionModel: string) => void;
  onRemoveProvider: (provider: string) => void;
  onChatFontSizeChange: (size: number) => void;
  onUiFontSizeChange: (size: number) => void;
  onCodeFontSizeChange: (size: number) => void;
  onWorkModeChange: (mode: WorkMode) => void;
  onThemeModeChange: (mode: ThemeMode) => void;
  onLocaleChange: (locale: Locale) => void;
  onCreateMemory: (content: string, category: MemoryCategory) => void;
  onToggleMemory: (id: string, enabled: boolean) => void;
  onEditMemory: (id: string, content: string, category: MemoryCategory) => void;
  onDeleteMemory: (id: string) => void;
  onConnectionChange?: () => void;
}

type SettingsSectionId =
  | "general"
  | "appearance"
  | "provider"
  | "models"
  | "mcp"
  | "data"
  | "memory"
  | "kb"
  | "search"
  | "usage";
type ThemeMode = "system" | "light" | "dark";
type WorkMode = "coding" | "daily";
const SETTINGS_SECTION_IDS: SettingsSectionId[] = [
  "general",
  "appearance",
  "provider",
  "models",
  "mcp",
  "data",
  "memory",
  "kb",
  "search",
  "usage",
];

/** 每次调用都会重新计算 t()，确保语言切换后侧边栏标签即时更新 */
function getSettingsGroups(): Array<{
  label: string;
  items: Array<{ id: SettingsSectionId; label: string; icon: SettingsIconName }>;
}> {
  return [
  {
    label: t("settings.group.personal"),
    items: [
      { id: "general", label: t("settings.nav.general"), icon: "sliders" },
      { id: "appearance", label: t("settings.nav.appearance"), icon: "appearance" },
    ],
  },
  {
    label: t("settings.group.server"),
    items: [
      { id: "provider", label: t("settings.nav.provider"), icon: "spark" },
      { id: "models", label: t("settings.nav.models"), icon: "models" },
      { id: "mcp", label: t("settings.nav.mcp"), icon: "server" },
      { id: "search", label: t("settings.nav.search"), icon: "search" },
    ],
  },
  {
    label: t("settings.group.data"),
    items: [
      { id: "data", label: t("settings.nav.data"), icon: "database" },
      { id: "usage", label: t("settings.nav.usage"), icon: "usage" },
      { id: "kb", label: t("settings.nav.knowledgeBase"), icon: "kb" },
      { id: "memory", label: t("settings.nav.memory"), icon: "memory" },
    ],
  },
];
}

type SettingsIconName =
  | "appearance"
  | "database"
  | "kb"
  | "memory"
  | "models"
  | "search"
  | "server"
  | "sliders"
  | "spark"
  | "usage";

export function SettingsPanel({
  settings,
  mcpServers,
  dataStatus,
  memories,
  saving,
  fetchingModels,
  chatFontSize,
  uiFontSize,
  codeFontSize,
  workMode,
  themeMode,
  locale,
  initialSection = "general",
  onClose,
  onSave,
  onSaveConnection,
  onCleanup,
  onRefresh,
  onFetchModels: _onFetchModels,
  onFetchModelsForProvider,
  onSaveEnabledModels: _onSaveEnabledModels,
  onSaveSlotEnabledModels,
  onSelectModel,
  onSaveVisionModel,
  onRemoveProvider,
  onChatFontSizeChange,
  onUiFontSizeChange,
  onCodeFontSizeChange,
  onWorkModeChange,
  onThemeModeChange,
  onLocaleChange,
  onCreateMemory,
  onToggleMemory,
  onEditMemory,
  onDeleteMemory,
  onConnectionChange,
}: SettingsPanelProps) {
  const safeInitialSection = normalizeSettingsSection(initialSection);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(safeInitialSection);
  const [draft, setDraft] = useState<SettingsDraft>(() => makeDraft(settings));
  const [cleanupDays, setCleanupDays] = useState(settings?.cleanupPolicyDays ?? 30);
  useEffect(() => {
    setDraft(makeDraft(settings));
    setCleanupDays(settings?.cleanupPolicyDays ?? 30);
  }, [settings]);

  useEffect(() => {
    setActiveSection(normalizeSettingsSection(initialSection));
  }, [initialSection]);

  const groups = getSettingsGroups();
  const activeTitle = groups.flatMap((group) => group.items).find(
    (item) => item.id === activeSection,
  )?.label;

  return (
    <section className="settings-workspace" aria-label={t("settings.pageLabel")}>
      <aside className="sidebar settings-nav" aria-label={t("settings.navLabel")}>
        <div className="window-drag-strip window-drag-region" data-tauri-drag-region aria-hidden="true" />
        <div className="sidebar-brand settings-nav-brand">
          <img className="sidebar-brand-logo" src="/aurevoy-wordmark.svg" alt="Aurevoy" />
        </div>

        <button type="button" className="sidebar-action settings-back" onClick={onClose}>
          {t("settings.backToApp")}
        </button>

        <div className="sidebar-scroll settings-nav-scroll">
          {groups.map((group) => (
            <section key={group.label} className="settings-nav-group">
              <p className="sidebar-section-label">{group.label}</p>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="sidebar-action settings-nav-item"
                  data-active={item.id === activeSection}
                  onClick={() => setActiveSection(item.id)}
                >
                  <SettingsNavIcon name={item.icon} />
                  {item.label}
                </button>
              ))}
            </section>
          ))}
        </div>
      </aside>

      <main className="settings-detail">
        <div className="settings-detail-inner">
          <header className="settings-title-row">
            <h1>{activeTitle}</h1>
            <button type="button" className="settings-secondary-btn" onClick={onRefresh}>
              {t("settings.refresh")}
            </button>
          </header>

          {activeSection === "general" && (
            <GeneralSettings
              draft={draft}
              dataStatus={dataStatus}
              settings={settings}
              saving={saving}
              workMode={workMode}
              onDraftChange={setDraft}
              onWorkModeChange={onWorkModeChange}
              onSave={onSave}
              onConnectionChange={onConnectionChange}
            />
          )}

          {activeSection === "appearance" && (
            <AppearanceSettings
              chatFontSize={chatFontSize}
              uiFontSize={uiFontSize}
              codeFontSize={codeFontSize}
              themeMode={themeMode}
              locale={locale}
              onChatFontSizeChange={onChatFontSizeChange}
              onUiFontSizeChange={onUiFontSizeChange}
              onCodeFontSizeChange={onCodeFontSizeChange}
              onThemeModeChange={onThemeModeChange}
              onLocaleChange={onLocaleChange}
            />
          )}

          {activeSection === "provider" && (
            <ProviderSettings
              draft={draft}
              settings={settings}
              saving={saving}
              fetchingModels={fetchingModels}
              onDraftChange={setDraft}
              onSaveConnection={onSaveConnection}
              onFetchModelsForProvider={onFetchModelsForProvider}
              onRemoveProvider={onRemoveProvider}
            />
          )}

          {activeSection === "models" && (
            <ModelsSettings
              settings={settings}
              saving={saving}
              fetchingModels={fetchingModels}
              onFetchModelsForProvider={onFetchModelsForProvider}
              onSaveSlotEnabledModels={onSaveSlotEnabledModels}
              onSelectModel={onSelectModel}
              onSaveVisionModel={onSaveVisionModel}
            />
          )}

          {activeSection === "mcp" && (
            <McpSettings
              draft={draft}
              mcpServers={mcpServers}
              saving={saving}
              onDraftChange={setDraft}
              onSave={onSave}
            />
          )}

          {activeSection === "data" && (
            <DataSettings
              cleanupDays={cleanupDays}
              dataStatus={dataStatus}
              settings={settings}
              onCleanup={onCleanup}
              onCleanupDaysChange={setCleanupDays}
            />
          )}

          {activeSection === "memory" && (
            <MemorySettings
              memories={memories}
              onCreate={onCreateMemory}
              onToggle={onToggleMemory}
              onEdit={onEditMemory}
              onDelete={onDeleteMemory}
            />
          )}

          {activeSection === "kb" && (
            <KbSettings
              settings={settings}
            />
          )}

          {activeSection === "search" && (
            <SearchSettings
              draft={draft}
              saving={saving}
              onDraftChange={setDraft}
              onSave={onSave}
            />
          )}

          {activeSection === "usage" && (
            <UsageSettings />
          )}
        </div>
      </main>
    </section>
  );
}

function normalizeSettingsSection(section?: SettingsSectionId): SettingsSectionId {
  return section && SETTINGS_SECTION_IDS.includes(section) ? section : "general";
}

function SettingsNavIcon({ name }: { name: SettingsIconName }) {
  if (name === "appearance") {
    return (
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
        <path
          d="M4 13.5c1.1-4.1 3.3-7.1 6-8.8 2.8 1.7 4.9 4.7 6 8.8"
          stroke="currentColor"
          strokeWidth="1.35"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M7.2 13.5h5.6M10 5v8.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      </svg>
    );
  }

  if (name === "database") {
    return (
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
        <ellipse cx="10" cy="5.3" rx="5.8" ry="2.4" stroke="currentColor" strokeWidth="1.35" fill="none" />
        <path
          d="M4.2 5.3v7.8c0 1.3 2.6 2.4 5.8 2.4s5.8-1.1 5.8-2.4V5.3M4.2 9.2c0 1.3 2.6 2.4 5.8 2.4s5.8-1.1 5.8-2.4"
          stroke="currentColor"
          strokeWidth="1.35"
          fill="none"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (name === "server") {
    return (
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
        <rect x="3.5" y="4" width="13" height="4.8" rx="1.3" stroke="currentColor" strokeWidth="1.35" fill="none" />
        <rect x="3.5" y="11.2" width="13" height="4.8" rx="1.3" stroke="currentColor" strokeWidth="1.35" fill="none" />
        <path d="M6.2 6.4h.1M6.2 13.6h.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }

  if (name === "spark") {
    return (
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
        <path
          d="M10 3.5l1.4 3.9 3.9 1.4-3.9 1.4L10 14.1l-1.4-3.9-3.9-1.4 3.9-1.4L10 3.5z"
          stroke="currentColor"
          strokeWidth="1.35"
          fill="none"
          strokeLinejoin="round"
        />
        <path d="M15.2 13.2l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5.5-1.3z" fill="currentColor" />
      </svg>
    );
  }

  if (name === "models") {
    return (
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
        <path
          d="M10 2.8l2.1 4.3 4.7.7-3.4 3.3.8 4.7L10 13.6 5.8 15.8l.8-4.7L3.2 7.8l4.7-.7L10 2.8z"
          stroke="currentColor"
          strokeWidth="1.35"
          fill="none"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (name === "memory") {
    return (
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
        <circle cx="10" cy="10" r="6.5" stroke="currentColor" strokeWidth="1.35" fill="none" />
        <path d="M10 6.5V10l2.5 1.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      </svg>
    );
  }

  if (name === "search") {
    return (
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
        <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.35" fill="none" />
        <path d="M13 13l3.5 3.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      </svg>
    );
  }

  if (name === "kb") {
    return (
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
        <path d="M4 3.5h12v13H4z" stroke="currentColor" strokeWidth="1.35" fill="none" strokeLinejoin="round" />
        <path d="M7 7.5h6M7 10.5h4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      </svg>
    );
  }

  if (name === "usage") {
    return (
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
        <rect x="2.5" y="7" width="3.5" height="9" rx="0.5" fill="currentColor" opacity="0.4" />
        <rect x="7" y="3" width="3.5" height="13" rx="0.5" fill="currentColor" opacity="0.55" />
        <rect x="11.5" y="5" width="3.5" height="11" rx="0.5" fill="currentColor" opacity="0.8" />
        <rect x="16" y="2" width="3.5" height="14" rx="0.5" fill="currentColor" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
      <path d="M4 6h7M4 14h7M13 6h3M13 14h3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      <circle cx="12" cy="6" r="1.7" stroke="currentColor" strokeWidth="1.35" fill="none" />
      <circle cx="8" cy="14" r="1.7" stroke="currentColor" strokeWidth="1.35" fill="none" />
    </svg>
  );
}

function GeneralSettings({
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

function AppearanceSettings({
  chatFontSize,
  uiFontSize,
  codeFontSize,
  themeMode,
  locale,
  onChatFontSizeChange,
  onUiFontSizeChange,
  onCodeFontSizeChange,
  onThemeModeChange,
  onLocaleChange,
}: {
  chatFontSize: number;
  uiFontSize: number;
  codeFontSize: number;
  themeMode: ThemeMode;
  locale: Locale;
  onChatFontSizeChange: (size: number) => void;
  onUiFontSizeChange: (size: number) => void;
  onCodeFontSizeChange: (size: number) => void;
  onThemeModeChange: (mode: ThemeMode) => void;
  onLocaleChange: (locale: Locale) => void;
}) {
  const isDefaultChatFontSize = Math.abs(chatFontSize - 14) < 0.001;
  const isDefaultUiFontSize = Math.abs(uiFontSize - 12.5) < 0.001;
  const isDefaultCodeFontSize = Math.abs(codeFontSize - 12) < 0.001;

  return (
    <SettingsGroup title={t("settings.appearance")}>
      <SettingsSelectRow
        title={t("settings.themeTitle")}
        description={t("settings.themeDesc")}
        value={themeMode}
        options={[
          { value: "system", label: t("settings.themeSystem") },
          { value: "light", label: t("settings.themeLight") },
          { value: "dark", label: t("settings.themeDark") },
        ]}
        onChange={(value) => onThemeModeChange(value as ThemeMode)}
      />
      <SettingsSelectRow
        title={t("settings.languageTitle")}
        description={t("settings.languageDesc")}
        value={locale}
        options={[
          { value: "zh", label: t("settings.languageZh") },
         { value: "en", label: t("settings.languageEn") },
          { value: "ko", label: t("settings.languageKo") },
          { value: "ja", label: t("settings.languageJa") },
        ]}
        onChange={(value) => onLocaleChange(value as Locale)}
      />
      <SettingsActionRow
        title={t("settings.uiFontSizeTitle")}
        description={t("settings.uiFontSizeDesc")}
        control={
          <FontSizeControl
            value={uiFontSize}
            defaultValue={12.5}
            min={10}
            max={20}
            step={0.5}
            ariaLabel={t("settings.uiFontSizeTitle")}
            resetDisabled={isDefaultUiFontSize}
            onChange={onUiFontSizeChange}
          />
        }
      />
      <SettingsActionRow
        title={t("settings.chatFontSizeTitle")}
        description={t("settings.chatFontSizeDesc")}
        control={
          <FontSizeControl
            value={chatFontSize}
            defaultValue={14}
            min={11}
            max={24}
            step={0.5}
            ariaLabel={t("settings.chatFontSizeTitle")}
            resetDisabled={isDefaultChatFontSize}
            onChange={onChatFontSizeChange}
          />
        }
      />
      <SettingsActionRow
        title={t("settings.codeFontSizeTitle")}
        description={t("settings.codeFontSizeDesc")}
        control={
          <FontSizeControl
            value={codeFontSize}
            defaultValue={12}
            min={10}
            max={18}
            ariaLabel={t("settings.codeFontSizeTitle")}
            resetDisabled={isDefaultCodeFontSize}
            onChange={onCodeFontSizeChange}
          />
        }
      />
    </SettingsGroup>
  );
}

function FontSizeControl({
  value,
  defaultValue,
  min,
  max,
  step = 1,
  ariaLabel,
  resetDisabled,
  onChange,
}: {
  value: number;
  defaultValue: number;
  min: number;
  max: number;
  step?: number;
  ariaLabel: string;
  resetDisabled: boolean;
  onChange: (size: number) => void;
}) {
  const [draft, setDraft] = useState(() => formatFontSizeInput(value));

  useEffect(() => {
    setDraft(formatFontSizeInput(value));
  }, [value]);

  function commitValue(rawValue: string): void {
    setDraft(rawValue);
    if (rawValue.trim() === "") return;
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return;
    onChange(parsed);
  }

  function restoreValidValue(): void {
    if (draft.trim() === "") {
      setDraft(formatFontSizeInput(value));
      return;
    }
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(formatFontSizeInput(value));
    }
  }

  return (
    <div className="settings-font-size-control">
      <div className="settings-font-size-input-wrap">
        <input
          className="settings-number-input settings-font-size-input"
          type="number"
          min={min}
          max={max}
          step={step}
          value={draft}
          aria-label={ariaLabel}
          onChange={(event) => commitValue(event.target.value)}
          onBlur={restoreValidValue}
        />
        <span className="settings-font-size-unit">px</span>
      </div>
      <button
        type="button"
        className="settings-inline-btn settings-font-size-reset"
        disabled={resetDisabled}
        onClick={() => onChange(defaultValue)}
      >
        {t("settings.fontSizeReset")}
      </button>
    </div>
  );
}

function formatFontSizeInput(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function ProviderSettings({
  draft,
  settings,
  saving,
  fetchingModels,
  onDraftChange,
  onSaveConnection,
  onFetchModelsForProvider,
  onRemoveProvider,
}: {
  draft: SettingsDraft;
  settings: RuntimeSettings | null;
  saving: boolean;
  fetchingModels: boolean;
  onDraftChange: (draft: SettingsDraft) => void;
  onSaveConnection: (draft: SettingsDraft) => void;
  onFetchModelsForProvider: (provider: string) => void;
  onRemoveProvider: (provider: string) => void;
}) {
  const [connectionOpen, setConnectionOpen] = useState(false);

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
  const availableCount = isEditingActive
    ? (settings?.llm.availableModels.length ?? 0)
    : (editingSlot?.availableModels.length ?? 0);
  const configuredProviders = settings?.llm.providers ?? [];
  const connectedIds = new Set(configuredProviders.map((slot) => slot.provider));
  const availableToConnect = PI_PROVIDER_OPTIONS.filter((item) => !connectedIds.has(item.value));
  const popularToConnect = availableToConnect.filter((item) => item.popular);
  const moreToConnect = availableToConnect.filter((item) => !item.popular);
  // 已连接且（本会话已配 key 或槽位已有 key）才允许拉取目录
  const canFetchModels =
    connectedIds.has(draft.provider) && (apiKeyConfigured || draft.apiKey.trim().length > 0);

  function selectProvider(nextProvider: string): void {
    const slot = settings?.llm.providers?.find((item) => item.provider === nextProvider);
    const isActive = settings?.llm.provider === nextProvider;
    onDraftChange({
      ...draft,
      provider: nextProvider,
      // 切换槽位时回填已保存配置；新 provider 清空 baseUrl（兼容端点除外由用户填）
      baseUrl: slot?.baseUrl
        ?? (isActive ? (settings?.llm.baseUrl ?? "") : ""),
      model: slot?.model
        ?? (isActive ? (settings?.llm.model ?? "") : draft.model),
      // 视觉模型全局，不随槽位回填
      visionModel: settings?.llm.visionModel ?? "",
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
    if (!confirm(t("settings.disconnectConfirm").replace("{name}", providerLabel(provider)))) return;
    if (draft.provider === provider) {
      setConnectionOpen(false);
    }
    onRemoveProvider(provider);
  }

  function handleSaveConnection(): void {
    // 保存后保持弹窗打开，便于继续「获取模型列表」
    onSaveConnection(draft);
  }

  function providerKindLabel(slot: { provider: string; baseUrl: string; apiKeyConfigured: boolean }): string {
    if (slot.provider === "openai-compatible" || slot.baseUrl.trim()) {
      return t("settings.providerKindCustom");
    }
    return t("settings.providerKindApiKey");
  }

  function slotModelSummary(slot: {
    model: string;
    availableModels: string[];
    apiKeyConfigured: boolean;
  }): string {
    const parts: string[] = [];
    parts.push(
      slot.apiKeyConfigured
        ? t("settings.apiKeyConfiguredShort")
        : t("settings.apiKeyMissingShort"),
    );
    if (slot.availableModels.length > 0) {
      parts.push(
        `${t("settings.modelDescFetchedPrefix")}${slot.availableModels.length}${t("settings.modelListCountSuffix")}`,
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
            const label = providerLabel(slot.provider);
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
          {[...popularToConnect, ...moreToConnect].map((item) => (
            <div key={item.value} className="settings-provider-line" role="listitem">
              <div className="settings-provider-line-main" data-static="true">
                <ProviderIcon provider={item.value} />
                <span className="settings-provider-line-text">
                  <span className="settings-provider-line-title">
                    <strong>{item.label}</strong>
                  </span>
                  <small>{t(item.descKey as TranslationKey)}</small>
                </span>
              </div>
              <button
                type="button"
                className="settings-provider-connect-btn"
                disabled={saving}
                onClick={() => openConnection(item.value)}
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
          onClick={(event) => event.stopPropagation()}
        >
          <header className="settings-modal-head">
            <div className="settings-modal-title-row">
              <ProviderIcon provider={draft.provider} />
              <div>
                <h2 id="settings-connection-dialog-title">
                  {t("settings.connectionConfig")}
                </h2>
                <p>{providerLabel(draft.provider)}</p>
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
            <label className="settings-modal-field">
              <span>API Key</span>
              <small>
                {apiKeyConfigured
                  ? t("settings.apiKeyConfigured")
                  : t("settings.apiKeyMissing")}
              </small>
              <input
                className="settings-modal-input"
                type="password"
                value={draft.apiKey}
                autoFocus
                placeholder={
                  apiKeyConfigured
                    ? t("settings.apiKeyKeepPlaceholder")
                    : t("settings.apiKeyInputPlaceholder")
                }
                onChange={(event) => onDraftChange({ ...draft, apiKey: event.currentTarget.value })}
              />
            </label>

            <label className="settings-modal-field">
              <span>Base URL</span>
              <small>{t("settings.baseUrlDesc")}</small>
              <input
                className="settings-modal-input"
                value={draft.baseUrl}
                onChange={(event) => onDraftChange({ ...draft, baseUrl: event.currentTarget.value })}
              />
            </label>

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

            <div className="settings-modal-field">
              <span>{t("settings.fetchModelsTitle")}</span>
              <small>
                {canFetchModels
                  ? availableCount > 0
                    ? `${t("settings.modelDescFetchedPrefix")}${availableCount}${t("settings.modelListCountSuffix")} · ${t("settings.fetchModelsNoSetHint")}`
                    : t("settings.fetchModelsDesc")
                  : t("settings.fetchModelsNeedSave")}
              </small>
              <button
                type="button"
                className="settings-secondary-btn settings-modal-fetch-btn"
                disabled={saving || fetchingModels || !canFetchModels}
                onClick={() => onFetchModelsForProvider(draft.provider)}
              >
                {fetchingModels ? t("settings.fetching") : t("settings.fetchModels")}
              </button>
            </div>
          </div>

          <footer className="settings-modal-foot">
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
          </footer>
        </div>
      </div>
    )}
    </>
  );
}

function ModelsSettings({
  settings,
  saving,
  fetchingModels,
  onFetchModelsForProvider,
  onSaveSlotEnabledModels,
  onSelectModel,
  onSaveVisionModel,
}: {
  settings: RuntimeSettings | null;
  saving: boolean;
  fetchingModels: boolean;
  onFetchModelsForProvider: (provider: string) => void;
  onSaveSlotEnabledModels: (provider: string, models: string[]) => void;
  onSelectModel: (provider: string, model: string) => void;
  onSaveVisionModel: (visionModel: string) => void;
}) {
  const [query, setQuery] = useState("");
  /** 本地乐观启用列表：取消勾选立即生效，不被 saving/回写时序弹回 */
  const [enabledLocal, setEnabledLocal] = useState<Record<string, string[]>>({});

  const providers = settings?.llm.providers ?? [];
  const activeProvider = settings?.llm.provider;
  const activeModel = settings?.llm.model ?? "";
  /** 全局视觉：namespace `provider:model` 或裸 id */
  const globalVision = settings?.llm.visionModel ?? "";
  const normalizedQuery = query.trim().toLowerCase();

  // 服务端 settings 变化时同步本地勾选（仅当与本地无冲突的 pending 时）
  useEffect(() => {
    if (!settings) return;
    setEnabledLocal((prev) => {
      const next: Record<string, string[]> = { ...prev };
      for (const slot of settings.llm.providers) {
        const serverList = filterChatModelIds(
          slot.provider === settings.llm.provider
            ? (settings.llm.enabledModels ?? [])
            : (slot.enabledModels ?? []),
        );
        // 若本地没有该 key，或服务端已追上本地，则采用服务端
        if (prev[slot.provider] === undefined) {
          next[slot.provider] = serverList;
          continue;
        }
        const localList = prev[slot.provider] ?? [];
        const same =
          localList.length === serverList.length
          && localList.every((m) => serverList.includes(m));
        if (same) next[slot.provider] = serverList;
        // 否则保留本地乐观值，等待下一次服务端一致
      }
      return next;
    });
  }, [settings]);

  function slotAvailable(provider: string): string[] {
    const raw =
      provider === activeProvider
        ? (settings?.llm.availableModels ?? [])
        : (settings?.llm.providers?.find((item) => item.provider === provider)?.availableModels ?? []);
    // 前端再滤一层，兼容尚未重新拉取的历史脏列表
    return filterChatModelIds(raw);
  }

  function slotEnabled(provider: string): string[] {
    if (enabledLocal[provider] !== undefined) {
      return enabledLocal[provider]!;
    }
    const raw =
      provider === activeProvider
        ? (settings?.llm.enabledModels ?? [])
        : (settings?.llm.providers?.find((item) => item.provider === provider)?.enabledModels ?? []);
    return filterChatModelIds(raw);
  }

  function slotDefaultModel(provider: string): string {
    if (provider === activeProvider) {
      return activeModel;
    }
    return settings?.llm.providers?.find((item) => item.provider === provider)?.model ?? "";
  }

  function commitEnabled(provider: string, models: string[]): void {
    const next = filterChatModelIds(models);
    setEnabledLocal((prev) => ({ ...prev, [provider]: next }));
    onSaveSlotEnabledModels(provider, next);
  }

  function toggleModel(provider: string, model: string, checked: boolean): void {
    const enabled = new Set(slotEnabled(provider));
    if (checked) enabled.add(model);
    else enabled.delete(model);
    commitEnabled(provider, [...enabled]);
  }

  function enableAll(provider: string): void {
    const available = slotAvailable(provider);
    if (available.length === 0) return;
    commitEnabled(provider, available);
  }

  /** 清空该 Provider 在主界面菜单中的勾选（可全不选）。 */
  function enableNone(provider: string): void {
    commitEnabled(provider, []);
  }

  /** 跨 provider 的视觉候选：namespace 保证同名模型不冲突 */
  const visionOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = [];
    const seen = new Set<string>();
    for (const slot of providers) {
      const models = new Set([
        ...slotAvailable(slot.provider),
        ...slotEnabled(slot.provider),
        ...(slotDefaultModel(slot.provider) ? [slotDefaultModel(slot.provider)] : []),
      ]);
      for (const model of models) {
        if (!isChatModelId(model)) continue;
        const value = modelNamespace(slot.provider, model);
        if (seen.has(value)) continue;
        seen.add(value);
        options.push({
          value,
          label: `${providerLabel(slot.provider)} / ${model}`,
        });
      }
    }
    if (globalVision && !seen.has(globalVision)) {
      const parsed = parseModelNamespace(globalVision);
      options.unshift({
        value: globalVision,
        label: parsed.provider
          ? `${providerLabel(parsed.provider)} / ${parsed.model}`
          : globalVision,
      });
    }
    return options;
  }, [providers, settings, globalVision, activeProvider, activeModel]);

  const visionSelectValue = (() => {
    if (!globalVision) return "";
    if (visionOptions.some((opt) => opt.value === globalVision)) return globalVision;
    if (activeProvider) {
      const ns = modelNamespace(activeProvider, globalVision);
      if (visionOptions.some((opt) => opt.value === ns)) return ns;
    }
    const bare = visionOptions.find((opt) => parseModelNamespace(opt.value).model === globalVision);
    return bare?.value ?? globalVision;
  })();

  const groups = providers
    .map((slot) => {
      const available = slotAvailable(slot.provider);
      const models = normalizedQuery
        ? available.filter((model) => {
            const ns = modelNamespace(slot.provider, model).toLowerCase();
            const label = providerLabel(slot.provider).toLowerCase();
            return (
              model.toLowerCase().includes(normalizedQuery)
              || ns.includes(normalizedQuery)
              || label.includes(normalizedQuery)
            );
          })
        : available;
      return { slot, models };
    })
    .filter((group) => group.models.length > 0 || !normalizedQuery)
    .sort((a, b) => {
      if (a.slot.provider === activeProvider) return -1;
      if (b.slot.provider === activeProvider) return 1;
      return a.slot.provider.localeCompare(b.slot.provider);
    });

  return (
    <>
      <p className="settings-models-hint">{t("settings.modelsPageHint")}</p>

      <div className="settings-models-search-wrap">
        <input
          className="settings-models-search"
          type="search"
          value={query}
          placeholder={t("settings.searchModels")}
          onChange={(event) => setQuery(event.currentTarget.value)}
          aria-label={t("settings.searchModels")}
        />
      </div>

      {providers.length > 0 && (
        <label className="settings-models-vision settings-models-vision-global">
          <span>
            <strong>{t("settings.visionModelTitle")}</strong>
            <small>{t("settings.visionModelDesc")}</small>
          </span>
          <select
            className="settings-models-vision-select"
            value={visionSelectValue}
            disabled={saving || visionOptions.length === 0}
            onChange={(event) => onSaveVisionModel(event.currentTarget.value)}
          >
            <option value="">{t("settings.visionModelPlaceholder")}</option>
            {visionOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {providers.length === 0 ? (
        <div className="settings-provider-empty">
          <p>{t("settings.modelsNeedProvider")}</p>
        </div>
      ) : groups.length === 0 ? (
        <div className="settings-provider-empty">
          <p>{t("settings.modelsNoMatch")}</p>
        </div>
      ) : (
        groups.map(({ slot, models }) => {
          const enabledSet = new Set(slotEnabled(slot.provider));
          const current = slotDefaultModel(slot.provider);
          const available = slotAvailable(slot.provider);
          const isActiveSlot = slot.provider === activeProvider;
          const visionParsed = parseModelNamespace(globalVision);
          const allEnabled = available.length > 0 && available.every((m) => enabledSet.has(m));
          return (
            <section key={slot.provider} className="settings-models-group">
              <header className="settings-models-group-head">
                <ProviderIcon provider={slot.provider} />
                <div className="settings-models-group-title">
                  <strong>{providerLabel(slot.provider)}</strong>
                  <small>
                    <span className="settings-models-ns">{slot.provider}</span>
                    {" · "}
                    {enabledSet.size}/{available.length || models.length}
                    {isActiveSlot ? ` · ${t("settings.providerActive")}` : ""}
                  </small>
                </div>
                <div className="settings-models-group-actions">
                  <button
                    type="button"
                    className="settings-secondary-btn"
                    disabled={fetchingModels || saving}
                    onClick={() => onFetchModelsForProvider(slot.provider)}
                  >
                    {fetchingModels ? t("settings.fetching") : t("settings.fetchModels")}
                  </button>
                  {available.length > 0 && (
                    <>
                      <button
                        type="button"
                        className="settings-secondary-btn"
                        disabled={saving || allEnabled}
                        onClick={() => enableAll(slot.provider)}
                      >
                        {t("settings.enableAllModels")}
                      </button>
                      <button
                        type="button"
                        className="settings-secondary-btn"
                        disabled={saving || enabledSet.size === 0}
                        onClick={() => enableNone(slot.provider)}
                      >
                        {t("settings.enableNoneModels")}
                      </button>
                    </>
                  )}
                </div>
              </header>

              {available.length === 0 ? (
                <div className="settings-provider-empty settings-models-empty-inline">
                  <p>{t("settings.modelEmptyFetchHere")}</p>
                </div>
              ) : (
                <div className="settings-provider-sheet settings-models-sheet" role="list">
                  {models.map((model) => {
                    const isCurrent = isActiveSlot && model === current;
                    // 勾选 = 出现在输入框模型菜单；点名称 = 切换并保存为当前主模型
                    const checked = enabledSet.has(model);
                    const ns = modelNamespace(slot.provider, model);
                    const isVision =
                      globalVision === ns
                      || (visionParsed.provider === slot.provider && visionParsed.model === model)
                      || (!visionParsed.provider && globalVision === model);
                    return (
                      <div
                        key={ns}
                        className="settings-models-row"
                        data-current={isCurrent}
                        role="listitem"
                      >
                        <button
                          type="button"
                          className="settings-models-row-main"
                          disabled={saving || isCurrent}
                          title={isCurrent ? ns : t("settings.clickToUseModel")}
                          onClick={() => {
                            if (!isCurrent) onSelectModel(slot.provider, model);
                          }}
                        >
                          <span className="settings-models-row-id" title={ns}>{model}</span>
                          {isCurrent && <em>{t("settings.modelCurrent")}</em>}
                          {isVision && !isCurrent && <em>{t("settings.modelVisionTag")}</em>}
                        </button>
                        <input
                          type="checkbox"
                          checked={checked}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => {
                            event.stopPropagation();
                            toggleModel(slot.provider, model, event.currentTarget.checked);
                          }}
                          aria-label={`${ns} ${t("settings.enableModelListLabel")}`}
                          title={t("settings.enabledModelsDesc")}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })
      )}
    </>
  );
}

/** provider:model — model 段可含冒号；provider 为合法 id */
function modelNamespace(provider: string, model: string): string {
  return `${provider}:${model}`;
}

function parseModelNamespace(value: string): { provider?: string; model: string } {
  const raw = value.trim();
  if (!raw) return { model: "" };
  const [maybeProvider, rest] = raw.split(/:(.*)/s);
  if (rest !== undefined && rest.length > 0 && /^[a-z0-9][a-z0-9-]*$/.test(maybeProvider)) {
    return { provider: maybeProvider, model: rest };
  }
  return { model: raw };
}

function McpSettings({
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
  onSave: (draft: SettingsDraft) => void;
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
            onClick={() => onSave(draft)}
          >
            {t("settings.saveMcp")}
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

function DataSettings({
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

function UsageSettings() {
  const [report, setReport] = useState<TokenUsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const reload = () => {
    setLoading(true);
    setError(false);
    getTokenUsageReport()
      .then(setReport)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  };

  useEffect(() => { reload(); }, []);

  const ready = !loading && !error && report && report.available;

  if (loading) {
    return (
      <SettingsGroup title={t("settings.usageOverview")}>
        <div className="usage-loading">
          <div className="usage-loading-spinner" />
          <span>{t("settings.fetching")}</span>
        </div>
      </SettingsGroup>
    );
  }

  if (error || !ready) {
    return (
      <SettingsGroup title={t("settings.usageOverview")}>
        <div className="usage-error">
          <span>{error ? t("settings.usageFetchFailed") : t("settings.tokenUsageUnavailable")}</span>
          <button type="button" className="settings-secondary-btn" onClick={reload}>
            {t("settings.refresh")}
          </button>
        </div>
      </SettingsGroup>
    );
  }

  const inputPct = report.totalTokens > 0 ? (report.promptTokens / report.totalTokens) * 100 : 0;
  const outputPct = report.totalTokens > 0 ? (report.completionTokens / report.totalTokens) * 100 : 0;
  const reasoningPct = report.completionTokens > 0 ? (report.reasoningTokens / report.completionTokens) * 100 : 0;
  const cachePct = report.promptTokens > 0 ? (report.cacheReadTokens / report.promptTokens) * 100 : 0;

  return (
    <>
      <SettingsGroup title={t("settings.usageOverview")}>
        <div className="usage-stats-grid">
          <div className="usage-stat-card">
            <div className="usage-stat-label">{t("settings.tokenUsageTotal")}</div>
            <div className="usage-stat-value">{formatTokenCount(report.totalTokens)}</div>
            <div className="usage-stat-sub">
              {report.measuredTasks}/{report.tasks} {t("settings.tokenUsageTasks")}
            </div>
          </div>
          <div className="usage-stat-card">
            <div className="usage-stat-label">{t("settings.tokenUsagePrompt")}</div>
            <div className="usage-stat-value usage-stat-input">{formatTokenCount(report.promptTokens)}</div>
            <div className="usage-stat-sub">{inputPct.toFixed(1)}%</div>
          </div>
          <div className="usage-stat-card">
            <div className="usage-stat-label">{t("settings.tokenUsageCompletion")}</div>
            <div className="usage-stat-value usage-stat-output">{formatTokenCount(report.completionTokens)}</div>
            <div className="usage-stat-sub">{outputPct.toFixed(1)}%</div>
          </div>
          {report.reasoningTokens > 0 && (
            <div className="usage-stat-card">
              <div className="usage-stat-label">{t("settings.tokenUsageReasoning")}</div>
              <div className="usage-stat-value usage-stat-reasoning">{formatTokenCount(report.reasoningTokens)}</div>
              <div className="usage-stat-sub">{reasoningPct.toFixed(1)}% {t("settings.usageOfOutput")}</div>
            </div>
          )}
          {report.estimatedCostUsd > 0 && (
            <div className="usage-stat-card">
              <div className="usage-stat-label">{t("settings.tokenUsageEstimatedCost")}</div>
              <div className="usage-stat-value usage-stat-cost">${report.estimatedCostUsd.toFixed(4)}</div>
              <div className="usage-stat-sub">USD</div>
            </div>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("settings.usageBreakdown")}>
        <div className="usage-breakdown-card">
          <div className="usage-breakdown-header">
            <span className="usage-breakdown-title">{t("settings.usageInputTokens")}</span>
            <span className="usage-breakdown-value">{formatTokenCount(report.promptTokens)}</span>
          </div>
          <div className="usage-breakdown-desc">{t("settings.usageInputDetail")}</div>
          
          {report.cacheReadTokens > 0 && (
            <>
              <div className="usage-breakdown-sub">
                <div className="usage-breakdown-header">
                  <span className="usage-breakdown-title">{t("settings.usageInputCache")}</span>
                  <span className="usage-breakdown-value">{formatTokenCount(report.cacheReadTokens)}</span>
                </div>
                <div className="usage-breakdown-desc">
                  {t("settings.usageCacheHitRate")} {cachePct.toFixed(1)}%
                </div>
              </div>
            </>
          )}

          <div className="usage-breakdown-divider" />

          <div className="usage-breakdown-header">
            <span className="usage-breakdown-title">{t("settings.usageOutputTokens")}</span>
            <span className="usage-breakdown-value">{formatTokenCount(report.completionTokens)}</span>
          </div>
          <div className="usage-breakdown-desc">{t("settings.usageOutputDetail")}</div>
          {report.reasoningTokens > 0 && (
            <div className="usage-breakdown-sub">
              <div className="usage-breakdown-header">
                <span className="usage-breakdown-title">{t("settings.tokenUsageReasoning")}</span>
                <span className="usage-breakdown-value">{formatTokenCount(report.reasoningTokens)}</span>
              </div>
              <div className="usage-breakdown-desc">
                {reasoningPct.toFixed(1)}% {t("settings.usageOfOutput")}
              </div>
            </div>
          )}
        </div>
      </SettingsGroup>

      {report.breakdown.length > 0 && (
        <SettingsGroup title={t("settings.usageByModel")}>
          <div className="usage-model-table">
            <div className="usage-model-row usage-model-head">
              <span>{t("settings.usageProviderModel")}</span>
              <span>{t("settings.tokenUsageTotal")}</span>
              <span>{t("settings.tokenUsagePrompt")}</span>
              <span>{t("settings.tokenUsageCompletion")}</span>
              <span>{t("settings.tokenUsageTasks")}</span>
            </div>
            {report.breakdown.map((item) => (
              <div className="usage-model-row" key={`${item.provider}:${item.model}`}>
                <span className="usage-model-name">
                  <strong>{item.model}</strong>
                  <small>{item.provider}</small>
                </span>
                <span>{formatTokenCount(item.totalTokens)}</span>
                <span>{formatTokenCount(item.promptTokens)}</span>
                <span>{formatTokenCount(item.completionTokens)}</span>
                <span>{item.tasks}</span>
              </div>
            ))}
          </div>
        </SettingsGroup>
      )}
    </>
  );
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const MEMORY_CATEGORIES: MemoryCategory[] = ["preference", "directory", "model", "habit", "fact", "other"];

function memoryCategoryLabel(category: MemoryCategory): string {
  switch (category) {
    case "preference": return t("memory.cat.preference");
    case "directory": return t("memory.cat.directory");
    case "model": return t("memory.cat.model");
    case "habit": return t("memory.cat.habit");
    case "fact": return t("memory.cat.fact");
    case "other": return t("memory.cat.other");
    default: return category;
  }
}

function MemorySettings({
  memories,
  onCreate,
  onToggle,
  onEdit,
  onDelete,
}: {
  memories: MemoryEntry[];
  onCreate: (content: string, category: MemoryCategory) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onEdit: (id: string, content: string, category: MemoryCategory) => void;
  onDelete: (id: string) => void;
}) {
  const [newContent, setNewContent] = useState("");
  const [newCategory, setNewCategory] = useState<MemoryCategory>("preference");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editCategory, setEditCategory] = useState<MemoryCategory>("preference");

  const enabledCount = memories.filter((m) => m.enabled).length;

  function submitNew() {
    const trimmed = newContent.trim();
    if (!trimmed) return;
    onCreate(trimmed, newCategory);
    setNewContent("");
  }

  function startEdit(memory: MemoryEntry) {
    setEditingId(memory.id);
    setEditContent(memory.content);
    setEditCategory(memory.category);
  }

  function saveEdit() {
    if (editingId && editContent.trim()) {
      onEdit(editingId, editContent.trim(), editCategory);
      setEditingId(null);
    }
  }

  return (
    <>
      <SettingsGroup title={`${t("memory.title")} (${memories.length} / ${enabledCount} ${t("memory.entriesInjected")})`}>
        <div className="memory-add">
          <select
            className="memory-cat-select"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value as MemoryCategory)}
            aria-label={t("memory.categoryLabel")}
          >
            {MEMORY_CATEGORIES.map((value) => (
              <option key={value} value={value}>{memoryCategoryLabel(value)}</option>
            ))}
          </select>
          <input
            className="memory-add-input"
            value={newContent}
            placeholder={t("memory.addPlaceholder")}
            onChange={(e) => setNewContent(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitNew(); }}
          />
          <button type="button" className="memory-add-btn" onClick={submitNew} disabled={!newContent.trim()}>
            {t("action.add")}
          </button>
        </div>
      </SettingsGroup>

      {memories.length === 0 ? (
        <p className="memory-empty">{t("memory.empty")}</p>
      ) : (
        <SettingsGroup title="">
          <ul className="memory-list">
            {memories.map((memory) => (
              <li key={memory.id} className="memory-item" data-disabled={!memory.enabled}>
                {editingId === memory.id ? (
                  <div className="memory-edit">
                    <select
                      className="memory-cat-select"
                      value={editCategory}
                      onChange={(e) => setEditCategory(e.target.value as MemoryCategory)}
                    >
                      {MEMORY_CATEGORIES.map((value) => (
                        <option key={value} value={value}>{memoryCategoryLabel(value)}</option>
                      ))}
                    </select>
                    <textarea
                      className="memory-edit-input"
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      rows={2}
                    />
                    <div className="memory-edit-actions">
                      <button type="button" className="memory-link" onClick={saveEdit}>{t("action.save")}</button>
                      <button type="button" className="memory-link" onClick={() => setEditingId(null)}>{t("action.cancel")}</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="memory-item-head">
                      <span className="memory-cat">{memoryCategoryLabel(memory.category)}</span>
                      <span className="memory-confidence">{Math.round(memory.confidence * 100)}%</span>
                      <label className="memory-toggle">
                        <input
                          type="checkbox"
                          checked={memory.enabled}
                          onChange={(e) => onToggle(memory.id, e.target.checked)}
                        />
                      </label>
                    </div>
                    <p className="memory-content">{memory.content}</p>
                    <div className="memory-item-foot">
                      <span className="memory-source">
                        {memory.source.origin === "user"
                          ? t("memory.sourceUser")
                          : `${t("memory.sourceAgent")}${memory.source.taskGoal ? `${t("memory.fromTaskPrefix")}${memory.source.taskGoal}${t("memory.fromTaskSuffix")}` : ""}`}
                      </span>
                      <span className="memory-time">{new Date(memory.createdAt).toLocaleDateString()}</span>
                      <span className="memory-item-actions">
                        <button type="button" className="memory-link" onClick={() => startEdit(memory)}>{t("action.edit")}</button>
                        <button type="button" className="memory-link danger" onClick={() => onDelete(memory.id)}>{t("action.delete")}</button>
                      </span>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        </SettingsGroup>
      )}
    </>
  );
}
function KbSettings({ settings: _settings }: { settings: RuntimeSettings | null }) {
  const [dirs, setDirs] = useState<KbDir[]>([]);
  const [status, setStatus] = useState<KbIndexStatus | null>(null);
  const [dirInput, setDirInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const { listKbDirs, getKbStatus } = await import("../api");
      setDirs(await listKbDirs());
      setStatus(await getKbStatus());
    } catch { setError(t("kb.statusFailed")); }
  }

  async function addDir() {
    const trimmed = dirInput.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      const { createKbDir } = await import("../api");
      const dir = await createKbDir(trimmed);
      setDirs((prev) => [...prev, dir]);
      setDirInput("");
      setError("");
    } catch { setError(t("kb.addFailed")); }
    setAdding(false);
  }

  async function removeDir(id: string) {
    try {
      const { deleteKbDir } = await import("../api");
      await deleteKbDir(id);
      setDirs((prev) => prev.filter((d) => d.id !== id));
    } catch { setError(t("kb.deleteFailed")); }
  }

return (
    <>
<SettingsGroup title={t("kb.dirsTitle")}>
        <div className="memory-add">
          <input
            className="memory-add-input"
            value={dirInput}
            placeholder={t("kb.addDirPlaceholder")}
            onChange={(e) => setDirInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addDir(); }}
          />
          <button type="button" className="memory-add-btn" onClick={addDir} disabled={adding || !dirInput.trim()}>
            {t("kb.addDir")}
          </button>
        </div>
        {error && <p className="memory-source" style={{ color: "var(--danger)", margin: "4px 0 0 14px" }}>{error}</p>}

        {dirs.length === 0 ? (
          <p className="memory-empty" style={{ padding: "12px 14px" }}>{t("kb.noDirs")}</p>
        ) : (
          <ul className="memory-list">
            {dirs.map((dir) => (
              <li key={dir.id} className="memory-item">
                <code className="memory-content">{dir.dirPath}</code>
                <div className="memory-item-foot">
                  <span className="memory-source">{dir.recursive ? "recursive" : "non-recursive"}</span>
                  <button type="button" className="memory-link danger" onClick={() => removeDir(dir.id)}>
                    {t("kb.removeDir")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsGroup>

      {status && (
        <SettingsGroup title={t("kb.statusTitle")}>
          <div className="settings-row">
            <div className="settings-info">
              <span className="settings-label">{t("kb.totalFiles")}: {status.totalFiles}</span>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-info">
              <span className="settings-label">{t("kb.totalChunks")}: {status.totalChunks}</span>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-info">
              <span className="settings-label">{t("kb.lastIndexed")}: {status.lastIndexed ? new Date(status.lastIndexed).toLocaleString() : t("kb.emptyStatus")}</span>
            </div>
          </div>
        </SettingsGroup>
      )}
    </>
  );
}

function SearchSettings({
  draft,
  saving,
  onDraftChange,
  onSave,
}: {
  draft: SettingsDraft;
  saving: boolean;
  onDraftChange: (draft: SettingsDraft) => void;
  onSave: (draft: SettingsDraft) => void;
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
              onClick={() => onSave(draft)}
            >
              {saving ? t("settings.saving") : t("action.save")}
            </button>
          }
        />
      </SettingsGroup>
    </>
  );
}

function SettingsGroup({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section className="settings-content-group">
      <h2>{title}</h2>
      <div className="settings-row-card">{children}</div>
    </section>
  );
}


function SettingsChoiceGroup({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section className="settings-content-group">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function SettingsInfoRow({
  description,
  title,
  value,
}: {
  description: string;
  title: string;
  value?: string;
}) {
  return (
    <div className="settings-row">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      {value && <em>{value}</em>}
    </div>
  );
}

/** 卡片内说明行：与 settings-row 同结构，无右侧控件。 */
function SettingsNoteRow({ description, title }: { description: string; title: string }) {
  return (
    <div className="settings-row settings-row-note">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    </div>
  );
}

function SettingsBudgetField({
  hint,
  label,
  value,
  onChange,
}: {
  hint: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="settings-budget-field">
      <span className="settings-budget-field-label">{label}</span>
      <span className="settings-budget-field-control">
        <input
          className="settings-budget-input"
          type="number"
          min={1}
          value={value}
          onChange={(event) => onChange(Math.max(1, Number(event.currentTarget.value) || 1))}
        />
        <span className="settings-budget-field-hint">{hint}</span>
      </span>
    </label>
  );
}

function SettingsActionRow({
  control,
  description,
  title,
}: {
  control: React.ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div className="settings-row">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <div className="settings-row-control">{control}</div>
    </div>
  );
}

function SettingsSelectRow({
  description,
  options,
  title,
  value,
  onChange,
}: {
  description: string;
  options: Array<{ label: string; value: string }>;
  title: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="settings-row">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <select
        className="settings-select"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function SettingsSwitchRow({
  checked,
  description,
  title,
  onChange,
}: {
  checked: boolean;
  description: string;
  title: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-row settings-switch-row">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
    </label>
  );
}

function makeDraft(settings: RuntimeSettings | null): SettingsDraft {
  return {
    provider: settings?.llm.provider ?? "openai",
    baseUrl: settings?.llm.baseUrl ?? "",
    model: settings?.llm.model ?? "",
    visionModel: settings?.llm.visionModel ?? "",
    apiKey: "",
    workspaceDir: settings?.workspaceDir ?? "",
    maxTokens: settings?.llm.maxTokens ?? 8192,
    commandExecutionEnabled: settings?.commandExecutionEnabled ?? false,
    autoModeSafetyEnabled: settings?.autoModeSafetyEnabled ?? true,
    agentToolExecution: settings?.agentToolExecution ?? "parallel",
    mcpServersJson: settings?.mcpServersJson ?? "",
    cleanupPolicyDays: settings?.cleanupPolicyDays ?? 30,
    budgetRunMaxIterations: settings?.budget?.run.maxIterations ?? 120,
    budgetRunMaxToolCalls: settings?.budget?.run.maxToolCalls ?? 300,
    budgetRunMaxWallTimeMin: Math.max(
      1,
      Math.round((settings?.budget?.run.maxWallTimeMs ?? 45 * 60 * 1000) / 60_000),
    ),
    budgetLifetimeMaxIterations: settings?.budget?.lifetime.maxIterations ?? 500,
    budgetLifetimeMaxToolCalls: settings?.budget?.lifetime.maxToolCalls ?? 1500,
    budgetLifetimeMaxWallTimeMin: Math.max(
      1,
      Math.round((settings?.budget?.lifetime.maxWallTimeMs ?? 3 * 60 * 60 * 1000) / 60_000),
    ),
    // 默认复用 LLM 配置（都是 OpenAI 兼容 API）
    embeddingProvider: settings?.embedding?.provider ?? "off",
    embeddingModel: settings?.embedding?.model ?? "nomic-embed-text",
    embeddingBaseUrl: settings?.embedding?.baseUrl || settings?.llm.baseUrl || "",
    embeddingApiKey: "",
    searchProvider: settings?.search?.provider ?? "duckduckgo_lite",
    searchBaseUrl: settings?.search?.baseUrl ?? "",
    searchApiKey: "",
  };
}

export type { SettingsDraft };
