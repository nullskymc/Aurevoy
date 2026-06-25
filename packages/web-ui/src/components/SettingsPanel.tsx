import { useEffect, useState } from "react";
import type {
  DataStatusResponse,
  McpServerStatus,
  MemoryCategory,
  MemoryEntry,
  RuntimeSettings,
} from "@aurevoy/shared";
import { t, type Locale } from "../i18n";
import { setBaseUrl } from "../api";

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
  temperature: number;
  timeoutMs: number;
  maxTokens: number;
  commandExecutionEnabled: boolean;
  mcpServersJson: string;
  cleanupPolicyDays: number;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
}

interface SettingsPanelProps {
  settings: RuntimeSettings | null;
  mcpServers: McpServerStatus[];
  dataStatus: DataStatusResponse | null;
  memories: MemoryEntry[];
  saving: boolean;
  fetchingModels: boolean;
  fontScale: number;
  workMode: WorkMode;
  themeMode: ThemeMode;
  locale: Locale;
  initialSection?: SettingsSectionId;
  onClose: () => void;
  onSave: (draft: SettingsDraft) => void;
  onCleanup: (olderThanDays: number) => void;
  onRefresh: () => void;
  onFetchModels: () => void;
  onSaveEnabledModels: (models: string[]) => void;
  onFontScaleChange: (scale: number) => void;
  onWorkModeChange: (mode: WorkMode) => void;
  onThemeModeChange: (mode: ThemeMode) => void;
  onLocaleChange: (locale: Locale) => void;
  onCreateMemory: (content: string, category: MemoryCategory) => void;
  onToggleMemory: (id: string, enabled: boolean) => void;
  onEditMemory: (id: string, content: string, category: MemoryCategory) => void;
  onDeleteMemory: (id: string) => void;
  onConnectionChange?: () => void;
}

type SettingsSectionId = "general" | "appearance" | "provider" | "mcp" | "data" | "memory" | "kb";
type ThemeMode = "system" | "light" | "dark";
type WorkMode = "coding" | "daily";
const SETTINGS_SECTION_IDS: SettingsSectionId[] = ["general", "appearance", "provider", "mcp", "data", "memory", "kb"];

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
      { id: "provider", label: t("settings.nav.provider"), icon: "spark" },
    ],
  },
  {
    label: t("settings.group.integration"),
    items: [
      { id: "mcp", label: t("settings.nav.mcp"), icon: "server" },
    ],
  },
  {
    label: t("settings.group.data"),
    items: [
      { id: "data", label: t("settings.nav.data"), icon: "database" },
      { id: "kb", label: t("settings.nav.knowledgeBase"), icon: "kb" },
      { id: "memory", label: t("settings.nav.memory"), icon: "memory" },
    ],
  },
];
}

type SettingsIconName = "appearance" | "database" | "kb" | "memory" | "server" | "sliders" | "spark";

