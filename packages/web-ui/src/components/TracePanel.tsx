import * as Dialog from "@radix-ui/react-dialog";
import type { TaskTraceEntry } from "@aurevoy/shared";
import { IconX } from "../icons";
import { t } from "../i18n";
import "./TracePanel.css";

export function TracePanel({
  open,
  traces,
  onOpenChange,
  onRefresh,
}: {
  open: boolean;
  traces: TaskTraceEntry[];
  onOpenChange: (open: boolean) => void;
  onRefresh: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="trace-panel-backdrop" />
        <Dialog.Content className="trace-panel">
          <header className="trace-panel__header">
            <div>
              <Dialog.Title>{t("trace.title")}</Dialog.Title>
              <Dialog.Description>{t("trace.description")}</Dialog.Description>
            </div>
            <button type="button" className="ghost-btn" onClick={onRefresh}>{t("trace.refresh")}</button>
            <Dialog.Close asChild>
              <button type="button" className="icon-btn" aria-label={t("a11y.closeNotice")}><IconX size={16} /></button>
            </Dialog.Close>
          </header>
          <div className="trace-panel__body">
            {traces.length === 0 ? (
              <p className="trace-panel__empty">{t("trace.empty")}</p>
            ) : [...traces].reverse().map((trace) => (
              <article className="trace-row" key={trace.id} data-ok={trace.ok === false ? "false" : "true"}>
                <span className="trace-row__kind">{trace.kind}</span>
                <div className="trace-row__main">
                  <strong>{trace.summary || trace.toolName || trace.phase || trace.kind}</strong>
                  <span>
                    {new Date(trace.startedAt).toLocaleTimeString()}
                    {typeof trace.durationMs === "number" ? ` · ${trace.durationMs} ms` : ""}
                    {trace.provider && trace.model ? ` · ${trace.provider}:${trace.model}` : ""}
                  </span>
                  {trace.errorMessage && <p>{trace.errorMessage}</p>}
                </div>
              </article>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
