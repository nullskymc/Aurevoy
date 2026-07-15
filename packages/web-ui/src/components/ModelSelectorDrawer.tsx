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
import type { ThinkingUILevel } from "./Composer";
import "./ModelSelectorDrawer.css";

export interface ModelSelectorDraft {
  provider: string;
  model: string;
}

export const THINKING_LEVELS: ThinkingUILevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

interface ModelSelectorDrawerProps {
  open: boolean;
  provider?: string;
  settings: RuntimeSettings | null;
  saving: boolean;
  anchorRef?: React.RefObject<HTMLButtonElement | null>;
  thinkingLevel?: ThinkingUILevel;
  onThinkingLevelChange?: (level: ThinkingUILevel) => void;
  onClose: () => void;
  onOpenFullSettings: () => void;
  onSave: (draft: ModelSelectorDraft) => void;
}

const POPOVER_GAP = 6;
const SUB_GAP = 4;
const VIEWPORT_MARGIN = 12;
const ROOT_WIDTH = 228;
const SUB_WIDTH = 200;
const SUB_MAX_HEIGHT = 320;
const SEARCH_THRESHOLD = 8;
/** 根 ↔ 子菜单之间的 hover 桥接延迟，避免闪断 */
const HOVER_LEAVE_MS = 160;

type SubPanel = "models" | "thinking" | null;

interface BoxPos {
  left: number;
  top: number;
  maxHeight?: number;
}

interface SelectableModel {
  provider: string;
  model: string;
  key: string;
}

interface ModelGroup {
  provider: string;
  credentialConfigured: boolean;
  models: SelectableModel[];
}

/** 触发芯片：短模型名 + 推理档（如 5.6 Terra 高） */
export function formatModelEffortChipLabel(
  modelId: string | undefined,
  thinkingLevel: ThinkingUILevel | undefined,
): string {
  const model = shortenModelLabel(modelId ?? "");
  const effort = thinkingLevelLabel(thinkingLevel ?? "medium");
  if (!model) return effort || t("model.dialogLabel");
  if (!effort || thinkingLevel === "off") return model;
  return `${model} ${effort}`;
}

export function shortenModelLabel(modelId: string): string {
  if (!modelId) return "";
  const base = modelId.split("/").pop() ?? modelId;
  return base
    .replace(/^gpt-?/i, "")
    .replace(/^o\d+/i, (m) => m)
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .trim() || base;
}

export function thinkingLevelLabel(level: ThinkingUILevel): string {
  switch (level) {
    case "off":
      return t("composer.thinking.off");
    case "minimal":
      return t("composer.thinking.minimal");
    case "low":
      return t("composer.thinking.low");
    case "medium":
      return t("composer.thinking.medium");
    case "high":
      return t("composer.thinking.high");
    case "xhigh":
      return t("composer.thinking.xhigh");
    default:
      return level;
  }
}

