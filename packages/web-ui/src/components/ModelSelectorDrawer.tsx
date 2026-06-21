import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeSettings } from "@aurevoy/shared";
import { t } from "../i18n";

export interface ModelSelectorDraft {
  model: string;
}

interface ModelSelectorDrawerProps {
  open: boolean;
  provider?: string;
  settings: RuntimeSettings | null;
  saving: boolean;
  anchorRef?: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onOpenFullSettings: () => void;
  onSave: (draft: ModelSelectorDraft) => void;
}

export function ModelSelectorDrawer({
  open,
  provider,
  settings,
  saving,
  anchorRef,
  onClose,
  onOpenFullSettings,
  onSave,
}: ModelSelectorDrawerProps) {
  const currentModel = settings?.llm.model ?? parseProviderModel(provider);
  const models = settings?.llm.enabledModels ?? [];
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

  const computePosition = useCallback(() => {
    const anchor = anchorRef?.current;
    const container = popoverRef.current?.parentElement;
    if (!anchor || !container) return;
    const anchorRect = anchor.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    setPos({
      left: anchorRect.left - containerRect.left,
      bottom: containerRect.bottom - anchorRect.top + 4,
    });
  }, [anchorRef]);

  useEffect(() => {
    if (!open) return;
    computePosition();

    function handlePointerDown(event: globalThis.PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target)) return;
      onClose();
    }

    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", computePosition);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", computePosition);
    };
  }, [onClose, open, computePosition]);

  if (!open) return null;

  return (
    <div
      ref={popoverRef}
      className="model-popover"
      role="dialog"
      aria-label={t("model.dialogLabel")}
      style={pos ? { left: pos.left, bottom: pos.bottom } : undefined}
    >
      <div className="model-popover-section">
        <p className="model-popover-label">{t("model.label")}</p>
        {models.length === 0 ? (
          <p className="model-popover-empty">{t("model.empty")}</p>
        ) : (
          <div className="model-popover-list">
            {models.map((model) => (
              <button
                key={model}
                type="button"
                className="model-popover-item"
                data-active={model === currentModel}
                disabled={saving || model === currentModel}
                onClick={() => onSave({ model })}
              >
                <span>{model}</span>
                {model === currentModel && <CheckIcon />}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="model-popover-footer">
        <button type="button" className="model-popover-action" onClick={onOpenFullSettings}>
          {models.length === 0 ? t("model.gotoEnable") : t("model.manage")}
        </button>
      </div>
    </div>
  );
}

function parseProviderModel(provider?: string): string {
  if (!provider || provider === "unconfigured") return "";
  const [, model] = provider.split(/:(.*)/s);
  return model ?? provider;
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
      <path d="M4.5 10.5l3.2 3.2L15.5 6" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
