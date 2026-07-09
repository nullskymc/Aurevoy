import type { Dispatch, SetStateAction } from "react";
import type { HealthResponse, Project, Task } from "@aurevoy/shared";
import { checkHealth, listProjects, listTasks, setBaseUrl } from "../api";
import { t } from "../i18n";
import type { PlatformAdapter } from "../platform/types";

export function useRuntimeController({
  platform,
  setHealth,
  setNotice,
  setOnline,
  setProjects,
  setTasks,
}: {
  platform: PlatformAdapter;
  setHealth: Dispatch<SetStateAction<HealthResponse | null>>;
  setNotice: (message: string | null) => void;
  setOnline: Dispatch<SetStateAction<boolean | null>>;
  setProjects: Dispatch<SetStateAction<Project[]>>;
  setTasks: Dispatch<SetStateAction<Task[]>>;
}) {
  async function refreshRuntime(): Promise<void> {
    try {
      const [nextHealth, nextTasks, nextProjects] = await Promise.all([
        checkHealth(),
        listTasks(),
        listProjects(),
      ]);
      setHealth(nextHealth);
      setOnline(true);
      setTasks(nextTasks);
      setProjects(nextProjects);
    } catch (err) {
      setHealth(null);
      // 仅网络层失败(fetch 抛 TypeError)才判定引擎离线；HTTP 4xx/5xx 说明引擎可达。
      setOnline(err instanceof TypeError ? false : true);
    }
  }

  async function bootstrapRuntime(): Promise<void> {
    try {
      const status = platform.ensureAgentRunning ? await platform.ensureAgentRunning() : null;
      if (status?.baseUrl) {
        setBaseUrl(status.baseUrl);
      }
      if (status?.error) {
        setNotice(`${status.message}：${status.error}`);
      }
    } catch (err) {
      setNotice(`${t("notice.startEngineFailed")}${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await refreshRuntime();
    }
  }

  async function ensureAgentAvailable(): Promise<void> {
    if (!platform.ensureAgentRunning) return;
    const status = await platform.ensureAgentRunning();
    if (status?.baseUrl) {
      setBaseUrl(status.baseUrl);
    }
    if (status && !status.running) {
      throw new Error(status.error ? `${status.message}: ${status.error}` : status.message ?? "Agent 引擎未运行");
    }
    setOnline(true);
  }

  async function runAgentRequest<T>(request: () => Promise<T>): Promise<T> {
    await ensureAgentAvailable();
    try {
      return await request();
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      await ensureAgentAvailable();
      return request();
    }
  }

  return {
    bootstrapRuntime,
    ensureAgentAvailable,
    refreshRuntime,
    runAgentRequest,
  };
}
