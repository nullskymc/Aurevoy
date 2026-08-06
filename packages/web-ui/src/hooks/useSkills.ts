import { useCallback, useEffect, useState } from "react";
import type { SkillDescriptor, SkillInstallRequest, SkillInstallResponse } from "@aurevoy/shared";
import { fetchSkills, installSkill, reloadSkills, toggleSkill as toggleSkillApi, uninstallSkill } from "../api";

interface UseSkillsResult {
  skills: SkillDescriptor[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  installing: boolean;
  installError: string | null;
  install: (request: SkillInstallRequest) => Promise<SkillInstallResponse>;
  uninstall: (name: string) => Promise<void>;
  reloading: boolean;
  reload: () => Promise<void>;
  toggle: (name: string, enabled: boolean) => Promise<void>;
}

/**
 * 获取 skill 列表的 React hook。
 * 挂载时自动拉取，提供 refresh() 手动刷新。
 * 提供 install() 和 uninstall() 操作，操作后自动刷新列表。
 * 提供 reload() 触发后端重新扫描所有 skill 目录并刷新列表。
 */
export function useSkills(): UseSkillsResult {
  const [skills, setSkills] = useState<SkillDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  const loadAsync = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchSkills();
      setSkills(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const load = useCallback(() => {
    loadAsync();
  }, [loadAsync]);

  useEffect(() => {
    load();
  }, [load]);

  const install = useCallback(async (request: SkillInstallRequest): Promise<SkillInstallResponse> => {
    setInstalling(true);
    setInstallError(null);
    try {
      const result = await installSkill(request);
      await loadAsync();
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setInstallError(msg);
      throw err;
    } finally {
      setInstalling(false);
    }
  }, [loadAsync]);

  const uninstall = useCallback(async (name: string): Promise<void> => {
    setInstalling(true);
    setInstallError(null);
    try {
      await uninstallSkill(name);
      await loadAsync();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setInstallError(msg);
      throw err;
    } finally {
      setInstalling(false);
    }
  }, [loadAsync]);

  const reload = useCallback(async (): Promise<void> => {
    setReloading(true);
    try {
      const data = await reloadSkills();
      setSkills(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReloading(false);
    }
  }, []);

  const toggle = useCallback(async (name: string, enabled: boolean): Promise<void> => {
    try {
      const updated = await toggleSkillApi(name, enabled);
      setSkills((prev) => prev.map((s) => (s.name === name ? { ...s, enabled: updated.enabled } : s)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // 让详情弹窗知道动作失败，以便回滚本地乐观状态；列表错误仍由 hook 统一保留。
      throw err;
    }
  }, []);

  return { skills, loading, error, refresh: load, installing, installError, install, uninstall, reloading, reload, toggle };
}
