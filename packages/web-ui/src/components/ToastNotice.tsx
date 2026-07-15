import { useEffect } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";

export type ToastTone = "info" | "success" | "error";

export interface ToastNoticePayload {
  message: string;
  tone?: ToastTone;
}

export function ToastNotice({
  message,
  tone = "info",
  onClose,
  durationMs = 4200,
}: {
  message: string;
  tone?: ToastTone;
  onClose: () => void;
  durationMs?: number;
}) {
  useEffect(() => {
    if (durationMs <= 0) return;
    const timer = window.setTimeout(onClose, durationMs);
    return () => window.clearTimeout(timer);
  }, [message, tone, durationMs, onClose]);

  return createPortal(
    <div className="toast-bubble" data-tone={tone} role="status" aria-live="polite">
      <span>{message}</span>
      <button type="button" className="toast-close" onClick={onClose} aria-label={t("a11y.closeNotice")}>
        ×
      </button>
    </div>,
    document.body,
  );
}
