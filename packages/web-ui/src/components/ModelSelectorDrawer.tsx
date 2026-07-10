import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { LlmProviderSlot, RuntimeSettings } from "@aurevoy/shared";
import { t } from "../i18n";
import { providerLabel } from "./providerIcons";
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

const POPOVER_GAP = 6;
const VIEWPORT_MARGIN = 12;
const POPOVER_FALLBACK_WIDTH = 220;
const POPOVER_MIN_WIDTH = 180;
const POPOVER_MAX_WIDTH = 280;
const POPOVER_MAX_HEIGHT = 320;
const POPOVER_MIN_HEIGHT = 100;
/** 超过此数量才显示搜索框，保持菜单轻量 */
const SEARCH_THRESHOLD = 8;

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

interface ModelGroup {
  provider: string;
  apiKeyConfigured: boolean;
  models: SelectableModel[];
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
  const groups = useMemo(() => buildModelGroups(settings), [settings]);
  const totalModels = groups.reduce((sum, group) => sum + group.models.length, 0);
  const showSearch = totalModels > SEARCH_THRESHOLD;

  const [query, setQuery] = useState("");
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<PopoverPosition | null>(null);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((group) => {
        const providerHit = providerLabel(group.provider).toLowerCase().includes(q)
          || group.provider.toLowerCase().includes(q);
        const models = providerHit
          ? group.models
          : group.models.filter((item) => item.model.toLowerCase().includes(q));
        return { ...group, models };
      })
      .filter((group) => group.models.length > 0);
  }, [groups, query]);

  const flatItems = useMemo(
    () => filteredGroups.flatMap((group) => group.models.map((item) => ({
      ...item,
      apiKeyConfigured: group.apiKeyConfigured,
    }))),
    [filteredGroups],
  );

  const currentKey = activeProvider && currentModel
    ? `${activeProvider}:${currentModel}`
    : null;

  const computePosition = useCallback(() => {
    const anchor = anchorRef?.current;
    if (!anchor) return;
    const anchorRect = anchor.getBoundingClientRect();
    const popoverRect = popoverRef.current?.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    // 宽度贴近触发 chip，略宽一点避免模型 id 被裁切
    const popoverWidth = Math.max(
      POPOVER_MIN_WIDTH,
      Math.min(
        POPOVER_MAX_WIDTH,
        Math.max(anchorRect.width + 48, popoverRect?.width ?? POPOVER_FALLBACK_WIDTH),
      ),
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
    // 与触发按钮左对齐，偏菜单风格
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
  }, [computePosition, open, totalModels, currentModel, activeProvider, filteredGroups.length, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setHighlightKey(null);
      return;
    }
    setHighlightKey(currentKey);
    if (showSearch) {
      const timer = window.setTimeout(() => {
        searchRef.current?.focus();
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [open, currentKey, showSearch]);

  useEffect(() => {
    if (!open || !highlightKey) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(highlightKey)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [open, highlightKey, filteredGroups]);

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
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (flatItems.length === 0) return;

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const index = Math.max(0, flatItems.findIndex((item) => item.key === highlightKey));
        const next = event.key === "ArrowDown"
          ? (index + 1) % flatItems.length
          : (index - 1 + flatItems.length) % flatItems.length;
        setHighlightKey(flatItems[next]!.key);
        return;
      }

      if (event.key === "Enter") {
        const item = flatItems.find((entry) => entry.key === highlightKey) ?? flatItems[0];
        if (!item || saving) return;
        if (!item.apiKeyConfigured) return;
        if (item.key === currentKey) {
          onClose();
          return;
        }
        event.preventDefault();
        onSave({ provider: item.provider, model: item.model });
      }
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
  }, [
    anchorRef,
    onClose,
    open,
    computePosition,
    flatItems,
    highlightKey,
    saving,
    currentKey,
    onSave,
  ]);

  if (!open) return null;

  function selectItem(item: SelectableModel, apiKeyConfigured: boolean): void {
    if (saving) return;
    if (!apiKeyConfigured) return;
    if (item.key === currentKey) {
      onClose();
      return;
    }
    onSave({ provider: item.provider, model: item.model });
  }

  return (
    <div
      ref={popoverRef}
      className="model-menu"
      role="listbox"
      aria-label={t("model.dialogLabel")}
      style={pos ? { left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight } : undefined}
    >
      {showSearch && (
        <div className="model-menu-search">
          <input
            ref={searchRef}
            type="search"
            className="model-menu-search-input"
            value={query}
            placeholder={t("model.searchPlaceholder")}
            aria-label={t("model.searchPlaceholder")}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setHighlightKey(null);
            }}
          />
        </div>
      )}

      <div ref={listRef} className="model-menu-body">
        {totalModels === 0 ? (
          <div className="model-menu-empty">
            <p>{t("model.empty")}</p>
            <button type="button" className="model-menu-link" onClick={onOpenFullSettings}>
              {t("model.gotoEnable")}
            </button>
          </div>
        ) : filteredGroups.length === 0 ? (
          <div className="model-menu-empty">
            <p>{t("model.noMatch")}</p>
          </div>
        ) : (
          filteredGroups.map((group) => (
            <section key={group.provider} className="model-menu-group">
              <div className="model-menu-group-label">
                {providerLabel(group.provider)}
              </div>
              {group.models.map((item) => {
                const active = item.key === currentKey;
                const highlighted = item.key === (highlightKey ?? currentKey);
                const disabled = saving || !group.apiKeyConfigured;
                return (
                  <button
                    key={item.key}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-key={item.key}
                    data-active={active}
                    data-highlight={highlighted}
                    className="model-menu-item"
                    disabled={disabled && !active}
                    title={!group.apiKeyConfigured ? t("model.providerNoKeyHint") : item.model}
                    onMouseEnter={() => setHighlightKey(item.key)}
                    onClick={() => selectItem(item, group.apiKeyConfigured)}
                  >
                    {item.model}
                  </button>
                );
              })}
            </section>
          ))
        )}
      </div>

      {totalModels > 0 && (
        <div className="model-menu-foot">
          <button type="button" className="model-menu-link" onClick={onOpenFullSettings}>
            {t("model.manage")}
          </button>
        </div>
      )}
    </div>
  );
}

function buildModelGroups(settings: RuntimeSettings | null): ModelGroup[] {
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
        oauthConfigured: settings.llm.oauthConfigured,
      }];

  const groups: ModelGroup[] = [];

  for (const slot of slots) {
    // 只展示用户勾选的 enabled；激活槽额外保证当前主模型可见（便于回切），
    // 其它 Provider 允许 0 个勾选，则不出现在菜单中。
    const enabled = [...slot.enabledModels];
    if (
      slot.provider === settings.llm.provider &&
      settings.llm.model &&
      !enabled.includes(settings.llm.model)
    ) {
      enabled.unshift(settings.llm.model);
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

  groups.sort((a, b) => {
    if (a.provider === settings.llm.provider) return -1;
    if (b.provider === settings.llm.provider) return 1;
    return providerLabel(a.provider).localeCompare(providerLabel(b.provider));
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
