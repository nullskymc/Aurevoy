import type { McpToolChangeSummary, ToolRiskLevel } from '@aurevoy/shared';

/** 比较一次 MCP reload 的工具清单与风险等级；没有上一份清单时不制造“新增”噪音。 */
export function diffMcpToolChanges(
  previousNames: readonly string[] | undefined,
  previousRisks: Readonly<Record<string, ToolRiskLevel>> | undefined,
  currentNames: readonly string[],
  currentRisks: Readonly<Record<string, ToolRiskLevel>>,
): McpToolChangeSummary | undefined {
  if (!previousNames) return undefined;
  const before = new Set(previousNames);
  const after = new Set(currentNames);
  const added = [...after].filter((name) => !before.has(name)).sort();
  const removed = [...before].filter((name) => !after.has(name)).sort();
  const riskChanged = [...after]
    .filter((name) => before.has(name) && previousRisks?.[name] !== currentRisks[name])
    .sort();
  if (added.length === 0 && removed.length === 0 && riskChanged.length === 0) return undefined;
  return { added, removed, riskChanged };
}
