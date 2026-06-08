import { useEffect, useState } from "react";
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
  open: boolean;
  settings: RuntimeSettings | null;
  tools: ToolDescriptor[];
  mcpServers: McpServerStatus[];
  dataStatus: DataStatusResponse | null;
  saving: boolean;
  onClose: () => void;
  onSave: (draft: SettingsDraft) => void;
  onToggleTool: (name: string, enabled: boolean) => void;
  onCleanup: (olderThanDays: number) => void;
  onRefresh: () => void;
}

export function SettingsPanel({
  open,
  settings,
  tools,
  mcpServers,
  dataStatus,
  saving,
  onClose,
  onSave,
  onToggleTool,
  onCleanup,
  onRefresh,
}: SettingsPanelProps) {
  const [draft, setDraft] = useState<SettingsDraft>(() => makeDraft(settings));
  const [cleanupDays, setCleanupDays] = useState(settings?.cleanupPolicyDays ?? 30);

  useEffect(() => {
    setDraft(makeDraft(settings));
    setCleanupDays(settings?.cleanupPolicyDays ?? 30);
  }, [settings]);

  return (
    <>
      <div className="drawer-overlay" data-open={open} onClick={onClose} aria-hidden={!open} />
      <aside className="inspector memory-drawer" data-open={open} aria-label="设置" aria-hidden={!open}>
        <header className="inspector-head">
          <h2>设置</h2>
          <button type="button" className="inspector-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        <div className="inspector-content">
          <section className="inspector-section">
            <div className="inspector-label-row">
              <p className="inspector-label">模型与工作区</p>
              <button type="button" className="memory-link" onClick={onRefresh}>
                刷新
              </button>
            </div>
            <label className="memory-source">Base URL</label>
            <input
              className="memory-edit-input"
              value={draft.baseUrl}
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
            />
            <label className="memory-source">Model</label>
            <input
              className="memory-edit-input"
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            />
            <label className="memory-source">API Key</label>
            <input
              className="memory-edit-input"
              type="password"
              value={draft.apiKey}
              placeholder={settings?.llm.apiKeyConfigured ? "已配置，留空不修改" : "未配置"}
              onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            />
            <label className="memory-source">工作区目录</label>
            <input
              className="memory-edit-input"
              value={draft.workspaceDir}
              onChange={(e) => setDraft({ ...draft, workspaceDir: e.target.value })}
            />
            <label className="memory-toggle">
              <input
                type="checkbox"
                checked={draft.commandExecutionEnabled}
                onChange={(e) => setDraft({ ...draft, commandExecutionEnabled: e.target.checked })}
              />
              <span>启用命令执行边界</span>
            </label>
            <div className="memory-edit-actions">
              <button type="button" className="memory-add-btn" disabled={saving} onClick={() => onSave(draft)}>
                保存设置
              </button>
            </div>
          </section>

          <section className="inspector-section">
            <p className="inspector-label">MCP servers</p>
            <textarea
              className="memory-edit-input"
              rows={7}
              value={draft.mcpServersJson}
              onChange={(e) => setDraft({ ...draft, mcpServersJson: e.target.value })}
            />
            {mcpServers.length === 0 ? (
              <p className="inspector-empty">未配置 MCP server</p>
            ) : (
              <div className="trace-list">
                {mcpServers.map((server) => (
                  <article key={server.name} className="trace-item" data-kind={server.connected ? "done" : "error"}>
                    <header>
                      <strong>{server.name}</strong>
                      <span>{server.connected ? "已连接" : server.enabled ? "失败" : "停用"}</span>
                    </header>
                    <p>
                      tools: {server.registeredTools}
                      {server.error ? ` / ${server.error}` : ""}
                    </p>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="inspector-section">
            <div className="inspector-label-row">
              <p className="inspector-label">工具管理</p>
              <span className="inspector-count">{tools.length}</span>
            </div>
            <div className="tool-list">
              {tools.map((tool) => (
                <article key={tool.name} className="tool-item">
                  <strong>{tool.name}</strong>
                  <p>{tool.description}</p>
                  <label className="memory-toggle">
                    <input
                      type="checkbox"
                      checked={tool.enabled !== false}
                      onChange={(e) => onToggleTool(tool.name, e.target.checked)}
                    />
                    <span>
                      {tool.enabled === false ? "停用" : "启用"} · {tool.riskLevel ?? "safe"} · {sourceLabel(tool)}
                    </span>
                  </label>
                </article>
              ))}
            </div>
          </section>

          <section className="inspector-section">
            <p className="inspector-label">数据管理</p>
            <dl className="meta-list">
              <div>
                <dt>SQLite</dt>
                <dd>{dataStatus?.dbPath ?? settings?.dbPath ?? "未连接"}</dd>
              </div>
              <div>
                <dt>任务 / 轨迹 / 记忆</dt>
                <dd>
                  {dataStatus
                    ? `${dataStatus.counts.tasks} / ${dataStatus.counts.traces} / ${dataStatus.counts.memories}`
                    : "未连接"}
                </dd>
              </div>
            </dl>
            <label className="memory-source">清理多少天以前的终态任务</label>
            <input
              className="memory-edit-input"
              type="number"
              min={1}
              max={3650}
              value={cleanupDays}
              onChange={(e) => setCleanupDays(Number(e.target.value))}
            />
            <div className="memory-edit-actions">
              <button type="button" className="ghost-btn" onClick={() => onCleanup(cleanupDays)}>
                清理
              </button>
            </div>
          </section>
        </div>
      </aside>
    </>
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
