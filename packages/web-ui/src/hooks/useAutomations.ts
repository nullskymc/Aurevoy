import { useCallback, useState } from "react";
import type { Automation, CreateAutomationRequest, RunAutomationResponse, UpdateAutomationRequest } from "@aurevoy/shared";
import {
  createAutomation,
  deleteAutomation,
  listAutomationRuns,
  listAutomations,
  runAutomation,
  testAutomation,
  updateAutomation,
} from "../api";

/** 自动化列表的轻量状态层；页面只负责表单和展示，不直接管理 HTTP 细节。 */
export function useAutomations() {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setAutomations(await listAutomations());
    } finally {
      setLoading(false);
    }
  }, []);

  const create = useCallback(async (body: CreateAutomationRequest): Promise<Automation> => {
    const automation = await createAutomation(body);
    setAutomations((prev) => [automation, ...prev]);
    return automation;
  }, []);

  const update = useCallback(async (id: string, body: UpdateAutomationRequest): Promise<Automation> => {
    const automation = await updateAutomation(id, body);
    setAutomations((prev) => prev.map((item) => item.id === id ? automation : item));
    return automation;
  }, []);

  const remove = useCallback(async (id: string): Promise<void> => {
    await deleteAutomation(id);
    setAutomations((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const run = useCallback(async (id: string): Promise<RunAutomationResponse> => {
    const result = await runAutomation(id);
    setAutomations((prev) => prev.map((item) => item.id === id ? result.automation : item));
    return result;
  }, []);

  const testRun = useCallback((body: CreateAutomationRequest) => testAutomation(body), []);

  const loadRuns = useCallback((id: string) => listAutomationRuns(id), []);

  return { automations, loading, refresh, create, update, remove, run, testRun, loadRuns };
}
