import { useRef, type KeyboardEvent } from "react";
import { t } from "../i18n";

interface ComposerProps {
  value: string;
  busy: boolean;
  online: boolean | null;
  /** hero: 居中空状态的大输入框；docked: 对话底部的停靠输入框 */
  variant?: "hero" | "docked";
  provider?: string;
  /** 是否处于"编辑并重试"模式 */
  isEditing?: boolean;
  /** 取消编辑模式 */
  onCancelEdit?: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onOpenModelSelector: () => void;
  /** busy 时点击发送按钮触发停止/取消 */
  onStop?: () => void;
}

export function Composer({
  value,
  busy,
  online,
  variant = "hero",
  provider,
  isEditing,
  onCancelEdit,
  onChange,
  onSubmit,
  onOpenModelSelector,
  onStop,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const providerConfigured = provider !== "unconfigured";
  const canSend = value.trim().length > 0 && !busy && online !== false && providerConfigured;

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter 提交，Shift+Enter 换行
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSend) onSubmit();
    }
  }

  return (
    <div className="composer" data-variant={variant} data-editing={isEditing ? "true" : undefined}>
      {isEditing && (
        <div className="composer-edit-banner">
          <PencilEditIcon />
          <span>{t("composer.editMode")}</span>
          <button type="button" className="composer-edit-cancel" onClick={onCancelEdit}>
            {t("action.cancel")}
          </button>
        </div>
      )}
      <div className="composer-box">
        <textarea
          ref={textareaRef}
          className="composer-input"
          value={value}
          placeholder={t("composer.placeholder")}
          rows={variant === "hero" ? 2 : 1}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />

        <div className="composer-toolbar">
          <div className="composer-tools-left">
            <button type="button" className="composer-icon-btn" title={t("composer.attachmentDisabled")} aria-label={t("composer.attachment")} disabled>
              <PlusIcon />
            </button>
            <button
              type="button"
              className="composer-chip"
              title={t("composer.selectModel")}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onOpenModelSelector}
            >
              <GearIcon />
              <span>{provider ? (provider === "unconfigured" ? t("composer.providerUnconfigured") : provider) : t("composer.providerDisconnected")}</span>
            </button>
          </div>

          <div className="composer-tools-right">
            <span className="composer-engine" data-online={String(online)}>
              <span className="composer-engine-dot" />
              {online === null ? t("composer.engineChecking") : online ? t("composer.engineOnline") : t("composer.engineOffline")}
            </span>
            <button
              type="button"
              className="composer-send"
              disabled={busy ? !onStop : !canSend}
              onClick={busy ? onStop : onSubmit}
              aria-label={busy ? t("action.stop") : isEditing ? t("composer.sendEdit") : t("composer.send")}
              title={
                busy
                  ? t("composer.stopHint")
                  : !value.trim()
                    ? t("composer.sendHintEmpty")
                    : online === false
                      ? t("composer.sendHintOffline")
                      : !providerConfigured
                        ? t("composer.sendHintUnconfigured")
                        : t("composer.sendHintReady")
              }
            >
              {busy ? <StopDot /> : <ArrowUpIcon />}
            </button>
          </div>
        </div>
      </div>

      <div className="composer-footer">
        <span className="composer-footer-item">
          <FolderIcon />
          Aurevoy
        </span>
        <span className="composer-footer-item">
          <ScreenIcon />
          {t("composer.localMode")}
        </span>
        {provider === "unconfigured" && (
          <button
            type="button"
            className="composer-footer-link"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onOpenModelSelector}
          >
            {t("composer.configureModel")}
          </button>
        )}
      </div>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <path
        d="M10 4.5v11M4.5 10h11"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PencilEditIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
      <path d="M4 14.5l-.6 2.6 2.6-.6L16 6.5a1.5 1.5 0 00-2.1-2.1L4 14.5z" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinejoin="round" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
      <path
        d="M10 12.6a2.6 2.6 0 100-5.2 2.6 2.6 0 000 5.2z"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M10 2.5l1 1.9 2.1-.3.4 2.1 1.9 1-1 1.9 1 1.9-1.9 1-.4 2.1-2.1-.3-1 1.9-1-1.9-2.1.3-.4-2.1-1.9-1 1-1.9-1-1.9 1.9-1 .4-2.1 2.1.3 1-1.9z"
        stroke="currentColor"
        strokeWidth="1.1"
        fill="none"
        strokeLinejoin="round"
        opacity="0"
      />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <path
        d="M10 15.5v-11M5 9.5L10 4.5l5 5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StopDot() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
      <rect x="6" y="6" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
      <path
        d="M3 6.5c0-.8.6-1.4 1.4-1.4h2.8l1.4 1.6h5.6c.8 0 1.4.6 1.4 1.4v5.4c0 .8-.6 1.4-1.4 1.4H4.4c-.8 0-1.4-.6-1.4-1.4V6.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ScreenIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
      <rect x="3" y="4" width="14" height="9" rx="1.4" stroke="currentColor" strokeWidth="1.3" fill="none" />
      <path d="M7.5 16.5h5M10 13.5v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
