import { useRef, type KeyboardEvent } from "react";

interface ComposerProps {
  value: string;
  busy: boolean;
  online: boolean | null;
  /** hero: 居中空状态的大输入框；docked: 对话底部的停靠输入框 */
  variant?: "hero" | "docked";
  provider?: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}

export function Composer({
  value,
  busy,
  online,
  variant = "hero",
  provider,
  onChange,
  onSubmit,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSend = value.trim().length > 0 && !busy && online !== false;

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter 提交，Shift+Enter 换行
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSend) onSubmit();
    }
  }

  return (
    <div className="composer" data-variant={variant}>
      <div className="composer-box">
        <textarea
          ref={textareaRef}
          className="composer-input"
          value={value}
          placeholder="随心输入，告诉 Aurevoy 你想完成什么"
          rows={variant === "hero" ? 2 : 1}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />

        <div className="composer-toolbar">
          <div className="composer-tools-left">
            <button type="button" className="composer-icon-btn" title="附加" aria-label="附加">
              <PlusIcon />
            </button>
            <button type="button" className="composer-chip" title="Provider">
              <GearIcon />
              <span>{provider ?? "未连接"}</span>
            </button>
          </div>

          <div className="composer-tools-right">
            <span className="composer-engine" data-online={String(online)}>
              <span className="composer-engine-dot" />
              {online === null ? "检测中" : online ? "本地引擎在线" : "引擎离线"}
            </span>
            <button
              type="button"
              className="composer-send"
              disabled={!canSend}
              onClick={onSubmit}
              aria-label="发送"
              title="发送 (Enter)"
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
          本地模式
        </span>
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
