import { useMemo, useState } from "react";
import type { McpServerStatus } from "@aurevoy/shared";
import { t } from "../../i18n";
import type { SettingsDraft } from "./types";
import {
  emptyMcpServerDraft,
  mcpServerEndpointLabel,
  parseMcpServersJson,
  removeMcpServer,
  setMcpServerEnabled,
  stringifyMcpServersJson,
  upsertMcpServer,
  type McpServerDraft,
  type McpTransport,
} from "./mcpConfig";
import { IconSettings, IconTrash } from "../../icons";

type View =
  | { mode: "list" }
  | { mode: "edit"; originalName?: string; draft: McpServerDraft };

export function McpSettings({
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
  onSave: (draft: SettingsDraft, options?: { silent?: boolean }) => void | Promise<void>;
}) {
  const [view, setView] = useState<View>({ mode: "list" });
  const [formError, setFormError] = useState<string | null>(null);

  const parsed = useMemo(() => {
    try {
      return { servers: parseMcpServersJson(draft.mcpServersJson), error: null as string | null };
    } catch (err) {
      return {
        servers: [] as McpServerDraft[],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }, [draft.mcpServersJson]);

  const statusByName = useMemo(() => {
    const map = new Map<string, McpServerStatus>();
    for (const s of mcpServers) map.set(s.name, s);
    return map;
  }, [mcpServers]);

  function commitServers(next: McpServerDraft[], options?: { silent?: boolean }) {
    const json = stringifyMcpServersJson(next);
    const nextDraft = { ...draft, mcpServersJson: json };
    onDraftChange(nextDraft);
    return onSave(nextDraft, options);
  }

  async function handleToggle(name: string, enabled: boolean) {
    if (parsed.error) {
      setFormError(parsed.error);
      return;
    }
    setFormError(null);
    await commitServers(setMcpServerEnabled(parsed.servers, name, enabled));
  }

  async function handleRemove(name: string) {
    if (parsed.error) {
      setFormError(parsed.error);
      return;
    }
    if (!window.confirm(t("settings.mcpConfirmRemove").replace("{name}", name))) return;
    setFormError(null);
    await commitServers(removeMcpServer(parsed.servers, name));
    setView({ mode: "list" });
  }

  async function handleSaveEditor() {
    if (view.mode !== "edit") return;
    try {
      const base = parsed.error ? [] : parsed.servers;
      if (parsed.error && draft.mcpServersJson.trim()) {
        throw new Error(parsed.error);
      }
      const servers = upsertMcpServer(base, view.draft, view.originalName);
      setFormError(null);
      await commitServers(servers);
      setView({ mode: "list" });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  }

  if (view.mode === "edit") {
    return (
      <McpServerEditor
        value={view.draft}
        isNew={!view.originalName}
        saving={saving}
        error={formError}
        onChange={(next) => setView({ mode: "edit", originalName: view.originalName, draft: next })}
        onBack={() => {
          setFormError(null);
          setView({ mode: "list" });
        }}
        onRemove={
          view.originalName
            ? () => void handleRemove(view.originalName!)
            : undefined
        }
        onSave={() => void handleSaveEditor()}
      />
    );
  }

  return (
    <section className="settings-content-group mcp-section">
      <div className="mcp-section-head">
        <h2>{t("settings.mcpServers")}</h2>
        <button
          type="button"
          className="mcp-add-btn"
          disabled={saving || Boolean(parsed.error)}
          onClick={() => {
            setFormError(null);
            setView({ mode: "edit", draft: emptyMcpServerDraft() });
          }}
        >
          {t("settings.mcpAdd")}
        </button>
      </div>

      <div className="mcp-card">
        {parsed.error ? (
          <div className="mcp-empty">
            <strong>{t("settings.mcpParseError")}</strong>
            <p>{parsed.error}</p>
          </div>
        ) : parsed.servers.length === 0 ? (
          <div className="mcp-empty">
            <strong>{t("settings.mcpEmptyTitle")}</strong>
            <p>{t("settings.mcpEmptyDesc")}</p>
          </div>
        ) : (
          <ul className="mcp-server-list">
            {parsed.servers.map((server) => {
              const status = statusByName.get(server.name);
              const connected = status?.connected === true;
              const tools = status?.registeredTools ?? 0;
              const err = status?.error;
              const transportLabel =
                server.transport === "streamable-http"
                  ? t("settings.mcpTransportHttp")
                  : t("settings.mcpTransportStdio");
              const endpoint = mcpServerEndpointLabel(server);
              const statusLine = !server.enabled
                ? t("settings.mcpDisabledHint")
                : err
                  ? err
                  : connected
                    ? `${t("settings.connected")} · ${tools} ${t("settings.mcpTools")}`
                    : t("settings.failed");
              const subtitle = `${transportLabel} · ${endpoint} · ${statusLine}`;

              return (
                <li key={server.name} className="mcp-server-row">
                  <div className="mcp-server-text">
                    <span className="mcp-server-name">{server.name}</span>
                    <span
                      className={
                        !server.enabled
                          ? "mcp-server-sub is-muted"
                          : err
                            ? "mcp-server-sub is-error"
                            : "mcp-server-sub"
                      }
                      title={subtitle}
                    >
                      {subtitle}
                    </span>
                  </div>
                  <div className="mcp-server-actions">
                    <button
                      type="button"
                      className="mcp-gear-btn"
                      aria-label={t("settings.mcpEdit")}
                      title={t("settings.mcpEdit")}
                      disabled={saving}
                      onClick={() => {
                        setFormError(null);
                        setView({ mode: "edit", originalName: server.name, draft: { ...server } });
                      }}
                    >
                      <IconSettings size={18} />
                    </button>
                    <label className="mcp-switch" title={server.enabled ? t("settings.mcpDisable") : t("settings.mcpEnable")}>
                      <input
                        type="checkbox"
                        checked={server.enabled}
                        disabled={saving}
                        onChange={(e) => void handleToggle(server.name, e.currentTarget.checked)}
                      />
                      <span className="mcp-switch-ui" aria-hidden="true" />
                    </label>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {formError ? <p className="mcp-error" role="alert">{formError}</p> : null}
      </div>
    </section>
  );
}

function McpServerEditor({
  value,
  isNew,
  saving,
  error,
  onChange,
  onBack,
  onRemove,
  onSave,
}: {
  value: McpServerDraft;
  isNew: boolean;
  saving: boolean;
  error: string | null;
  onChange: (next: McpServerDraft) => void;
  onBack: () => void;
  onRemove?: () => void;
  onSave: () => void;
}) {
  function setTransport(transport: McpTransport) {
    if (transport === value.transport) return;
    onChange({
      ...value,
      transport,
      // 切换类型时保留 name/enabled，清空对方字段的脏数据不强行抹掉（便于误切回）
    });
  }

  const isHttp = value.transport === "streamable-http";

  return (
    <section className="settings-content-group mcp-section">
      <button type="button" className="mcp-back-btn" onClick={onBack}>
        ← {t("settings.mcpBack")}
      </button>
      <h2 className="mcp-editor-title">{isNew ? t("settings.mcpAddTitle") : t("settings.mcpEditTitle")}</h2>
      <p className="mcp-hint mcp-hint-block">{t("settings.mcpFormHint")}</p>

      <div className="mcp-card mcp-form-card">
        <label className="mcp-field">
          <span>{t("settings.mcpFieldName")}</span>
          <input
            className="settings-input"
            type="text"
            value={value.name}
            placeholder={t("settings.mcpFieldNamePh")}
            onChange={(e) => onChange({ ...value, name: e.currentTarget.value })}
          />
        </label>

        <div className="mcp-field">
          <span>{t("settings.mcpFieldTransport")}</span>
          <div className="mcp-transport-tabs" role="group" aria-label={t("settings.mcpFieldTransport")}>
            <button
              type="button"
              className={`mcp-transport-tab${value.transport === "stdio" ? " is-active" : ""}`}
              onClick={() => setTransport("stdio")}
            >
              {t("settings.mcpTransportStdio")}
            </button>
            <button
              type="button"
              className={`mcp-transport-tab${isHttp ? " is-active" : ""}`}
              onClick={() => setTransport("streamable-http")}
            >
              {t("settings.mcpTransportHttp")}
            </button>
          </div>
        </div>

        {isHttp ? (
          <>
            <label className="mcp-field">
              <span>{t("settings.mcpFieldUrl")}</span>
              <input
                className="settings-input"
                type="url"
                value={value.url}
                placeholder={t("settings.mcpFieldUrlPh")}
                onChange={(e) => onChange({ ...value, url: e.currentTarget.value })}
                spellCheck={false}
              />
            </label>

            <div className="mcp-field">
              <span>{t("settings.mcpFieldHeaders")}</span>
              <p className="mcp-hint">{t("settings.mcpFieldHeadersHint")}</p>
              <div className="mcp-kv-list">
                {value.headers.map((pair, index) => (
                  <div key={index} className="mcp-kv-row mcp-env-row">
                    <input
                      className="settings-input"
                      type="text"
                      value={pair.key}
                      placeholder={t("settings.mcpHeaderKey")}
                      onChange={(e) => {
                        const headers = [...value.headers];
                        headers[index] = { ...headers[index]!, key: e.currentTarget.value };
                        onChange({ ...value, headers });
                      }}
                      spellCheck={false}
                    />
                    <input
                      className="settings-input"
                      type="text"
                      value={pair.value}
                      placeholder={t("settings.mcpHeaderValue")}
                      onChange={(e) => {
                        const headers = [...value.headers];
                        headers[index] = { ...headers[index]!, value: e.currentTarget.value };
                        onChange({ ...value, headers });
                      }}
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="mcp-row-remove"
                      aria-label={t("settings.mcpRemoveRow")}
                      onClick={() =>
                        onChange({ ...value, headers: value.headers.filter((_, i) => i !== index) })
                      }
                    >
                      <IconTrash size={16} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="mcp-add-row"
                  onClick={() =>
                    onChange({ ...value, headers: [...value.headers, { key: "", value: "" }] })
                  }
                >
                  {t("settings.mcpAddHeader")}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <label className="mcp-field">
              <span>{t("settings.mcpFieldCommand")}</span>
              <input
                className="settings-input"
                type="text"
                value={value.command}
                placeholder={t("settings.mcpFieldCommandPh")}
                onChange={(e) => onChange({ ...value, command: e.currentTarget.value })}
                spellCheck={false}
              />
            </label>

            <div className="mcp-field">
              <span>{t("settings.mcpFieldArgs")}</span>
              <div className="mcp-kv-list">
                {value.args.map((arg, index) => (
                  <div key={index} className="mcp-kv-row">
                    <input
                      className="settings-input"
                      type="text"
                      value={arg}
                      onChange={(e) => {
                        const args = [...value.args];
                        args[index] = e.currentTarget.value;
                        onChange({ ...value, args });
                      }}
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="mcp-row-remove"
                      aria-label={t("settings.mcpRemoveRow")}
                      onClick={() =>
                        onChange({ ...value, args: value.args.filter((_, i) => i !== index) })
                      }
                    >
                      <IconTrash size={16} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="mcp-add-row"
                  onClick={() => onChange({ ...value, args: [...value.args, ""] })}
                >
                  {t("settings.mcpAddArg")}
                </button>
              </div>
            </div>

            <div className="mcp-field">
              <span>{t("settings.mcpFieldEnv")}</span>
              <div className="mcp-kv-list">
                {value.env.map((pair, index) => (
                  <div key={index} className="mcp-kv-row mcp-env-row">
                    <input
                      className="settings-input"
                      type="text"
                      value={pair.key}
                      placeholder={t("settings.mcpEnvKey")}
                      onChange={(e) => {
                        const env = [...value.env];
                        env[index] = { ...env[index]!, key: e.currentTarget.value };
                        onChange({ ...value, env });
                      }}
                      spellCheck={false}
                    />
                    <input
                      className="settings-input"
                      type="text"
                      value={pair.value}
                      placeholder={t("settings.mcpEnvValue")}
                      onChange={(e) => {
                        const env = [...value.env];
                        env[index] = { ...env[index]!, value: e.currentTarget.value };
                        onChange({ ...value, env });
                      }}
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="mcp-row-remove"
                      aria-label={t("settings.mcpRemoveRow")}
                      onClick={() =>
                        onChange({ ...value, env: value.env.filter((_, i) => i !== index) })
                      }
                    >
                      <IconTrash size={16} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="mcp-add-row"
                  onClick={() => onChange({ ...value, env: [...value.env, { key: "", value: "" }] })}
                >
                  {t("settings.mcpAddEnv")}
                </button>
              </div>
            </div>

            <label className="mcp-field">
              <span>{t("settings.mcpFieldCwd")}</span>
              <input
                className="settings-input"
                type="text"
                value={value.cwd}
                placeholder={t("settings.mcpFieldCwdPh")}
                onChange={(e) => onChange({ ...value, cwd: e.currentTarget.value })}
                spellCheck={false}
              />
            </label>
          </>
        )}

        <label className="mcp-field mcp-switch-field">
          <span>{t("settings.mcpFieldEnabled")}</span>
          <span className="mcp-switch">
            <input
              type="checkbox"
              checked={value.enabled}
              onChange={(e) => onChange({ ...value, enabled: e.currentTarget.checked })}
            />
            <span className="mcp-switch-ui" aria-hidden="true" />
          </span>
        </label>

        {error ? <p className="mcp-error" role="alert">{error}</p> : null}

        <div className="mcp-editor-actions">
          {onRemove ? (
            <button type="button" className="mcp-danger-btn" disabled={saving} onClick={onRemove}>
              {t("settings.mcpRemove")}
            </button>
          ) : (
            <span />
          )}
          <button type="button" className="settings-primary-btn" disabled={saving} onClick={onSave}>
            {saving ? t("settings.saving") : t("settings.mcpSaveServer")}
          </button>
        </div>
      </div>
    </section>
  );
}