export function ModelSelectorDrawer({
  open,
  provider,
  settings,
  saving,
  anchorRef,
  thinkingLevel = "medium",
  onThinkingLevelChange,
  onClose,
  onOpenFullSettings,
  onSave,
}: ModelSelectorDrawerProps) {
  const activeProvider = settings?.llm.provider ?? parseProviderLabel(provider);
  const currentModel = settings?.llm.model ?? parseProviderModel(provider);
  const groups = useMemo(() => buildModelGroups(settings), [settings]);
  const totalModels = groups.reduce((sum, group) => sum + group.models.length, 0);
  const showSearch = totalModels > SEARCH_THRESHOLD;

  const [subPanel, setSubPanel] = useState<SubPanel>(null);
  const [query, setQuery] = useState("");
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const [rootPos, setRootPos] = useState<BoxPos | null>(null);
  const [subPos, setSubPos] = useState<BoxPos | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const subRef = useRef<HTMLDivElement | null>(null);
  const modelsRowRef = useRef<HTMLButtonElement | null>(null);
  const thinkingRowRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const leaveTimerRef = useRef<number | null>(null);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((group) => {
        const providerHit =
          providerLabel(group.provider).toLowerCase().includes(q) ||
          group.provider.toLowerCase().includes(q);
        const models = providerHit
          ? group.models
          : group.models.filter((item) => item.model.toLowerCase().includes(q));
        return { ...group, models };
      })
      .filter((group) => group.models.length > 0);
  }, [groups, query]);

  const flatItems = useMemo(
    () =>
      filteredGroups.flatMap((group) =>
        group.models.map((item) => ({
          ...item,
          credentialConfigured: group.credentialConfigured,
        })),
      ),
    [filteredGroups],
  );

  const currentKey =
    activeProvider && currentModel ? `${activeProvider}:${currentModel}` : null;

  const clearLeaveTimer = useCallback(() => {
    if (leaveTimerRef.current != null) {
      window.clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
  }, []);

  const scheduleCloseSub = useCallback(() => {
    clearLeaveTimer();
    leaveTimerRef.current = window.setTimeout(() => {
      setSubPanel(null);
      leaveTimerRef.current = null;
    }, HOVER_LEAVE_MS);
  }, [clearLeaveTimer]);

  const openSub = useCallback(
    (panel: SubPanel) => {
      clearLeaveTimer();
      setSubPanel(panel);
    },
    [clearLeaveTimer],
  );

  /** 根菜单只跟触发 chip 对齐，不因二级菜单开关位移 */
  const computeRootPosition = useCallback(() => {
    const anchor = anchorRef?.current;
    const root = rootRef.current;
    if (!anchor) return;
    const anchorRect = anchor.getBoundingClientRect();
    const rootRect = root?.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const rootHeight = rootRect?.height ?? 120;
    const rootWidth = rootRect?.width ?? ROOT_WIDTH;

    const availableAbove = anchorRect.top - VIEWPORT_MARGIN - POPOVER_GAP;
    const availableBelow =
      viewportHeight - anchorRect.bottom - VIEWPORT_MARGIN - POPOVER_GAP;
    const openAbove =
      availableAbove >= rootHeight || availableAbove >= availableBelow;

    const preferredLeft = anchorRect.right - rootWidth;
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(preferredLeft, viewportWidth - rootWidth - VIEWPORT_MARGIN),
    );
    const rawTop = openAbove
      ? anchorRect.top - POPOVER_GAP - rootHeight
      : anchorRect.bottom + POPOVER_GAP;
    const top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rawTop, viewportHeight - rootHeight - VIEWPORT_MARGIN),
    );

    setRootPos({ left, top });
  }, [anchorRef]);

  /** 二级菜单贴在对应行右侧（空间不足则左侧），顶边与该行对齐 */
  const computeSubPosition = useCallback(() => {
    if (!subPanel) {
      setSubPos(null);
      return;
    }
    const root = rootRef.current;
    const row =
      subPanel === "models" ? modelsRowRef.current : thinkingRowRef.current;
    const sub = subRef.current;
    if (!root || !row) return;

    const rootRect = root.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const subRect = sub?.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const subWidth = subRect?.width ?? SUB_WIDTH;
    const subHeight = subRect?.height ?? 180;

    const spaceRight = viewportWidth - rootRect.right - VIEWPORT_MARGIN - SUB_GAP;
    const openRight = spaceRight >= subWidth || spaceRight >= rootRect.left - VIEWPORT_MARGIN;
    const left = openRight
      ? Math.min(rootRect.right + SUB_GAP, viewportWidth - subWidth - VIEWPORT_MARGIN)
      : Math.max(VIEWPORT_MARGIN, rootRect.left - subWidth - SUB_GAP);

    // 与触发行顶对齐，再 clamp 进视口
    let top = rowRect.top;
    if (top + subHeight > viewportHeight - VIEWPORT_MARGIN) {
      top = Math.max(VIEWPORT_MARGIN, viewportHeight - VIEWPORT_MARGIN - subHeight);
    }
    if (top < VIEWPORT_MARGIN) top = VIEWPORT_MARGIN;

    const maxHeight = Math.min(
      SUB_MAX_HEIGHT,
      viewportHeight - top - VIEWPORT_MARGIN,
    );

    setSubPos({ left, top, maxHeight });
  }, [subPanel]);

  useLayoutEffect(() => {
    if (!open) {
      setRootPos(null);
      setSubPos(null);
      return;
    }
    computeRootPosition();
  }, [open, computeRootPosition, currentModel, thinkingLevel, totalModels]);

  useLayoutEffect(() => {
    if (!open || !subPanel) {
      setSubPos(null);
      return;
    }
    computeSubPosition();
    // 子菜单内容渲染后再量一次高度
    const raf = window.requestAnimationFrame(() => computeSubPosition());
    return () => window.cancelAnimationFrame(raf);
  }, [open, subPanel, computeSubPosition, filteredGroups.length, query, thinkingLevel]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setHighlightKey(null);
      setSubPanel(null);
      clearLeaveTimer();
      return;
    }
    setHighlightKey(currentKey);
  }, [open, currentKey, clearLeaveTimer]);

  useEffect(() => {
    if (!open || subPanel !== "models" || !showSearch) return;
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open, subPanel, showSearch]);

  useEffect(() => {
    if (!open || !highlightKey || subPanel !== "models") return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-key="${CSS.escape(highlightKey)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [open, highlightKey, filteredGroups, subPanel]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: globalThis.PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target)) return;
      if (subRef.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      onClose();
    }

    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        if (subPanel) {
          setSubPanel(null);
          return;
        }
        onClose();
        return;
      }
      if (subPanel !== "models" || flatItems.length === 0) return;

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const index = Math.max(
          0,
          flatItems.findIndex((item) => item.key === highlightKey),
        );
        const next =
          event.key === "ArrowDown"
            ? (index + 1) % flatItems.length
            : (index - 1 + flatItems.length) % flatItems.length;
        setHighlightKey(flatItems[next]!.key);
        return;
      }

      if (event.key === "Enter") {
        const item =
          flatItems.find((entry) => entry.key === highlightKey) ?? flatItems[0];
        if (!item || saving || !item.credentialConfigured) return;
        event.preventDefault();
        selectItem(item, item.credentialConfigured);
      }
    }

    function onResizeOrScroll(): void {
      computeRootPosition();
      computeSubPosition();
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", onResizeOrScroll);
    window.addEventListener("scroll", onResizeOrScroll, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", onResizeOrScroll);
      window.removeEventListener("scroll", onResizeOrScroll, { capture: true });
    };
  }, [
    anchorRef,
    onClose,
    open,
    flatItems,
    highlightKey,
    saving,
    subPanel,
    computeRootPosition,
    computeSubPosition,
  ]);

  if (!open) return null;

  function selectItem(item: SelectableModel, credentialConfigured: boolean): void {
    if (saving) return;
    if (!credentialConfigured) return;
    if (item.key !== currentKey) {
      onSave({ provider: item.provider, model: item.model });
    }
    // 选完保持根菜单，收起二级（仍可继续 hover）
    setSubPanel(null);
  }

  function selectThinking(level: ThinkingUILevel): void {
    onThinkingLevelChange?.(level);
    setSubPanel(null);
  }

  const modelDisplay = currentModel
    ? shortenModelLabel(currentModel)
    : t("model.empty");
  const thinkingDisplay = thinkingLevelLabel(thinkingLevel);

  return (
    <>
      <div
        ref={rootRef}
        className="model-menu-root model-menu-card"
        role="dialog"
        aria-label={t("model.dialogLabel")}
        style={
          rootPos
            ? { position: "fixed", left: rootPos.left, top: rootPos.top, zIndex: 40 }
            : { position: "fixed", visibility: "hidden", zIndex: 40 }
        }
        onMouseLeave={(event) => {
          // 移向二级菜单时不关
          const related = event.relatedTarget;
          if (related instanceof Node && subRef.current?.contains(related)) return;
          scheduleCloseSub();
        }}
      >
        <button
          ref={modelsRowRef}
          type="button"
          className="model-menu-nav-row"
          data-active={subPanel === "models" ? "true" : undefined}
          onMouseEnter={() => openSub("models")}
          onFocus={() => openSub("models")}
          onClick={() => openSub("models")}
        >
          <span className="model-menu-nav-label">{t("model.menu.model")}</span>
          <span className="model-menu-nav-value">
            <span className="model-menu-nav-value-text">{modelDisplay}</span>
            <span className="model-menu-nav-chevron" aria-hidden="true">
              ›
            </span>
          </span>
        </button>
        <button
          ref={thinkingRowRef}
          type="button"
          className="model-menu-nav-row"
          data-active={subPanel === "thinking" ? "true" : undefined}
          onMouseEnter={() => openSub("thinking")}
          onFocus={() => openSub("thinking")}
          onClick={() => openSub("thinking")}
        >
          <span className="model-menu-nav-label">{t("model.menu.effort")}</span>
          <span className="model-menu-nav-value">
            <span className="model-menu-nav-value-text">{thinkingDisplay}</span>
            <span className="model-menu-nav-chevron" aria-hidden="true">
              ›
            </span>
          </span>
        </button>
        {totalModels > 0 && (
          <div className="model-menu-foot">
            <button type="button" className="model-menu-link" onClick={onOpenFullSettings}>
              {t("model.manage")}
            </button>
          </div>
        )}
      </div>

      {subPanel === "models" && (
        <div
          ref={subRef}
          className="model-menu-sub model-menu-card"
          role="listbox"
          aria-label={t("model.menu.model")}
          style={
            subPos
              ? {
                  position: "fixed",
                  left: subPos.left,
                  top: subPos.top,
                  maxHeight: subPos.maxHeight,
                  zIndex: 41,
                }
              : { position: "fixed", visibility: "hidden", zIndex: 41 }
          }
          onMouseEnter={clearLeaveTimer}
          onMouseLeave={scheduleCloseSub}
        >
          <div className="model-menu-sub-title">{t("model.menu.model")}</div>
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
                  {groups.length > 1 && (
                    <div className="model-menu-group-label">
                      {providerLabel(group.provider)}
                    </div>
                  )}
                  {group.models.map((item) => {
                    const active = item.key === currentKey;
                    const highlighted = item.key === (highlightKey ?? currentKey);
                    const disabled = saving || !group.credentialConfigured;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        role="option"
                        aria-selected={active}
                        data-key={item.key}
                        data-active={active}
                        data-highlight={highlighted}
                        className="model-menu-item model-menu-item--check"
                        disabled={disabled && !active}
                        title={
                          !group.credentialConfigured
                            ? t("model.providerNoKeyHint")
                            : item.model
                        }
                        onMouseEnter={() => setHighlightKey(item.key)}
                        onClick={() => selectItem(item, group.credentialConfigured)}
                      >
                        <span className="model-menu-item-label">{item.model}</span>
                        {active && (
                          <span className="model-menu-check" aria-hidden="true">
                            ✓
                          </span>
                        )}
                      </button>
                    );
                  })}
                </section>
              ))
            )}
          </div>
        </div>
      )}

      {subPanel === "thinking" && (
        <div
          ref={subRef}
          className="model-menu-sub model-menu-card"
          role="listbox"
          aria-label={t("model.menu.effort")}
          style={
            subPos
              ? {
                  position: "fixed",
                  left: subPos.left,
                  top: subPos.top,
                  maxHeight: subPos.maxHeight,
                  zIndex: 41,
                }
              : { position: "fixed", visibility: "hidden", zIndex: 41 }
          }
          onMouseEnter={clearLeaveTimer}
          onMouseLeave={scheduleCloseSub}
        >
          <div className="model-menu-sub-title">{t("model.menu.effort")}</div>
          <div className="model-menu-body">
            {THINKING_LEVELS.map((level) => {
              const active = level === thinkingLevel;
              return (
                <button
                  key={level}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-active={active}
                  className="model-menu-item model-menu-item--check"
                  onClick={() => selectThinking(level)}
                >
                  <span className="model-menu-item-label">
                    {thinkingLevelLabel(level)}
                  </span>
                  {active && (
                    <span className="model-menu-check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

function buildModelGroups(settings: RuntimeSettings | null): ModelGroup[] {
  if (!settings) return [];

  const slots: LlmProviderSlot[] = settings.llm.providers?.length
    ? settings.llm.providers
    : [
        {
          provider: settings.llm.provider,
          baseUrl: settings.llm.baseUrl,
          model: settings.llm.model,
          availableModels: settings.llm.availableModels,
          enabledModels: settings.llm.enabledModels,
          imageInputModels: settings.llm.imageInputModels,
          apiKeyConfigured: settings.llm.apiKeyConfigured,
          oauthConfigured: settings.llm.oauthConfigured,
        },
      ];

  const groups: ModelGroup[] = [];

  for (const slot of slots) {
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
      credentialConfigured: Boolean(slot.apiKeyConfigured || slot.oauthConfigured),
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