export function SettingsPanel({
  settings,
  mcpServers,
  dataStatus,
  memories,
  saving,
  fetchingModels,
  fontScale,
  workMode,
  themeMode,
  locale,
  initialSection = "general",
  onClose,
  onSave,
  onCleanup,
  onRefresh,
  onFetchModels,
  onSaveEnabledModels,
  onFontScaleChange,
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
  const [query, setQuery] = useState("");
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
  const normalized = query.trim().toLowerCase();
  const visibleGroups = !normalized
    ? groups
    : groups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => item.label.toLowerCase().includes(normalized)),
      }))
      .filter((group) => group.items.length > 0);

  const activeTitle = getSettingsGroups().flatMap((group) => group.items).find(
    (item) => item.id === activeSection,
  )?.label;

  return (
    <section className="settings-workspace" aria-label={t("settings.pageLabel")}>
      <aside className="sidebar settings-nav" aria-label={t("settings.navLabel")}>
        <div className="sidebar-brand settings-nav-brand">
          <img className="sidebar-brand-logo" src="/aurevoy-wordmark.svg" alt="Aurevoy" />
        </div>

        <button type="button" className="sidebar-action settings-back" onClick={onClose}>
          {t("settings.backToApp")}
        </button>

        <input
          className="settings-search"
          value={query}
          placeholder={t("settings.searchPlaceholder")}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />

        <div className="sidebar-scroll settings-nav-scroll">
          {visibleGroups.map((group) => (
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
              fontScale={fontScale}
              themeMode={themeMode}
              locale={locale}
              onFontScaleChange={onFontScaleChange}
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
              onSave={onSave}
              onFetchModels={onFetchModels}
              onSaveEnabledModels={onSaveEnabledModels}
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

  if (name === "memory") {
    return (
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
        <circle cx="10" cy="10" r="6.5" stroke="currentColor" strokeWidth="1.35" fill="none" />
        <path d="M10 6.5V10l2.5 1.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
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
  fontScale,
  themeMode,
  locale,
  onFontScaleChange,
  onThemeModeChange,
  onLocaleChange,
}: {
  fontScale: number;
  themeMode: ThemeMode;
  locale: Locale;
  onFontScaleChange: (scale: number) => void;
  onThemeModeChange: (mode: ThemeMode) => void;
  onLocaleChange: (locale: Locale) => void;
}) {
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
        title={t("settings.fontScaleTitle")}
        description={t("settings.fontScaleDesc")}
        control={
          <label className="settings-range-control">
            <input
              type="range"
              min={0.86}
              max={1.08}
              step={0.01}
              value={fontScale}
              onChange={(event) => onFontScaleChange(Number(event.currentTarget.value))}
            />
            <strong>{Math.round(fontScale * 100)}%</strong>
          </label>
        }
      />
    </SettingsGroup>
  );
}

function ProviderSettings({
  draft,
  settings,
  saving,
  fetchingModels,
  onDraftChange,
  onSave,
  onFetchModels,
  onSaveEnabledModels,
}: {
  draft: SettingsDraft;
  settings: RuntimeSettings | null;
  saving: boolean;
  fetchingModels: boolean;
  onDraftChange: (draft: SettingsDraft) => void;
  onSave: (draft: SettingsDraft) => void;
  onFetchModels: () => void;
  onSaveEnabledModels: (models: string[]) => void;
}) {
  const availableModels = settings?.llm.availableModels ?? [];
  const enabledModels = settings?.llm.enabledModels ?? [];
  const currentModel = settings?.llm.model ?? draft.model;
  const modelInputOptions = [...new Set([currentModel, ...availableModels].filter(Boolean))];
  const currentModelMissing = Boolean(currentModel && availableModels.length > 0 && !availableModels.includes(currentModel));
  const enabledSet = new Set(enabledModels);

  function toggleEnabledModel(model: string, checked: boolean): void {
    if (model === currentModel && !checked) return;
    const next = checked
      ? [...new Set([...enabledModels, model])]
      : enabledModels.filter((item) => item !== model);
    onSaveEnabledModels(next);
  }

  return (
    <>
    <SettingsGroup title={t("settings.providerConfig")}>
      <SettingsActionRow
        title={t("settings.providerTitle")}
        description={t("settings.providerDesc")}
        control={
          <select
            className="settings-inline-select"
            value={draft.provider}
            onChange={(event) => onDraftChange({ ...draft, provider: event.currentTarget.value })}
          >
            <option value="openai">OpenAI Compatible</option>
            <option value="anthropic">Anthropic Claude</option>
            <option value="openai-response">OpenAI Responses API</option>
          </select>
        }
      />
      <SettingsActionRow
        title="Base URL"
        description={t("settings.baseUrlDesc")}
        control={
          <input
            className="settings-inline-input"
            value={draft.baseUrl}
            onChange={(event) => onDraftChange({ ...draft, baseUrl: event.currentTarget.value })}
          />
        }
      />
      <SettingsActionRow
        title="Model"
        description={
          availableModels.length > 0
            ? `${t("settings.modelDescFetchedPrefix")} ${availableModels.length} ${t("settings.modelDescFetchedMid")} ${enabledModels.length} ${t("settings.modelDescFetchedSuffix")}`
            : t("settings.modelDescDefault")
        }
        control={
          <div className="settings-model-input">
            <input
              className="settings-inline-input"
              list="settings-model-options"
              value={draft.model}
              onChange={(event) => onDraftChange({ ...draft, model: event.currentTarget.value })}
            />
            <datalist id="settings-model-options">
              {modelInputOptions.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </div>
        }
      />
      <SettingsActionRow
        title={t("settings.visionModelTitle")}
        description={t("settings.visionModelDesc")}
        control={
          <div className="settings-model-input">
            <input
              className="settings-inline-input"
              list="settings-vision-model-options"
              value={draft.visionModel}
              placeholder={t("settings.visionModelPlaceholder")}
              onChange={(event) => onDraftChange({ ...draft, visionModel: event.currentTarget.value })}
            />
            <datalist id="settings-vision-model-options">
              <option value="" />
              {availableModels.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </div>
        }
      />
      <SettingsActionRow
        title={t("settings.fetchModelsTitle")}
        description={t("settings.fetchModelsDesc")}
        control={
          <button type="button" className="settings-secondary-btn" disabled={fetchingModels} onClick={onFetchModels}>
            {fetchingModels ? t("settings.fetching") : t("settings.fetchModels")}
          </button>
        }
      />
      <div className="settings-model-manager">
        <div className="settings-model-manager-head">
          <span>
            <strong>{t("settings.enabledModelsTitle")}</strong>
            <small>
              {t("settings.enabledModelsDesc")}
            </small>
          </span>
          <em>{enabledModels.length}/{availableModels.length}</em>
        </div>
        {currentModelMissing && (
          <p className="settings-model-warning">
            {t("settings.modelMissingPrefix")}{currentModel}{t("settings.modelMissingSuffix")}
          </p>
        )}
        {availableModels.length === 0 ? (
          <p className="settings-model-empty">{t("settings.modelEmpty")}</p>
        ) : (
          <div className="settings-model-list" role="list" aria-label={t("settings.enableModelListLabel")}>
            {availableModels.map((model) => {
              const isCurrent = model === currentModel;
              return (
                <label key={model} className="settings-model-option" data-current={isCurrent}>
                  <input
                    type="checkbox"
                    checked={enabledSet.has(model) || isCurrent}
                    disabled={saving || isCurrent}
                    onChange={(event) => toggleEnabledModel(model, event.currentTarget.checked)}
                  />
                  <span>{model}</span>
                  {isCurrent && <em>{t("settings.modelCurrent")}</em>}
                </label>
              );
            })}
          </div>
        )}
      </div>
      <SettingsActionRow
        title="API Key"
        description={settings?.llm.apiKeyConfigured ? t("settings.apiKeyConfigured") : t("settings.apiKeyMissing")}
        control={
          <input
            className="settings-inline-input"
            type="password"
            value={draft.apiKey}
            placeholder={settings?.llm.apiKeyConfigured ? t("settings.apiKeyKeepPlaceholder") : t("settings.apiKeyInputPlaceholder")}
            onChange={(event) => onDraftChange({ ...draft, apiKey: event.currentTarget.value })}
          />
        }
      />
      <SettingsActionRow
        title={t("settings.temperatureTitle")}
        description={t("settings.temperatureDesc")}
        control={
          <input
            className="settings-number-input"
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={draft.temperature}
            onChange={(event) => onDraftChange({ ...draft, temperature: Number(event.currentTarget.value) })}
          />
        }
      />
      <SettingsActionRow
        title={t("settings.timeoutTitle")}
        description={t("settings.timeoutDesc")}
        control={
          <input
            className="settings-number-input"
            type="number"
            min={1000}
            value={draft.timeoutMs}
            onChange={(event) => onDraftChange({ ...draft, timeoutMs: Number(event.currentTarget.value) })}
          />
        }
      />
      {draft.provider === "anthropic" && (
        <SettingsActionRow
          title={t("settings.maxTokensTitle")}
          description={t("settings.maxTokensDesc")}
          control={
            <input
              className="settings-number-input"
              type="number"
              min={256}
              step={256}
              value={draft.maxTokens}
              onChange={(event) => onDraftChange({ ...draft, maxTokens: Number(event.currentTarget.value) })}
            />
          }
        />
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

    <SettingsGroup title={t("settings.embeddingTitle")}>
      <SettingsActionRow
        title={t("settings.embeddingProviderTitle")}
        description={t("settings.embeddingProviderDesc")}
        control={
          <select
            className="settings-inline-select"
            value={draft.embeddingProvider}
            onChange={(event) => onDraftChange({ ...draft, embeddingProvider: event.currentTarget.value })}
          >
            <option value="off">{t("settings.embeddingProviderOff")}</option>
            <option value="openai">OpenAI Compatible</option>
          </select>
        }
      />
      {draft.embeddingProvider !== "off" && (
        <>
          <SettingsActionRow
            title={t("settings.embeddingModelTitle")}
            description={t("settings.embeddingModelDesc")}
            control={
              <input
                className="settings-inline-input"
                value={draft.embeddingModel}
                placeholder="nomic-embed-text"
                onChange={(event) => onDraftChange({ ...draft, embeddingModel: event.currentTarget.value })}
              />
            }
          />
          <SettingsActionRow
            title={t("settings.embeddingBaseUrlTitle")}
            description={t("settings.embeddingBaseUrlDesc")}
            control={
              <input
                className="settings-inline-input"
                value={draft.embeddingBaseUrl}
                placeholder="http://127.0.0.1:11434/v1"
                onChange={(event) => onDraftChange({ ...draft, embeddingBaseUrl: event.currentTarget.value })}
              />
            }
          />
          <SettingsActionRow
            title={t("settings.embeddingApiKeyTitle")}
            description={t("settings.embeddingApiKeyDesc")}
            control={
              <input
                className="settings-inline-input"
                type="password"
                value={draft.embeddingApiKey}
                placeholder={t("settings.apiKeyKeepPlaceholder")}
                onChange={(event) => onDraftChange({ ...draft, embeddingApiKey: event.currentTarget.value })}
              />
            }
          />
        </>
      )}
    </SettingsGroup>
    </>
  );
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
                <code className="memory-content" style={{ fontSize: 13 }}>{dir.dirPath}</code>
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
    temperature: settings?.llm.temperature ?? 0.7,
    timeoutMs: settings?.llm.timeoutMs ?? 120000,
    maxTokens: settings?.llm.maxTokens ?? 8192,
    commandExecutionEnabled: settings?.commandExecutionEnabled ?? false,
    mcpServersJson: settings?.mcpServersJson ?? "",
    cleanupPolicyDays: settings?.cleanupPolicyDays ?? 30,
    // 默认复用 LLM 配置（都是 OpenAI 兼容 API）
    embeddingProvider: settings?.embedding?.provider ?? "off",
    embeddingModel: settings?.embedding?.model ?? "nomic-embed-text",
    embeddingBaseUrl: settings?.embedding?.baseUrl || settings?.llm.baseUrl || "",
    embeddingApiKey: "",
  };
}

export type { SettingsDraft };
