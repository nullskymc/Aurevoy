import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LlmProviderSlot, RuntimeSettings } from "@aurevoy/shared";
import { t } from "../i18n";
import "./ModelSelectorDrawer.css";

export interface ModelSelectorDraft {
  provider: string;
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

const POPOVER_GAP = 8;
const VIEWPORT_MARGIN = 12;
const POPOVER_FALLBACK_WIDTH = 280;
const POPOVER_MIN_WIDTH = 248;
const POPOVER_MAX_WIDTH = 320;
const POPOVER_MAX_HEIGHT = 420;
const POPOVER_MIN_HEIGHT = 180;

interface PopoverPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

interface SelectableModel {
  provider: string;
  model: string;
  key: string;
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
  const activeProvider = settings?.llm.provider ?? parseProviderLabel(provider);
  const currentModel = settings?.llm.model ?? parseProviderModel(provider);
  const groups = useMemo(
    () => buildModelGroups(settings),
    [settings],
  );
  const totalModels = groups.reduce((sum, group) => sum + group.models.length, 0);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<PopoverPosition | null>(null);

  const computePosition = useCallback(() => {
    const anchor = anchorRef?.current;
    if (!anchor) return;
    const anchorRect = anchor.getBoundingClientRect();
    const popoverRect = popoverRef.current?.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const anchorWidth = Math.ceil(anchorRect.width);
    const popoverWidth = Math.max(
      POPOVER_MIN_WIDTH,
      Math.min(POPOVER_MAX_WIDTH, anchorWidth + 24, popoverRect?.width ?? POPOVER_FALLBACK_WIDTH),
    );
    const measuredHeight = popoverRect?.height ?? POPOVER_MAX_HEIGHT;
    const availableAbove = anchorRect.top - VIEWPORT_MARGIN - POPOVER_GAP;
    const availableBelow = viewportHeight - anchorRect.bottom - VIEWPORT_MARGIN - POPOVER_GAP;
    const openAbove = availableAbove >= Math.min(measuredHeight, POPOVER_MIN_HEIGHT)
      || availableAbove >= availableBelow;
    const availableHeight = Math.max(
      POPOVER_MIN_HEIGHT,
      Math.min(POPOVER_MAX_HEIGHT, openAbove ? availableAbove : availableBelow),
    );
    const renderedHeight = Math.min(measuredHeight, availableHeight);
    const preferredLeft = anchorRect.left;
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(preferredLeft, viewportWidth - popoverWidth - VIEWPORT_MARGIN),
    );
    const top = openAbove
      ? anchorRect.top - POPOVER_GAP - renderedHeight
      : anchorRect.bottom + POPOVER_GAP;

    setPos({
      left,
      top: Math.max(VIEWPORT_MARGIN, Math.min(top, viewportHeight - renderedHeight - VIEWPORT_MARGIN)),
      width: popoverWidth,
      maxHeight: availableHeight,
    });
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    computePosition();
  }, [computePosition, open, totalModels, currentModel, activeProvider]);

  useEffect(() => {
    if (!open) return;
    computePosition();

    function handlePointerDown(event: globalThis.PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      onClose();
    }

    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", computePosition);
    window.addEventListener("scroll", computePosition, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", computePosition);
      window.removeEventListener("scroll", computePosition, { capture: true });
    };
  }, [anchorRef, onClose, open, computePosition]);

  if (!open) return null;

  return (
    <div
      ref={popoverRef}
      className="model-popover"
      role="dialog"
      aria-label={t("model.dialogLabel")}
      style={pos ? { left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight } : undefined}
    >
      <div className="model-popover-main">
        <header className="model-popover-head">
          <p className="model-popover-title">{t("model.label")}</p>
          <span className="model-popover-provider">{activeProvider || t("composer.providerUnconfigured")}</span>
        </header>
        {totalModels === 0 ? (
          <p className="model-popover-empty">{t("model.empty")}</p>
        ) : (
          <div className="model-popover-list">
            {groups.map((group) => (
              <div key={group.provider} className="model-popover-group">
                {groups.length > 1 && (
                  <p className="model-popover-group-label">
                    <span>{group.provider}</span>
                    {!group.apiKeyConfigured && (
                      <em className="model-popover-group-warn">{t("model.providerNoKey")}</em>
                    )}
                  </p>
                )}
                {group.models.map((item) => {
                  const active = item.provider === activeProvider && item.model === currentModel;
                  const disabled = saving || active || !group.apiKeyConfigured;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      className="model-popover-item"
                      data-active={active}
                      disabled={disabled}
                      title={!group.apiKeyConfigured ? t("model.providerNoKeyHint") : undefined}
                      onClick={() => onSave({ provider: item.provider, model: item.model })}
                    >
                      <span className="model-popover-model">
                        <span className="model-popover-name">{item.model}</span>
                        {active && <span className="model-popover-current">{t("settings.modelCurrent")}</span>}
                      </span>
                      {active && <CheckIcon />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="model-popover-footer">
        <button type="button" className="model-popover-action" onClick={onOpenFullSettings}>
          {totalModels === 0 ? t("model.gotoEnable") : t("model.manage")}
        </button>
      </div>
    </div>
  );
}

function buildModelGroups(settings: RuntimeSettings | null): Array<{
  provider: string;
  apiKeyConfigured: boolean;
  models: SelectableModel[];
}> {
  if (!settings) return [];

  const slots: LlmProviderSlot[] = settings.llm.providers?.length
    ? settings.llm.providers
    : [{
        provider: settings.llm.provider,
        baseUrl: settings.llm.baseUrl,
        model: settings.llm.model,
        visionModel: settings.llm.visionModel,
        availableModels: settings.llm.availableModels,
        enabledModels: settings.llm.enabledModels,
        apiKeyConfigured: settings.llm.apiKeyConfigured,
      }];

  const groups: Array<{ provider: string; apiKeyConfigured: boolean; models: SelectableModel[] }> = [];

  for (const slot of slots) {
    const enabled = [...slot.enabledModels];
    // 保证当前模型始终可见
    if (
      slot.provider === settings.llm.provider &&
      settings.llm.model &&
      !enabled.includes(settings.llm.model)
    ) {
      enabled.unshift(settings.llm.model);
    } else if (slot.model && !enabled.includes(slot.model) && enabled.length === 0) {
      // 槽位只有 last model、尚未勾选 enabled 时，至少展示 last model
      enabled.push(slot.model);
    }
    if (enabled.length === 0) continue;
    groups.push({
      provider: slot.provider,
      apiKeyConfigured: slot.apiKeyConfigured,
      models: enabled.map((model) => ({
        provider: slot.provider,
        model,
        key: `${slot.provider}:${model}`,
      })),
    });
  }

  // 当前激活 provider 排前面
  groups.sort((a, b) => {
    if (a.provider === settings.llm.provider) return -1;
    if (b.provider === settings.llm.provider) return 1;
    return a.provider.localeCompare(b.provider);
  });

  return groups;
}

function parseProviderModel(provider?: string): string {
  if (!provider || provider === "unconfigured") return "";
  const [, model] = provider.split(/:(.*)/s);
  return model ?? provider;
}

function parseProviderLabel(provider?: string): string {
  if (!provider || provider === "unconfigured") return "";
  const [kind] = provider.split(/:(.*)/s);
  return kind || provider;
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
      <path d="M4.5 10.5l3.2 3.2L15.5 6" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
