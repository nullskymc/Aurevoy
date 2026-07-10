import { useEffect, useRef, useState } from "react";
import type { OauthAuthEvent, OauthAuthPrompt, OauthSessionSnapshot } from "@aurevoy/shared";
import { t } from "../../i18n";
import {
  cancelOauthSession,
  getOauthSession,
  logoutOauthProvider,
  respondOauthSession,
  startOauthLogin,
} from "../../api";
import { usePlatform } from "../../platform/context";

export function OauthLoginPanel({
  provider,
  oauthLabel,
  oauthConfigured,
  disabled,
  onAuthChanged,
  onNotice,
}: {
  provider: string;
  oauthLabel?: string;
  oauthConfigured: boolean;
  disabled?: boolean;
  onAuthChanged: () => void;
  /** 全局 Toast / 顶部提示 */
  onNotice?: (message: string) => void;
}) {
  const platform = usePlatform();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  /** 本会话内登录成功后保持成功态，避免 refresh 前 UI 仍显示未配置 */
  const [loginSucceeded, setLoginSucceeded] = useState(false);
  const [session, setSession] = useState<OauthSessionSnapshot | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [authLink, setAuthLink] = useState<{ url: string; label: string } | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const openedUrls = useRef(new Set<string>());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastEventCount = useRef(0);
  const successNotified = useRef(false);

  const effectivelyConfigured = oauthConfigured || loginSucceeded;

  useEffect(() => {
    // 外部 settings 刷新后 oauthConfigured 变为 true 时，同步本地成功态
    if (oauthConfigured) setLoginSucceeded(true);
  }, [oauthConfigured]);

  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, []);

  function stopPolling(): void {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function openAuthUrl(url: string): void {
    try {
      void platform.openExternal?.(url);
    } catch {
      // ignore
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function handleNewEvents(events: OauthAuthEvent[]): void {
    const fresh = events.slice(lastEventCount.current);
    lastEventCount.current = events.length;
    for (const event of fresh) {
      if (event.type === "auth_url" && event.url) {
        setAuthLink({ url: event.url, label: t("settings.oauthOpenBrowserLink") });
        setStatusText(event.instructions || t("settings.oauthOpenBrowser"));
        if (!openedUrls.current.has(event.url)) {
          openedUrls.current.add(event.url);
          openAuthUrl(event.url);
        }
      }
      if (event.type === "device_code") {
        setDeviceCode(event.userCode);
        setAuthLink({
          url: event.verificationUri,
          label: t("settings.oauthOpenDeviceLink"),
        });
        setStatusText(`${t("settings.oauthDeviceCode")}: ${event.userCode}`);
        if (event.verificationUri && !openedUrls.current.has(event.verificationUri)) {
          openedUrls.current.add(event.verificationUri);
          openAuthUrl(event.verificationUri);
        }
      }
      if (event.type === "progress") {
        setStatusText(event.message);
      }
    }
  }

  function markSuccess(): void {
    setLoginSucceeded(true);
    setBusy(false);
    setAuthLink(null);
    setDeviceCode(null);
    setError(null);
    setStatusText(t("settings.oauthLoginSuccessDetail"));
    setPromptValue("");
    if (!successNotified.current) {
      successNotified.current = true;
      onNotice?.(t("settings.oauthLoginSuccess"));
    }
    onAuthChanged();
  }

  function applySnapshot(next: OauthSessionSnapshot): void {
    setSession(next);
    handleNewEvents(next.events);

    if (next.status === "awaiting_input") {
      stopPolling();
      setBusy(false);
      return;
    }

    if (next.status === "running") {
      setBusy(true);
      if (!pollRef.current) {
        startPolling(next.sessionId);
      }
      return;
    }

    if (next.status === "done") {
      stopPolling();
      markSuccess();
      return;
    }

    if (next.status === "error") {
      stopPolling();
      setBusy(false);
      setLoginSucceeded(false);
      setError(next.error || t("settings.oauthLoginFailed"));
      onNotice?.(next.error || t("settings.oauthLoginFailed"));
      return;
    }

    if (next.status === "cancelled") {
      stopPolling();
      setBusy(false);
      setAuthLink(null);
      setDeviceCode(null);
      setStatusText(t("settings.oauthLoginCancelled"));
    }
  }

  function startPolling(sessionId: string): void {
    stopPolling();
    pollRef.current = setInterval(() => {
      void getOauthSession(sessionId)
        .then(applySnapshot)
        .catch((err) => {
          stopPolling();
          setBusy(false);
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
          onNotice?.(msg);
        });
    }, 800);
  }

  async function handleLogin(): Promise<void> {
    setError(null);
    setStatusText(null);
    setPromptValue("");
    setAuthLink(null);
    setDeviceCode(null);
    setLoginSucceeded(false);
    successNotified.current = false;
    openedUrls.current.clear();
    lastEventCount.current = 0;
    setBusy(true);
    try {
      const started = await startOauthLogin(provider);
      applySnapshot(started);
    } catch (err) {
      setBusy(false);
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      onNotice?.(msg);
    }
  }

  function allowsEmptySubmit(prompt: OauthAuthPrompt | undefined): boolean {
    if (!prompt) return false;
    return prompt.type === "text" || prompt.type === "manual_code";
  }

  async function handleRespond(): Promise<void> {
    if (!session?.pendingPrompt) return;
    const prompt = session.pendingPrompt;
    const value = promptValue;
    if (!allowsEmptySubmit(prompt) && !value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const next = await respondOauthSession(session.sessionId, value.trim());
      setPromptValue("");
      applySnapshot(next);
    } catch (err) {
      setBusy(false);
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      onNotice?.(msg);
    }
  }

  async function handleSelectOption(id: string): Promise<void> {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const next = await respondOauthSession(session.sessionId, id);
      applySnapshot(next);
    } catch (err) {
      setBusy(false);
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      onNotice?.(msg);
    }
  }

  async function handleCancel(): Promise<void> {
    if (!session) return;
    try {
      const next = await cancelOauthSession(session.sessionId);
      applySnapshot(next);
    } catch {
      stopPolling();
      setBusy(false);
      setSession(null);
    }
  }

  async function handleLogout(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await logoutOauthProvider(provider);
      setSession(null);
      setAuthLink(null);
      setDeviceCode(null);
      setLoginSucceeded(false);
      successNotified.current = false;
      setStatusText(t("settings.oauthLoggedOut"));
      onNotice?.(t("settings.oauthLoggedOut"));
      onAuthChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      onNotice?.(msg);
    } finally {
      setBusy(false);
    }
  }

  const pending = session?.pendingPrompt;
  const inFlight = session?.status === "running" || session?.status === "awaiting_input";
  const inputLocked = busy && session?.status !== "awaiting_input";
  const canSubmitEmpty = allowsEmptySubmit(pending);
  const canSubmit = canSubmitEmpty || promptValue.trim().length > 0;
  const showSuccessBanner = loginSucceeded && !inFlight && !error;

  return (
    <div className="settings-modal-field settings-oauth-panel">
      <span>{oauthLabel || t("settings.oauthLoginTitle")}</span>
      <small>
        {effectivelyConfigured
          ? t("settings.oauthConfigured")
          : t("settings.oauthLoginDesc")}
      </small>

      {showSuccessBanner && (
        <div className="settings-oauth-success" role="status" aria-live="polite">
          <span className="settings-oauth-success-icon" aria-hidden="true">
            ✓
          </span>
          <div className="settings-oauth-success-body">
            <strong>{t("settings.oauthLoginSuccess")}</strong>
            <small>{t("settings.oauthLoginSuccessDetail")}</small>
          </div>
        </div>
      )}

      <div className="settings-oauth-actions">
        {!inFlight && (
          <button
            type="button"
            className="settings-primary-btn"
            disabled={disabled || busy}
            onClick={() => void handleLogin()}
          >
            {busy
              ? t("settings.oauthLoggingIn")
              : effectivelyConfigured
                ? t("settings.oauthReLogin")
                : t("settings.oauthLoginButton")}
          </button>
        )}
        {inFlight && (
          <button
            type="button"
            className="settings-secondary-btn"
            disabled={disabled}
            onClick={() => void handleCancel()}
          >
            {t("settings.oauthCancel")}
          </button>
        )}
        {effectivelyConfigured && !inFlight && (
          <button
            type="button"
            className="settings-secondary-btn"
            disabled={disabled || busy}
            onClick={() => void handleLogout()}
          >
            {t("settings.oauthLogout")}
          </button>
        )}
      </div>

      {inFlight && statusText && !showSuccessBanner && (
        <p className="settings-oauth-status">{statusText}</p>
      )}
      {deviceCode && inFlight && (
        <p className="settings-oauth-device-code">
          <strong>{t("settings.oauthDeviceCode")}</strong>
          {" "}
          <code>{deviceCode}</code>
        </p>
      )}
      {authLink && inFlight && (
        <div className="settings-oauth-link-row">
          <a
            className="settings-oauth-open-link"
            href={authLink.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => {
              event.preventDefault();
              openAuthUrl(authLink.url);
            }}
          >
            {authLink.label}
          </a>
          <button
            type="button"
            className="settings-primary-btn"
            onClick={() => openAuthUrl(authLink.url)}
          >
            {t("settings.oauthOpenNow")}
          </button>
        </div>
      )}
      {error && <p className="settings-oauth-error">{error}</p>}

      {pending && session?.status === "awaiting_input" && (
        <OauthPromptForm
          prompt={pending}
          value={promptValue}
          locked={inputLocked}
          canSubmit={canSubmit}
          onChange={setPromptValue}
          onSubmit={() => void handleRespond()}
          onSelect={(id) => void handleSelectOption(id)}
        />
      )}
    </div>
  );
}

