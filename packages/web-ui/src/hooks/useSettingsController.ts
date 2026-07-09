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
import { parseProviderModel } from "../app/taskUtils";
import { t } from "../i18n";
import type { DataStatus } from "./useSettings";

export function useSettingsController({
  health,
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

  function handleSaveSettings(draft: SettingsDraft): void {
    // 启用模型列表按 provider 分槽：写入目标 provider 自己的列表，避免把当前激活槽位的模型带过去
    const targetSlot = runtimeSettings?.llm.providers?.find((slot) => slot.provider === draft.provider);
    const isSameProvider = runtimeSettings?.llm.provider === draft.provider;
    const baseEnabled = isSameProvider
      ? (runtimeSettings?.llm.enabledModels ?? [])
      : (targetSlot?.enabledModels ?? []);
    const mergedEnabled = draft.model
      ? (baseEnabled.includes(draft.model) ? baseEnabled : [draft.model, ...baseEnabled])
      : baseEnabled;

    const body: UpdateRuntimeSettingsRequest = {
      llm: {
        provider: draft.provider,
        baseUrl: draft.baseUrl,
        model: draft.model,
        visionModel: draft.visionModel,
        enabledModels: mergedEnabled,
        maxTokens: draft.maxTokens,
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      },
      workspaceDir: draft.workspaceDir,
      commandExecutionEnabled: draft.commandExecutionEnabled,
      autoModeSafetyEnabled: draft.autoModeSafetyEnabled,
      agentToolExecution: draft.agentToolExecution as "sequential" | "parallel",
      mcpServersJson: draft.mcpServersJson,
      cleanupPolicyDays: draft.cleanupPolicyDays,
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

  function handleSaveModelSelection(draft: ModelSelectorDraft): void {
    setSettingsSaving(true);
    // 跨 provider 切换：同时写入 provider + model，后端会激活对应槽位的 key/baseUrl
    void updateSettings({ llm: { provider: draft.provider, model: draft.model } })
      .then((next) => {
        setRuntimeSettings(next);
        setHealth((previous) =>
          previous ? { ...previous, provider: `${next.llm.provider}:${next.llm.model}` } : previous,
        );
        onModelSaved?.();
        setNotice(t("notice.modelSwitched"));
        return refreshRuntime();
      })
      .catch((err) => setNotice(`${t("notice.switchModelFailed")}${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setSettingsSaving(false));
  }

  function handleFetchModels(): void {
    setFetchingModels(true);
    void listProviderModels()
      .then((models) => {
        const currentModel = runtimeSettings?.llm.model ?? parseProviderModel(health?.provider);
        const existingEnabled = runtimeSettings?.llm.enabledModels ?? [];
        const firstFetch = (runtimeSettings?.llm.availableModels.length ?? 0) === 0;
        const enabledModels = !firstFetch && existingEnabled.length > 0
          ? existingEnabled.filter((model) => models.includes(model))
          : [];
        if (currentModel && models.includes(currentModel) && !enabledModels.includes(currentModel)) {
          enabledModels.unshift(currentModel);
        }
        return updateSettings({ llm: { availableModels: models, enabledModels } });
      })
      .then((next) => {
        setRuntimeSettings(next);
        setNotice(`${t("notice.fetchedModelsPrefix")} ${next.llm.availableModels.length} ${t("notice.fetchedModelsMid")} ${next.llm.enabledModels.length} ${t("notice.fetchedModelsSuffix")}`);
        return refreshSettings();
      })
      .catch((err) => setNotice(`${t("notice.fetchModelsFailed")}${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setFetchingModels(false));
  }

  function handleSaveEnabledModels(models: string[]): void {
    const currentModel = runtimeSettings?.llm.model;
    const enabledModels = currentModel && !models.includes(currentModel) ? [currentModel, ...models] : models;
    setSettingsSaving(true);
    void updateSettings({ llm: { enabledModels } })
      .then((next) => {
        setRuntimeSettings(next);
        setNotice(`${t("notice.enabledModelsPrefix")} ${next.llm.enabledModels.length} ${t("notice.enabledModelsSuffix")}`);
        return refreshSettings();
      })
      .catch((err) => setNotice(`${t("notice.saveModelListFailed")}${err instanceof Error ? err.message : String(err)}`))
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
    handleCleanupData,
    handleCreateMemory,
    handleDeleteMemory,
    handleEditMemory,
    handleFetchModels,
    handleSaveEnabledModels,
    handleSaveModelSelection,
    handleSaveSettings,
    handleToggleMemory,
    refreshMemories,
    refreshSettings,
  };
}
