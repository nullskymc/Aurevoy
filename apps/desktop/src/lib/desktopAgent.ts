import { invoke } from "@tauri-apps/api/core";

export type DesktopAgentMode = "external" | "managed" | "unavailable";

export interface DesktopAgentStatus {
  baseUrl: string;
  mode: DesktopAgentMode;
  running: boolean;
  pid: number | null;
  message: string;
  error: string | null;
}

/** 非 Tauri 浏览器预览中不能调用 invoke，此时交回现有 HTTP 探测路径处理。 */
export function canUseTauriCommands(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 请求桌面壳确保本地 Agent 引擎正在运行；业务状态仍以 /api/health 为准。 */
export async function ensureDesktopAgentProcess(): Promise<DesktopAgentStatus | null> {
  if (!canUseTauriCommands()) return null;
  return invoke<DesktopAgentStatus>("ensure_agent_process");
}

export async function getDesktopAgentProcessStatus(): Promise<DesktopAgentStatus | null> {
  if (!canUseTauriCommands()) return null;
  return invoke<DesktopAgentStatus>("agent_process_status");
}