function OauthPromptForm({
  prompt,
  value,
  locked,
  canSubmit,
  onChange,
  onSubmit,
  onSelect,
}: {
  prompt: OauthAuthPrompt;
  value: string;
  locked: boolean;
  canSubmit: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onSelect: (id: string) => void;
}) {
  if (prompt.type === "select") {
    return (
      <div className="settings-oauth-prompt">
        <small>{prompt.message}</small>
        <div className="settings-oauth-select-options">
          {prompt.options.map((option) => (
            <button
              key={option.id}
              type="button"
              className="settings-secondary-btn"
              disabled={locked}
              onClick={() => onSelect(option.id)}
              title={option.description}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const emptyHint =
    prompt.type === "text" && /blank|留空|empty/i.test(prompt.message)
      ? t("settings.oauthBlankOk")
      : null;

  return (
    <div className="settings-oauth-prompt">
      <small>{prompt.message}</small>
      {emptyHint && <small className="settings-oauth-blank-hint">{emptyHint}</small>}
      <input
        className="settings-modal-input"
        type={prompt.type === "secret" ? "password" : "text"}
        value={value}
        placeholder={prompt.placeholder ?? (emptyHint ? t("settings.oauthBlankPlaceholder") : undefined)}
        disabled={locked}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && canSubmit) onSubmit();
        }}
      />
      <button
        type="button"
        className="settings-primary-btn"
        disabled={locked || !canSubmit}
        onClick={onSubmit}
      >
        {t("settings.oauthSubmit")}
      </button>
    </div>
  );
}
