import { useState } from "react";
import type { McpServerStatus, RuntimeSettings } from "@aurevoy/shared";
import type { getDataStatus } from "../api";

export type DataStatus = Awaited<ReturnType<typeof getDataStatus>>;

export function useSettings() {
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  const [dataStatus, setDataStatus] = useState<DataStatus | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);

  return {
    runtimeSettings,
    mcpServers,
    dataStatus,
    settingsSaving,
    fetchingModels,
    setRuntimeSettings,
    setMcpServers,
    setDataStatus,
    setSettingsSaving,
    setFetchingModels,
  };
}
