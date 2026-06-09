import { useEffect, useMemo, useState } from "react";
import type {
  DataStatusResponse,
  McpServerStatus,
  RuntimeSettings,
  ToolDescriptor,
} from "@aurevoy/shared";

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
    label: "个人",
    items: [
      { id: "general", label: "常规", icon: "sliders" },
      { id: "appearance", label: "外观", icon: "appearance" },
      { id: "provider", label: "模型配置", icon: "spark" },
    ],
  },
  {
    label: "集成",
    items: [
      { id: "mcp", label: "MCP 服务器", icon: "server" },
      { id: "tools", label: "工具", icon: "tools" },
    ],
  },
  {
    label: "数据",
    items: [{ id: "data", label: "本地数据", icon: "database" }],
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
    <section className="settings-workspace" aria-label="设置">
      <aside className="sidebar settings-nav" aria-label="设置分类">
        <div className="sidebar-brand settings-nav-brand">
          <img className="sidebar-brand-logo" src="/aurevoy-wordmark.svg" alt="Aurevoy" />
        </div>

        <button type="button" className="sidebar-action settings-back" onClick={onClose}>
          返回应用
        </button>

        <input
          className="settings-search"
          value={query}
          placeholder="搜索设置..."
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
              刷新
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
      <SettingsChoiceGroup title="工作模式">
        <div className="settings-card-choice-grid">
          <label className="settings-choice-card" data-active="true">
            <span>
              <strong>适用于编程</strong>
              <small>保留更多技术细节、工具状态和执行轨迹</small>
            </span>
            <input type="radio" checked readOnly />
          </label>
          <label className="settings-choice-card">
            <span>
              <strong>适用于日常工作</strong>
              <small>更少技术细节，优先展示结论</small>
            </span>
            <input type="radio" disabled />
          </label>
        </div>
      </SettingsChoiceGroup>

      <SettingsGroup title="权限">
        <SettingsSwitchRow
          title="命令执行边界"
          description="启用后，Agent 才能在沙箱策略内执行命令。默认关闭，不会伪造执行能力。"
          checked={draft.commandExecutionEnabled}
          onChange={(checked) => onDraftChange({ ...draft, commandExecutionEnabled: checked })}
        />
        <SettingsActionRow
          title="工作区目录"
          description="内置文件工具只应访问该目录边界内的内容。"
          control={
            <input
              className="settings-inline-input"
              value={draft.workspaceDir}
              onChange={(event) => onDraftChange({ ...draft, workspaceDir: event.currentTarget.value })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="常规">
        <SettingsSelectRow
          title="默认清理策略"
          description="用于数据页的一键清理默认天数。"
          value={String(draft.cleanupPolicyDays)}
          options={[
            { value: "7", label: "7 天" },
            { value: "30", label: "30 天" },
            { value: "90", label: "90 天" },
            { value: "365", label: "365 天" },
          ]}
          onChange={(value) => onDraftChange({ ...draft, cleanupPolicyDays: Number(value) })}
        />
        <SettingsInfoRow
          title="本地数据库"
          description={dataStatus?.dbPath ?? settings?.dbPath ?? "未连接"}
        />
        <SettingsActionRow
          title="保存运行设置"
          description="保存模型、工作区、MCP、命令执行和清理策略。"
          control={
            <button
              type="button"
              className="settings-primary-btn"
              disabled={saving}
              onClick={() => onSave(draft)}
            >
              {saving ? "保存中" : "保存设置"}
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
    <SettingsGroup title="外观">
      <SettingsActionRow
        title="字体比例"
        description="调整对话、设置和工具界面的整体文字密度。"
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
      <SettingsInfoRow title="主题" description="跟随系统浅色/深色模式。" />
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
    <SettingsGroup title="模型配置">
      <SettingsActionRow
        title="Base URL"
        description="OpenAI-compatible API endpoint。"
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
            ? `已获取 ${availableModels.length} 个模型，主界面启用 ${enabledModels.length} 个。`
            : "Agent runtime 调用的默认模型。"
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
        title="获取模型列表"
        description="只在点击时从当前 Base URL/API Key 拉取一次，并保存为可管理的模型清单。"
        control={
          <button type="button" className="settings-secondary-btn" disabled={fetchingModels} onClick={onFetchModels}>
            {fetchingModels ? "获取中" : "获取模型"}
          </button>
        }
      />
      <div className="settings-model-manager">
        <div className="settings-model-manager-head">
          <span>
            <strong>主界面可选模型</strong>
            <small>
              勾选后才会出现在对话输入框的模型菜单中。当前模型保持勾选，避免被隐藏。
            </small>
          </span>
          <em>{enabledModels.length}/{availableModels.length}</em>
        </div>
        {currentModelMissing && (
          <p className="settings-model-warning">
            当前模型 “{currentModel}” 不在最近一次获取的模型列表中，请确认 Base URL/API Key 或重新获取。
          </p>
        )}
        {availableModels.length === 0 ? (
          <p className="settings-model-empty">还没有获取模型列表。</p>
        ) : (
          <div className="settings-model-list" role="list" aria-label="可启用模型">
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
                  {isCurrent && <em>当前</em>}
                </label>
              );
            })}
          </div>
        )}
      </div>
      <SettingsActionRow
        title="API Key"
        description={settings?.llm.apiKeyConfigured ? "已配置，留空不修改。" : "未配置模型密钥。"}
        control={
          <input
            className="settings-inline-input"
            type="password"
            value={draft.apiKey}
            placeholder={settings?.llm.apiKeyConfigured ? "保持现有密钥" : "输入 API Key"}
            onChange={(event) => onDraftChange({ ...draft, apiKey: event.currentTarget.value })}
          />
        }
      />
      <SettingsActionRow
        title="采样温度"
        description="控制模型输出的稳定性。"
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
        title="请求超时"
        description="模型调用超时时间，单位毫秒。"
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
        title="保存模型配置"
        description="写入后端运行时设置。"
        control={
          <button
            type="button"
            className="settings-primary-btn"
            disabled={saving}
            onClick={() => onSave(draft)}
          >
            {saving ? "保存中" : "保存"}
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
      <SettingsGroup title="MCP 服务器">
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
            保存 MCP 配置
          </button>
        </div>
      </SettingsGroup>

      <SettingsGroup title="连接状态">
        {mcpServers.length === 0 ? (
          <SettingsInfoRow title="未配置 MCP server" description="保存配置后，启动期会连接并注册工具。" />
        ) : (
          mcpServers.map((server) => (
            <SettingsInfoRow
              key={server.name}
              title={server.name}
              description={`tools: ${server.registeredTools}${server.error ? ` / ${server.error}` : ""}`}
              value={server.connected ? "已连接" : server.enabled ? "失败" : "停用"}
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
    <SettingsGroup title="工具管理">
      {tools.length === 0 ? (
        <SettingsInfoRow title="未发现可用工具" description="Agent 后端未返回工具目录。" />
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
      <SettingsGroup title="本地存储">
        <SettingsInfoRow title="SQLite" description={dataStatus?.dbPath ?? settings?.dbPath ?? "未连接"} />
        <SettingsInfoRow
          title="任务 / 轨迹 / 记忆"
          description={
            dataStatus
              ? `${dataStatus.counts.tasks} / ${dataStatus.counts.traces} / ${dataStatus.counts.memories}`
              : "未连接"
          }
        />
      </SettingsGroup>

      <SettingsGroup title="数据清理">
        <SettingsActionRow
          title="清理终态任务"
          description="只清理早于指定天数的终态任务和轨迹。"
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
                清理
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
  return "内置";
}

export type { SettingsDraft };
