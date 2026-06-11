import { useEffect, useRef } from "react";
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
  onClose: () => void;
  onOpenFullSettings: () => void;
  onSave: (draft: ModelSelectorDraft) => void;
}

export function ModelSelectorDrawer({
  open,
  provider,
  settings,
  saving,
  onClose,
  onOpenFullSettings,
  onSave,
}: ModelSelectorDrawerProps) {
  const currentModel = settings?.llm.model ?? parseProviderModel(provider);
  const models = settings?.llm.enabledModels ?? [];
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

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
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div ref={popoverRef} className="model-popover" role="dialog" aria-label={t("model.dialogLabel")}>
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
