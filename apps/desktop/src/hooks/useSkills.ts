import { useCallback, useEffect, useState } from "react";
import type { SkillDescriptor } from "@aurevoy/shared";
import { fetchSkills } from "../lib/api";

interface UseSkillsResult {
  skills: SkillDescriptor[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * 获取 skill 列表的 React hook。
 * 挂载时自动拉取，提供 refresh() 手动刷新。
 */
export function useSkills(): UseSkillsResult {
  const [skills, setSkills] = useState<SkillDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchSkills()
      .then((data) => {
        setSkills(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { skills, loading, error, refresh: load };
}
