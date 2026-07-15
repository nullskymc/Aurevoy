import { useEffect, useState } from "react";
import { t } from "../../i18n";
import type { SettingsPanelProps, SettingsSectionId } from "./types";
import type { SettingsDraft } from "./types";
import { makeDraft } from "./draft";
import { getSettingsGroups, normalizeSettingsSection, SettingsNavIcon } from "./nav";
import { GeneralSettings } from "./GeneralSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { ProviderSettings } from "./ProviderSettings";
import { ModelsSettings } from "./ModelsSettings";
import { McpSettings } from "./McpSettings";
import { DataSettings } from "./DataSettings";
import { MemorySettings } from "./MemorySettings";
import { KbSettings } from "./KbSettings";
import { SearchSettings } from "./SearchSettings";
import { UsageSettings } from "./UsageSettings";
import "../SettingsPanel.css";
// MemorySettings / KbSettings 复用 memory-* class；设置入口不挂载 MemoryPanel，需显式引入样式
import "../MemoryPanel.css";

export type { SettingsDraft } from "./types";
export type { SettingsPanelProps } from "./types";

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
  onSaveSlotImageInputModels,
  onSaveSlotAvailableModels,
  onSelectModel,
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
  onNotice,
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
              onDraftChange={setDraft}
              onSaveConnection={onSaveConnection}
              onRemoveProvider={onRemoveProvider}
              onRefreshSettings={onRefresh}
              onNotice={onNotice}
            />
          )}

          {activeSection === "models" && (
            <ModelsSettings
              settings={settings}
              saving={saving}
              fetchingModels={fetchingModels}
              onFetchModelsForProvider={onFetchModelsForProvider}
              onSaveSlotEnabledModels={onSaveSlotEnabledModels}
              onSaveSlotImageInputModels={onSaveSlotImageInputModels}
              onSaveSlotAvailableModels={onSaveSlotAvailableModels}
              onSelectModel={onSelectModel}
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
            <KbSettings settings={settings} />
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
