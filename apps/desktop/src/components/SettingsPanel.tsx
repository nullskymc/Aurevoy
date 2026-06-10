import { useEffect, useMemo, useState } from "react";
import type {
  DataStatusResponse,
  McpServerStatus,
  RuntimeSettings,
  ToolDescriptor,
} from "@aurevoy/shared";
import { t } from "../i18n";

interface SettingsDraft {
  baseUrl: string;
  model: string;
  apiKey: string;
  workspaceDir: string;
  temperature: number;
  timeoutMs: number;
  commandExecutionEnabled: boolean;
  mcpServersJson: string;
  cleanupPolicyDays: number;
}

interface SettingsPanelProps {
  settings: RuntimeSettings | null;
  tools: ToolDescriptor[];
  mcpServers: McpServerStatus[];
  dataStatus: DataStatusResponse | null;
  saving: boolean;
  fetchingModels: boolean;
  fontScale: number;
  initialSection?: SettingsSectionId;
  onClose: () => void;
  onSave: (draft: SettingsDraft) => void;
  onToggleTool: (name: string, enabled: boolean) => void;
  onCleanup: (olderThanDays: number) => void;
  onRefresh: () => void;
  onFetchModels: () => void;
  onSaveEnabledModels: (models: string[]) => void;
  onFontScaleChange: (scale: number) => void;
}

type SettingsSectionId = "general" | "appearance" | "provider" | "mcp" | "tools" | "data";

const SETTINGS_GROUPS: Array<{
  label: string;
  items: Array<{ id: SettingsSectionId; label: string; icon: SettingsIconName }>;
}> = [
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
      { id: "tools", label: t("settings.nav.tools"), icon: "tools" },
    ],
  },
  {
    label: t("settings.group.data"),
    items: [{ id: "data", label: t("settings.nav.data"), icon: "database" }],
  },
];

type SettingsIconName = "appearance" | "database" | "server" | "sliders" | "spark" | "tools";

export function SettingsPanel({
  settings,
  tools,
  mcpServers,
  dataStatus,
  saving,
  fetchingModels,
  fontScale,
  initialSection = "general",
  onClose,
  onSave,
  onToggleTool,
  onCleanup,
  onRefresh,
  onFetchModels,
  onSaveEnabledModels,
  onFontScaleChange,
}: SettingsPanelProps) {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(initialSection);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<SettingsDraft>(() => makeDraft(settings));
  const [cleanupDays, setCleanupDays] = useState(settings?.cleanupPolicyDays ?? 30);

  useEffect(() => {
    setDraft(makeDraft(settings));
    setCleanupDays(settings?.cleanupPolicyDays ?? 30);
  }, [settings]);

  useEffect(() => {
    setActiveSection(initialSection);
  }, [initialSection]);

  const visibleGroups = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return SETTINGS_GROUPS;
    return SETTINGS_GROUPS
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => item.label.toLowerCase().includes(normalized)),
      }))
      .filter((group) => group.items.length > 0);
  }, [query]);

  const activeTitle = SETTINGS_GROUPS.flatMap((group) => group.items).find(
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
              onDraftChange={setDraft}
              onSave={onSave}
            />
          )}

          {activeSection === "appearance" && (
            <AppearanceSettings fontScale={fontScale} onFontScaleChange={onFontScaleChange} />
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

          {activeSection === "tools" && <ToolSettings tools={tools} onToggleTool={onToggleTool} />}

          {activeSection === "data" && (
            <DataSettings
              cleanupDays={cleanupDays}
              dataStatus={dataStatus}
              settings={settings}
              onCleanup={onCleanup}
              onCleanupDaysChange={setCleanupDays}
            />
          )}
        </div>
      </main>
    </section>
  );
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

  if (name === "tools") {
    return (
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
        <path
          d="M6.4 4.1l2.2 2.2-2.2 2.2-2.2-2.2 2.2-2.2zM13.6 4.1l2.2 2.2-2.2 2.2-2.2-2.2 2.2-2.2zM6.4 11.5l2.2 2.2-2.2 2.2-2.2-2.2 2.2-2.2zM13.6 11.5l2.2 2.2-2.2 2.2-2.2-2.2 2.2-2.2z"
          stroke="currentColor"
          strokeWidth="1.35"
          fill="none"
          strokeLinejoin="round"
        />
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
  onDraftChange,
  onSave,
}: {
  draft: SettingsDraft;
  dataStatus: DataStatusResponse | null;
  settings: RuntimeSettings | null;
  saving: boolean;
  onDraftChange: (draft: SettingsDraft) => void;
  onSave: (draft: SettingsDraft) => void;
}) {
  return (
    <>
      <SettingsChoiceGroup title={t("settings.workMode")}>
        <div className="settings-card-choice-grid">
          <label className="settings-choice-card" data-active="true">
            <span>
              <strong>{t("settings.workModeCodingTitle")}</strong>
              <small>{t("settings.workModeCodingDesc")}</small>
            </span>
            <input type="radio" checked readOnly />
          </label>
          <label className="settings-choice-card">
            <span>
              <strong>{t("settings.workModeDailyTitle")}</strong>
              <small>{t("settings.workModeDailyDesc")}</small>
            </span>
            <input type="radio" disabled />
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
      </SettingsGroup>
    </>
  );
}

function AppearanceSettings({
  fontScale,
  onFontScaleChange,
}: {
  fontScale: number;
  onFontScaleChange: (scale: number) => void;
}) {
  return (
    <SettingsGroup title={t("settings.appearance")}>
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
      <SettingsInfoRow title={t("settings.themeTitle")} description={t("settings.themeDesc")} />
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
    <SettingsGroup title={t("settings.providerConfig")}>
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

function ToolSettings({
  tools,
  onToggleTool,
}: {
  tools: ToolDescriptor[];
  onToggleTool: (name: string, enabled: boolean) => void;
}) {
  return (
    <SettingsGroup title={t("settings.toolMgmt")}>
      {tools.length === 0 ? (
        <SettingsInfoRow title={t("settings.toolEmptyTitle")} description={t("settings.toolEmptyDesc")} />
      ) : (
        tools.map((tool) => (
          <SettingsSwitchRow
            key={tool.name}
            title={tool.name}
            description={`${tool.description} · ${tool.riskLevel ?? "safe"} · ${sourceLabel(tool)}`}
            checked={tool.enabled !== false}
            onChange={(checked) => onToggleTool(tool.name, checked)}
          />
        ))
      )}
    </SettingsGroup>
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
    baseUrl: settings?.llm.baseUrl ?? "",
    model: settings?.llm.model ?? "",
    apiKey: "",
    workspaceDir: settings?.workspaceDir ?? "",
    temperature: settings?.llm.temperature ?? 0.7,
    timeoutMs: settings?.llm.timeoutMs ?? 120000,
    commandExecutionEnabled: settings?.commandExecutionEnabled ?? false,
    mcpServersJson: settings?.mcpServersJson ?? "",
    cleanupPolicyDays: settings?.cleanupPolicyDays ?? 30,
  };
}

function sourceLabel(tool: ToolDescriptor): string {
  if (tool.source?.type === "mcp") return `MCP:${tool.source.serverName}`;
  return t("settings.builtinTool");
}

export type { SettingsDraft };
