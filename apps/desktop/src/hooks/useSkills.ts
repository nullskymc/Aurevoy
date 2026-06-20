import { useCallback, useEffect, useState } from "react";
import type { SkillDescriptor, SkillInstallResponse } from "@aurevoy/shared";
import { fetchSkills, installSkill, uninstallSkill } from "../lib/api";

interface UseSkillsResult {
  skills: SkillDescriptor[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  installing: boolean;
  installError: string | null;
  install: (url: string) => Promise<SkillInstallResponse>;
  uninstall: (name: string) => Promise<void>;
}

/**
 * 获取 skill 列表的 React hook。
 * 挂载时自动拉取，提供 refresh() 手动刷新。
 * 提供 install() 和 uninstall() 操作，操作后自动刷新列表。
 */
export function useSkills(): UseSkillsResult {
  const [skills, setSkills] = useState<SkillDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

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

  const install = useCallback(async (url: string): Promise<SkillInstallResponse> => {
    setInstalling(true);
    setInstallError(null);
    try {
      const result = await installSkill(url);
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

  return { skills, loading, error, refresh: load, installing, installError, install, uninstall };
}
