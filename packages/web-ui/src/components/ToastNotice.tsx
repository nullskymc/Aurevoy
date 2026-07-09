import { createPortal } from "react-dom";
import { t } from "../i18n";

export function ToastNotice({ message, onClose }: { message: string; onClose: () => void }) {
  return createPortal(
    <div className="toast-bubble" role="status">
      <span>{message}</span>
      <button type="button" className="toast-close" onClick={onClose} aria-label={t("a11y.closeNotice")}>
        ×
      </button>
    </div>,
    document.body,
  );
}
