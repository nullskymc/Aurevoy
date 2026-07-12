import { useEffect, useMemo, useState } from "react";
import type { RuntimeSettings } from "@aurevoy/shared";
import { filterChatModelIds, isChatModelId } from "@aurevoy/shared";
import { t } from "../../i18n";
import { ProviderIcon, providerLabel } from "../providerIcons";
import { catalogFor } from "./providerCatalog";
import { modelNamespace, parseModelNamespace } from "./modelNamespace";

export function ModelsSettings({
  settings,
  saving,
  fetchingModels,
  onFetchModelsForProvider,
  onSaveSlotEnabledModels,
  onSaveSlotAvailableModels,
  onSelectModel,
  onSaveVisionModel,
}: {
  settings: RuntimeSettings | null;
  saving: boolean;
  fetchingModels: boolean;
  onFetchModelsForProvider: (provider: string, options?: { silent?: boolean }) => void;
  onSaveSlotEnabledModels: (provider: string, models: string[]) => void;
  onSaveSlotAvailableModels: (provider: string, models: string[]) => void;
  onSelectModel: (provider: string, model: string) => void;
  onSaveVisionModel: (visionModel: string) => void;
}) {
  const [query, setQuery] = useState("");
  /** 本地乐观启用列表：取消勾选立即生效，不被 saving/回写时序弹回 */
  const [enabledLocal, setEnabledLocal] = useState<Record<string, string[]>>({});
  /** 各 provider 自定义模型输入框草稿 */
  const [customDraft, setCustomDraft] = useState<Record<string, string>>({});
  /** 展开的 provider 抽屉；默认只开当前激活槽 */
  const [openProviders, setOpenProviders] = useState<Record<string, boolean>>({});

  const providers = settings?.llm.providers ?? [];
  const activeProvider = settings?.llm.provider;
  const activeModel = settings?.llm.model ?? "";
  /** 全局视觉：namespace `provider:model` 或裸 id */
  const globalVision = settings?.llm.visionModel ?? "";
  const normalizedQuery = query.trim().toLowerCase();

  useEffect(() => {
    if (!activeProvider) return;
    setOpenProviders((prev) => {
      if (prev[activeProvider]) return prev;
      return { ...prev, [activeProvider]: true };
    });
  }, [activeProvider]);

  // 服务端 settings 变化时同步本地勾选（仅当与本地无冲突的 pending 时）
  useEffect(() => {
    if (!settings) return;
    setEnabledLocal((prev) => {
      const next: Record<string, string[]> = { ...prev };
      for (const slot of settings.llm.providers) {
        const serverList = filterChatModelIds(
          slot.provider === settings.llm.provider
            ? (settings.llm.enabledModels ?? [])
            : (slot.enabledModels ?? []),
        );
        // 若本地没有该 key，或服务端已追上本地，则采用服务端
        if (prev[slot.provider] === undefined) {
          next[slot.provider] = serverList;
          continue;
        }
        const localList = prev[slot.provider] ?? [];
        const same =
          localList.length === serverList.length
          && localList.every((m) => serverList.includes(m));
        if (same) next[slot.provider] = serverList;
        // 否则保留本地乐观值，等待下一次服务端一致
      }
      return next;
    });
  }, [settings]);

  function slotAvailable(provider: string): string[] {
    const raw =
      provider === activeProvider
        ? (settings?.llm.availableModels ?? [])
        : (settings?.llm.providers?.find((item) => item.provider === provider)?.availableModels ?? []);
    // 前端再滤一层，兼容尚未重新拉取的历史脏列表
    return filterChatModelIds(raw);
  }

  function slotEnabled(provider: string): string[] {
    if (enabledLocal[provider] !== undefined) {
      return enabledLocal[provider]!;
    }
    const raw =
      provider === activeProvider
        ? (settings?.llm.enabledModels ?? [])
        : (settings?.llm.providers?.find((item) => item.provider === provider)?.enabledModels ?? []);
    return filterChatModelIds(raw);
  }

  function slotDefaultModel(provider: string): string {
    if (provider === activeProvider) {
      return activeModel;
    }
    return settings?.llm.providers?.find((item) => item.provider === provider)?.model ?? "";
  }

  function commitEnabled(provider: string, models: string[]): void {
    const next = filterChatModelIds(models);
    setEnabledLocal((prev) => ({ ...prev, [provider]: next }));
    onSaveSlotEnabledModels(provider, next);
  }

  function toggleModel(provider: string, model: string, checked: boolean): void {
    const enabled = new Set(slotEnabled(provider));
    if (checked) enabled.add(model);
    else enabled.delete(model);
    commitEnabled(provider, [...enabled]);
  }

  function enableAll(provider: string): void {
    const available = slotAvailable(provider);
    if (available.length === 0) return;
    commitEnabled(provider, available);
  }

  /** 清空该 Provider 在主界面菜单中的勾选（可全不选）。 */
  function enableNone(provider: string): void {
    commitEnabled(provider, []);
  }

  function addCustomModel(provider: string): void {
    const raw = (customDraft[provider] ?? "").trim();
    if (!raw) return;
    if (!isChatModelId(raw)) return;
    const available = slotAvailable(provider);
    if (available.includes(raw)) {
      setCustomDraft((prev) => ({ ...prev, [provider]: "" }));
      return;
    }
    const nextAvailable = [...available, raw];
    onSaveSlotAvailableModels(provider, nextAvailable);
    // 新模型默认勾选进主界面菜单
    commitEnabled(provider, [...slotEnabled(provider), raw]);
    setCustomDraft((prev) => ({ ...prev, [provider]: "" }));
  }

  function removeModel(provider: string, model: string): void {
    const available = slotAvailable(provider).filter((m) => m !== model);
    onSaveSlotAvailableModels(provider, available);
    commitEnabled(
      provider,
      slotEnabled(provider).filter((m) => m !== model),
    );
  }

  /** 跨 provider 的视觉候选：namespace 保证同名模型不冲突 */
  const visionOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = [];
    const seen = new Set<string>();
    for (const slot of providers) {
      const models = new Set([
        ...slotAvailable(slot.provider),
        ...slotEnabled(slot.provider),
        ...(slotDefaultModel(slot.provider) ? [slotDefaultModel(slot.provider)] : []),
      ]);
      for (const model of models) {
        if (!isChatModelId(model)) continue;
        const value = modelNamespace(slot.provider, model);
        if (seen.has(value)) continue;
        seen.add(value);
        options.push({
          value,
          label: `${providerLabel(slot.provider)} / ${model}`,
        });
      }
    }
    if (globalVision && !seen.has(globalVision)) {
      const parsed = parseModelNamespace(globalVision);
      options.unshift({
        value: globalVision,
        label: parsed.provider
          ? `${providerLabel(parsed.provider)} / ${parsed.model}`
          : globalVision,
      });
    }
    return options;
  }, [providers, settings, globalVision, activeProvider, activeModel]);

  const visionSelectValue = (() => {
    if (!globalVision) return "";
    if (visionOptions.some((opt) => opt.value === globalVision)) return globalVision;
    if (activeProvider) {
      const ns = modelNamespace(activeProvider, globalVision);
      if (visionOptions.some((opt) => opt.value === ns)) return ns;
    }
    const bare = visionOptions.find((opt) => parseModelNamespace(opt.value).model === globalVision);
    return bare?.value ?? globalVision;
  })();

  const groups = providers
    .map((slot) => {
      const available = slotAvailable(slot.provider);
      const models = normalizedQuery
        ? available.filter((model) => {
            const ns = modelNamespace(slot.provider, model).toLowerCase();
            const label = providerLabel(
              slot.provider,
              catalogFor(settings, slot.provider)?.name,
            ).toLowerCase();
            return (
              model.toLowerCase().includes(normalizedQuery)
              || ns.includes(normalizedQuery)
              || label.includes(normalizedQuery)
            );
          })
        : available;
      return { slot, models };
    })
    .filter((group) => group.models.length > 0 || !normalizedQuery)
    .sort((a, b) => {
      if (a.slot.provider === activeProvider) return -1;
      if (b.slot.provider === activeProvider) return 1;
      return a.slot.provider.localeCompare(b.slot.provider);
    });

  return (
    <>
      <p className="settings-models-hint">{t("settings.modelsPageHint")}</p>

      <div className="settings-models-search-wrap">
        <input
          className="settings-models-search"
          type="search"
          value={query}
          placeholder={t("settings.searchModels")}
          onChange={(event) => setQuery(event.currentTarget.value)}
          aria-label={t("settings.searchModels")}
        />
      </div>

      {providers.length > 0 && (
        <label className="settings-models-vision settings-models-vision-global">
          <span>
            <strong>{t("settings.visionModelTitle")}</strong>
            <small>{t("settings.visionModelDesc")}</small>
          </span>
          <select
            className="settings-models-vision-select"
            value={visionSelectValue}
            disabled={saving || visionOptions.length === 0}
            onChange={(event) => onSaveVisionModel(event.currentTarget.value)}
          >
            <option value="">{t("settings.visionModelPlaceholder")}</option>
            {visionOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {providers.length === 0 ? (
        <div className="settings-provider-empty">
          <p>{t("settings.modelsNeedProvider")}</p>
        </div>
      ) : groups.length === 0 ? (
        <div className="settings-provider-empty">
          <p>{t("settings.modelsNoMatch")}</p>
        </div>
      ) : (
        groups.map(({ slot, models }) => {
          const enabledSet = new Set(slotEnabled(slot.provider));
          const current = slotDefaultModel(slot.provider);
          const available = slotAvailable(slot.provider);
          const isActiveSlot = slot.provider === activeProvider;
          const visionParsed = parseModelNamespace(globalVision);
          const allEnabled = available.length > 0 && available.every((m) => enabledSet.has(m));
          const slotCatalog = catalogFor(settings, slot.provider);
          // 搜索时强制展开匹配组；否则看抽屉状态（默认仅激活槽展开）
          const open =
            Boolean(normalizedQuery)
            || openProviders[slot.provider]
            || (openProviders[slot.provider] === undefined && isActiveSlot);
          return (
            <section
              key={slot.provider}
              className="settings-models-group"
              data-open={open}
            >
              <header className="settings-models-group-head">
                <button
                  type="button"
                  className="settings-models-group-toggle"
                  aria-expanded={open}
                  onClick={() =>
                    setOpenProviders((prev) => ({
                      ...prev,
                      [slot.provider]: !open,
                    }))
                  }
                >
                  <span className="settings-models-group-caret" data-open={open} aria-hidden="true">
                    ›
                  </span>
                  <ProviderIcon provider={slot.provider} />
                  <span className="settings-models-group-title">
                    <strong>
                      {providerLabel(slot.provider, slotCatalog?.name)}
                    </strong>
                    <small>
                      <span className="settings-models-ns">{slot.provider}</span>
                      {" · "}
                      {enabledSet.size}/{available.length || models.length}
                      {isActiveSlot ? ` · ${t("settings.providerActive")}` : ""}
                    </small>
                  </span>
                </button>
                {open && (
                  <div className="settings-models-group-actions">
                    <button
                      type="button"
                      className="settings-secondary-btn"
                      disabled={fetchingModels || saving}
                      onClick={() => onFetchModelsForProvider(slot.provider)}
                    >
                      {fetchingModels ? t("settings.fetching") : t("settings.fetchModels")}
                    </button>
                    {available.length > 0 && (
                      <>
                        <button
                          type="button"
                          className="settings-secondary-btn"
                          disabled={saving || allEnabled}
                          onClick={() => enableAll(slot.provider)}
                        >
                          {t("settings.enableAllModels")}
                        </button>
                        <button
                          type="button"
                          className="settings-secondary-btn"
                          disabled={saving || enabledSet.size === 0}
                          onClick={() => enableNone(slot.provider)}
                        >
                          {t("settings.enableNoneModels")}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </header>

              {open && (
                <div className="settings-models-group-body">
                  {available.length === 0 ? (
                    <div className="settings-provider-empty settings-models-empty-inline">
                      <p>{t("settings.modelEmptyFetchHere")}</p>
                    </div>
                  ) : (
                    <div className="settings-provider-sheet settings-models-sheet" role="list">
                      {models.map((model) => {
                        const isCurrent = isActiveSlot && model === current;
                        // 勾选 = 出现在输入框模型菜单；点名称 = 切换并保存为当前主模型
                        const checked = enabledSet.has(model);
                        const ns = modelNamespace(slot.provider, model);
                        const isVision =
                          globalVision === ns
                          || (visionParsed.provider === slot.provider && visionParsed.model === model)
                          || (!visionParsed.provider && globalVision === model);
                        return (
                          <div
                            key={ns}
                            className="settings-models-row"
                            data-current={isCurrent}
                            role="listitem"
                          >
                            <button
                              type="button"
                              className="settings-models-row-main"
                              disabled={saving || isCurrent}
                              title={isCurrent ? ns : t("settings.clickToUseModel")}
                              onClick={() => {
                                if (!isCurrent) onSelectModel(slot.provider, model);
                              }}
                            >
                              <span className="settings-models-row-id" title={ns}>{model}</span>
                              {isCurrent && <em>{t("settings.modelCurrent")}</em>}
                              {isVision && !isCurrent && <em>{t("settings.modelVisionTag")}</em>}
                            </button>
                            <input
                              type="checkbox"
                              checked={checked}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) => {
                                event.stopPropagation();
                                toggleModel(slot.provider, model, event.currentTarget.checked);
                              }}
                              aria-label={`${ns} ${t("settings.enableModelListLabel")}`}
                              title={t("settings.enabledModelsDesc")}
                            />
                            <button
                              type="button"
                              className="settings-models-row-remove"
                              disabled={saving}
                              title={t("settings.removeModel")}
                              aria-label={`${t("settings.removeModel")}: ${model}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                removeModel(slot.provider, model);
                              }}
                            >
                              ×
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div className="settings-models-add">
                    <input
                      className="settings-models-add-input"
                      type="text"
                      value={customDraft[slot.provider] ?? ""}
                      placeholder={t("settings.addModelPlaceholder")}
                      disabled={saving}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setCustomDraft((prev) => ({
                          ...prev,
                          [slot.provider]: value,
                        }));
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addCustomModel(slot.provider);
                        }
                      }}
                      aria-label={t("settings.addModel")}
                    />
                    <button
                      type="button"
                      className="settings-secondary-btn"
                      disabled={
                        saving
                        || !(customDraft[slot.provider] ?? "").trim()
                        || !isChatModelId((customDraft[slot.provider] ?? "").trim())
                      }
                      onClick={() => addCustomModel(slot.provider)}
                    >
                      {t("settings.addModel")}
                    </button>
                  </div>
                </div>
              )}
            </section>
          );
        })
      )}
    </>
  );
}
