import type { Dispatch, SetStateAction } from "react";
import type {
  HealthResponse,
  McpServerStatus,
  MemoryCategory,
  MemoryEntry,
  RuntimeSettings,
  UpdateRuntimeSettingsRequest,
} from "@aurevoy/shared";
import {
  cleanupData,
  createMemory,
  deleteMemory,
  getDataStatus,
  getMcpStatus,
  getSettings,
  listMemories,
  listProviderModels,
  updateMemory,
  updateSettings,
} from "../api";
import type { ModelSelectorDraft } from "../components/ModelSelectorDrawer";
import type { SettingsDraft } from "../components/SettingsPanel";
import type { AutoModeLevel } from "../app/types";
import { t } from "../i18n";
import type { DataStatus } from "./useSettings";

export function useSettingsController({
  health: _health,
  refreshRuntime,
  runtimeSettings,
  setAutoModeLevel,
  setDataStatus,
  setFetchingModels,
  setHealth,
  setMcpServers,
  setMemories,
  setNotice,
  setRuntimeSettings,
  setSettingsSaving,
  onModelSaved,
}: {
  health: HealthResponse | null;
  refreshRuntime: () => Promise<void>;
  runtimeSettings: RuntimeSettings | null;
  setAutoModeLevel: Dispatch<SetStateAction<AutoModeLevel>>;
  setDataStatus: Dispatch<SetStateAction<DataStatus | null>>;
  setFetchingModels: Dispatch<SetStateAction<boolean>>;
  setHealth: Dispatch<SetStateAction<HealthResponse | null>>;
  setMcpServers: Dispatch<SetStateAction<McpServerStatus[]>>;
  setMemories: Dispatch<SetStateAction<MemoryEntry[]>>;
  setNotice: (message: string | null) => void;
  setRuntimeSettings: Dispatch<SetStateAction<RuntimeSettings | null>>;
  setSettingsSaving: Dispatch<SetStateAction<boolean>>;
  onModelSaved?: () => void;
}) {
  async function refreshSettings(): Promise<void> {
    try {
      const [settings, mcp, data] = await Promise.all([
        getSettings(),
        getMcpStatus(),
        getDataStatus(),
      ]);
      setRuntimeSettings(settings);
      setAutoModeLevel(settings.autoModeLevel);
      setMcpServers(mcp.servers);
      setDataStatus(data);
    } catch (err) {
      setNotice(`${t("notice.readSettingsFailed")}${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function refreshMemories(): Promise<void> {
    try {
      setMemories(await listMemories());
    } catch (err) {
      setNotice(`${t("notice.readMemoryFailed")}${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Provider 连接：只写密钥 / Base URL / maxTokens，不改默认模型、启用列表、视觉模型。 */
  function handleSaveProviderConnection(draft: SettingsDraft): void {
    // 跨槽保存时：若 baseUrl 仍等于当前激活槽网关、且与目标槽已存值不同，视为 draft 残留，回落目标槽
    const activeBase = (runtimeSettings?.llm.baseUrl ?? "").replace(/\/+$/, "");
    const slotBase = (
      runtimeSettings?.llm.providers?.find((s) => s.provider === draft.provider)?.baseUrl ?? ""
    ).replace(/\/+$/, "");
    const draftBase = draft.baseUrl.trim().replace(/\/+$/, "");
    const baseUrl =
      draft.provider !== runtimeSettings?.llm.provider
      && draft.provider !== "openai-compatible"
      && draftBase.length > 0
      && draftBase === activeBase
      && draftBase !== slotBase
        ? slotBase
        : draft.baseUrl;
    const body: UpdateRuntimeSettingsRequest = {
      llm: {
        provider: draft.provider,
        baseUrl,
        maxTokens: draft.maxTokens,
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      },
    };
    setSettingsSaving(true);
    void updateSettings(body)
      .then((next) => {
        setRuntimeSettings(next);
        setHealth((previous) =>
          previous ? { ...previous, provider: `${next.llm.provider}:${next.llm.model}` } : previous,
        );
        setNotice(t("notice.settingsSaved"));
        return refreshSettings();
      })
      .catch((err) => setNotice(`${t("notice.saveSettingsFailed")}${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setSettingsSaving(false));
  }

  function handleSaveSettings(draft: SettingsDraft): void {
    // 不强制把 model 并入 enabled：启用勾选与「正在使用」解耦
    const body: UpdateRuntimeSettingsRequest = {
      llm: {
        provider: draft.provider,
        baseUrl: draft.baseUrl,
        model: draft.model,
        maxTokens: draft.maxTokens,
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      },
      workspaceDir: draft.workspaceDir,
      commandExecutionEnabled: draft.commandExecutionEnabled,
      autoModeSafetyEnabled: draft.autoModeSafetyEnabled,
      agentToolExecution: draft.agentToolExecution as "sequential" | "parallel",
      mcpServersJson: draft.mcpServersJson,
      cleanupPolicyDays: draft.cleanupPolicyDays,
      budget: {
        run: {
          maxIterations: draft.budgetRunMaxIterations,
          maxToolCalls: draft.budgetRunMaxToolCalls,
          maxWallTimeMs: draft.budgetRunMaxWallTimeMin * 60_000,
        },
        lifetime: {
          maxIterations: draft.budgetLifetimeMaxIterations,
          maxToolCalls: draft.budgetLifetimeMaxToolCalls,
          maxWallTimeMs: draft.budgetLifetimeMaxWallTimeMin * 60_000,
        },
      },
      embedding: {
        provider: draft.embeddingProvider as "openai" | "off",
        model: draft.embeddingModel,
        baseUrl: draft.embeddingBaseUrl,
        ...(draft.embeddingApiKey ? { apiKey: draft.embeddingApiKey } : {}),
      },
      search: {
        provider: draft.searchProvider as "duckduckgo_lite" | "tavily" | "searxng" | "custom",
        baseUrl: draft.searchBaseUrl,
        ...(draft.searchApiKey ? { apiKey: draft.searchApiKey } : {}),
      },
    };
    setSettingsSaving(true);
    void updateSettings(body)
      .then((next) => {
        setRuntimeSettings(next);
        setHealth((previous) =>
          previous ? { ...previous, provider: `${next.llm.provider}:${next.llm.model}` } : previous,
        );
        setNotice(t("notice.settingsSaved"));
        return refreshSettings();
      })
      .catch((err) => setNotice(`${t("notice.saveSettingsFailed")}${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setSettingsSaving(false));
  }

  /**
   * 全局视觉模型：只写 visionModel，不切换激活 provider。
   * 值推荐 namespace：`provider:model`；空字符串表示清除（回退主模型）。
   */
  function handleSaveVisionModel(visionModel: string): void {
    setSettingsSaving(true);
    void updateSettings({ llm: { visionModel } })
      .then((next) => {
        setRuntimeSettings(next);
        setNotice(t("notice.settingsSaved"));
        return refreshSettings();
      })
      .catch((err) => setNotice(`${t("notice.saveSettingsFailed")}${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setSettingsSaving(false));
  }

  function handleSaveModelSelection(draft: ModelSelectorDraft): void {
    setSettingsSaving(true);
    // 跨 provider 切换：写入 provider + model；后端会激活槽位、持久化，并自动启用该模型
    void updateSettings({ llm: { provider: draft.provider, model: draft.model } })
      .then((next) => {
        setRuntimeSettings(next);
        setHealth((previous) =>
          previous ? { ...previous, provider: `${next.llm.provider}:${next.llm.model}` } : previous,
        );
        onModelSaved?.();
        setNotice(t("notice.modelSwitched"));
        return Promise.all([refreshSettings(), refreshRuntime()]);
      })
      .catch((err) => setNotice(`${t("notice.switchModelFailed")}${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setSettingsSaving(false));
  }

  /** 仅刷新 availableModels；保留仍有效的启用勾选，不强制勾选默认模型。 */
  function handleFetchModels(): void {
    setFetchingModels(true);
    void listProviderModels()
      .then((models) => {
        const existingEnabled = runtimeSettings?.llm.enabledModels ?? [];
        const enabledModels = existingEnabled.filter((model) => models.includes(model));
        return updateSettings({ llm: { availableModels: models, enabledModels } });
      })
      .then((next) => {
        setRuntimeSettings(next);
        setNotice(
          `${t("notice.fetchedModelsPrefix")}${next.llm.availableModels.length}${t("notice.fetchedModelsSuffix")}`,
        );
        return refreshSettings();
      })
      .catch((err) => setNotice(`${t("notice.fetchModelsFailed")}${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setFetchingModels(false));
  }

  function handleSaveEnabledModels(models: string[]): void {
    setSettingsSaving(true);
    void updateSettings({ llm: { enabledModels: models } })
      .then((next) => {
        setRuntimeSettings(next);
        setNotice(`${t("notice.enabledModelsPrefix")} ${next.llm.enabledModels.length} ${t("notice.enabledModelsSuffix")}`);
        return refreshSettings();
      })
      .catch((err) => setNotice(`${t("notice.saveModelListFailed")}${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setSettingsSaving(false));
  }

  /**
   * 更新任意槽位的 enabledModels（允许空列表）。
   * 统一走 slotEnabledModels，后端同时维护 map + 激活槽扁平字段。
   */
  function handleSaveSlotEnabledModels(provider: string, models: string[]): void {
    const enabledModels = [...models];
    void updateSettings({ llm: { slotEnabledModels: { provider, enabledModels } } })
      .then((next) => {
        setRuntimeSettings(next);
        const count =
          next.llm.providers.find((item) => item.provider === provider)?.enabledModels.length
          ?? (next.llm.provider === provider ? next.llm.enabledModels.length : 0);
        setNotice(`${t("notice.enabledModelsPrefix")} ${count} ${t("notice.enabledModelsSuffix")}`);
        return refreshSettings();
      })
      .catch((err) => setNotice(`${t("notice.saveModelListFailed")}${err instanceof Error ? err.message : String(err)}`));
  }

  /**
   * 为指定 provider 拉取模型列表（只写 availableModels；保留仍有效的启用勾选，不强制勾选）。
   * 非当前激活槽时会先切换激活再拉取（listProviderModels 依赖当前激活 provider）。
   */
  function handleFetchModelsForProvider(provider: string): void {
    setFetchingModels(true);
    const priorSlot = runtimeSettings?.llm.providers?.find((s) => s.provider === provider);
    const priorEnabled =
      runtimeSettings?.llm.provider === provider
        ? (runtimeSettings.llm.enabledModels ?? [])
        : (priorSlot?.enabledModels ?? []);

    const ensureActive =
      runtimeSettings?.llm.provider === provider
        ? Promise.resolve(runtimeSettings)
        : updateSettings({ llm: { provider } }).then((next) => {
            setRuntimeSettings(next);
            setHealth((previous) =>
              previous ? { ...previous, provider: `${next.llm.provider}:${next.llm.model}` } : previous,
            );
            return next;
          });

    void ensureActive
      .then(() => listProviderModels())
      .then((models) => {
        const enabledModels = priorEnabled.filter((model) => models.includes(model));
        return updateSettings({ llm: { availableModels: models, enabledModels } });
      })
      .then((next) => {
        setRuntimeSettings(next);
        setNotice(
          `${t("notice.fetchedModelsPrefix")}${next.llm.availableModels.length}${t("notice.fetchedModelsSuffix")}`,
        );
        return refreshSettings();
      })
      .catch((err) => setNotice(`${t("notice.fetchModelsFailed")}${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setFetchingModels(false));
  }

  /**
   * 设置某槽位默认模型：不切换激活 provider（避免误切）。
   * 若就是当前激活槽，则同时更新全局主模型。
   */
  function handleSaveSlotDefaultModel(provider: string, model: string): void {
    setSettingsSaving(true);
    void updateSettings({ llm: { slotModel: { provider, model } } })
      .then((next) => {
        setRuntimeSettings(next);
        if (next.llm.provider === provider) {
          setHealth((previous) =>
            previous ? { ...previous, provider: `${next.llm.provider}:${next.llm.model}` } : previous,
          );
        }
        setNotice(t("notice.settingsSaved"));
        return refreshSettings();
      })
      .catch((err) => setNotice(`${t("notice.saveSettingsFailed")}${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setSettingsSaving(false));
  }

  /** 切换到指定 provider + model 并持久化（设置页点模型名 / 与抽屉切换同一路径）。 */
  function handleActivateProviderModel(provider: string, model: string): void {
    handleSaveModelSelection({ provider, model });
  }

  function handleRemoveProvider(provider: string): void {
    setSettingsSaving(true);
    void updateSettings({ llm: { removeProvider: provider } })
      .then((next) => {
        setRuntimeSettings(next);
        setHealth((previous) =>
          previous ? { ...previous, provider: `${next.llm.provider}:${next.llm.model}` } : previous,
        );
        setNotice(t("notice.providerDisconnected"));
        return refreshSettings();
      })
      .catch((err) =>
        setNotice(`${t("notice.disconnectProviderFailed")}${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => setSettingsSaving(false));
  }

  function handleCleanupData(olderThanDays: number): void {
    void cleanupData(olderThanDays)
      .then((result) => {
        setNotice(`${t("notice.cleanedPrefix")} ${result.deletedTasks} ${t("notice.cleanedMid")}${result.deletedTraces} ${t("notice.cleanedSuffix")}`);
        return refreshSettings();
      })
      .catch((err) => setNotice(`${t("notice.cleanupFailed")}${err instanceof Error ? err.message : String(err)}`));
  }

  function handleCreateMemory(content: string, category: MemoryCategory): void {
    void createMemory({ content, category })
      .then((created) => setMemories((prev) => [created, ...prev]))
      .catch((err) => setNotice(`${t("notice.addMemoryFailed")}${err instanceof Error ? err.message : String(err)}`));
  }

  function handleToggleMemory(id: string, enabled: boolean): void {
    void updateMemory(id, { enabled })
      .then((updated) => setMemories((prev) => prev.map((m) => (m.id === id ? updated : m))))
      .catch((err) => setNotice(`${t("notice.updateMemoryFailed")}${err instanceof Error ? err.message : String(err)}`));
  }

  function handleEditMemory(id: string, content: string, category: MemoryCategory): void {
    void updateMemory(id, { content, category })
      .then((updated) => setMemories((prev) => prev.map((m) => (m.id === id ? updated : m))))
      .catch((err) => setNotice(`${t("notice.editMemoryFailed")}${err instanceof Error ? err.message : String(err)}`));
  }

  function handleDeleteMemory(id: string): void {
    void deleteMemory(id)
      .then(() => setMemories((prev) => prev.filter((m) => m.id !== id)))
      .catch((err) => setNotice(`${t("notice.deleteMemoryFailed")}${err instanceof Error ? err.message : String(err)}`));
  }

  return {
    handleActivateProviderModel,
    handleCleanupData,
    handleCreateMemory,
    handleDeleteMemory,
    handleEditMemory,
    handleFetchModels,
    handleFetchModelsForProvider,
    handleSaveEnabledModels,
    handleSaveSlotDefaultModel,
    handleSaveSlotEnabledModels,
    handleRemoveProvider,
    handleSaveModelSelection,
    handleSaveProviderConnection,
    handleSaveSettings,
    handleSaveVisionModel,
    handleToggleMemory,
    refreshMemories,
    refreshSettings,
  };
}
