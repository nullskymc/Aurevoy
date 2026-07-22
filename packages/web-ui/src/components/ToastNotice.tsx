import * as Toast from "@radix-ui/react-toast";
import { t } from "../i18n";

export type ToastTone = "info" | "success" | "error";

export interface ToastNoticePayload {
  message: string;
  tone?: ToastTone;
}

/** 统一由 Radix 管理自动关闭、可访问播报和键盘交互。 */
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
  return (
    <Toast.Provider duration={durationMs} swipeDirection="right">
      <Toast.Root
        className="toast-bubble"
        data-tone={tone}
        open
        onOpenChange={(nextOpen) => !nextOpen && onClose()}
      >
        <Toast.Description>{message}</Toast.Description>
        <Toast.Close asChild>
          <button type="button" className="toast-close" aria-label={t("a11y.closeNotice")}>×</button>
        </Toast.Close>
      </Toast.Root>
      <Toast.Viewport className="toast-viewport" />
    </Toast.Provider>
  );
}
