import { useEffect, useState } from "react";
import type { TokenUsageReport } from "@aurevoy/shared";
import { t } from "../../i18n";
import { getTokenUsageReport } from "../../api";
import { SettingsGroup } from "./layout";

export function UsageSettings() {
  const [report, setReport] = useState<TokenUsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const reload = () => {
    setLoading(true);
    setError(false);
    getTokenUsageReport()
      .then(setReport)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  };

  useEffect(() => { reload(); }, []);

  const ready = !loading && !error && report && report.available;

  if (loading) {
    return (
      <SettingsGroup title={t("settings.usageOverview")}>
        <div className="usage-loading">
          <div className="usage-loading-spinner" />
          <span>{t("settings.fetching")}</span>
        </div>
      </SettingsGroup>
    );
  }

  if (error || !ready) {
    return (
      <SettingsGroup title={t("settings.usageOverview")}>
        <div className="usage-error">
          <span>{error ? t("settings.usageFetchFailed") : t("settings.tokenUsageUnavailable")}</span>
          <button type="button" className="settings-secondary-btn" onClick={reload}>
            {t("settings.refresh")}
          </button>
        </div>
      </SettingsGroup>
    );
  }

  const inputPct = report.totalTokens > 0 ? (report.promptTokens / report.totalTokens) * 100 : 0;
  const outputPct = report.totalTokens > 0 ? (report.completionTokens / report.totalTokens) * 100 : 0;
  const reasoningPct = report.completionTokens > 0 ? (report.reasoningTokens / report.completionTokens) * 100 : 0;
  const cachePct = report.promptTokens > 0 ? (report.cacheReadTokens / report.promptTokens) * 100 : 0;

  return (
    <>
      <SettingsGroup title={t("settings.usageOverview")}>
        <div className="usage-stats-grid">
          <div className="usage-stat-card">
            <div className="usage-stat-label">{t("settings.tokenUsageTotal")}</div>
            <div className="usage-stat-value">{formatTokenCount(report.totalTokens)}</div>
            <div className="usage-stat-sub">
              {report.measuredTasks}/{report.tasks} {t("settings.tokenUsageTasks")}
            </div>
          </div>
          <div className="usage-stat-card">
            <div className="usage-stat-label">{t("settings.tokenUsagePrompt")}</div>
            <div className="usage-stat-value usage-stat-input">{formatTokenCount(report.promptTokens)}</div>
            <div className="usage-stat-sub">{inputPct.toFixed(1)}%</div>
          </div>
          <div className="usage-stat-card">
            <div className="usage-stat-label">{t("settings.tokenUsageCompletion")}</div>
            <div className="usage-stat-value usage-stat-output">{formatTokenCount(report.completionTokens)}</div>
            <div className="usage-stat-sub">{outputPct.toFixed(1)}%</div>
          </div>
          {report.reasoningTokens > 0 && (
            <div className="usage-stat-card">
              <div className="usage-stat-label">{t("settings.tokenUsageReasoning")}</div>
              <div className="usage-stat-value usage-stat-reasoning">{formatTokenCount(report.reasoningTokens)}</div>
              <div className="usage-stat-sub">{reasoningPct.toFixed(1)}% {t("settings.usageOfOutput")}</div>
            </div>
          )}
          {report.estimatedCostUsd > 0 && (
            <div className="usage-stat-card">
              <div className="usage-stat-label">{t("settings.tokenUsageEstimatedCost")}</div>
              <div className="usage-stat-value usage-stat-cost">${report.estimatedCostUsd.toFixed(4)}</div>
              <div className="usage-stat-sub">USD</div>
            </div>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("settings.usageBreakdown")}>
        <div className="usage-breakdown-card">
          <div className="usage-breakdown-header">
            <span className="usage-breakdown-title">{t("settings.usageInputTokens")}</span>
            <span className="usage-breakdown-value">{formatTokenCount(report.promptTokens)}</span>
          </div>
          <div className="usage-breakdown-desc">{t("settings.usageInputDetail")}</div>
          
          {report.cacheReadTokens > 0 && (
            <>
              <div className="usage-breakdown-sub">
                <div className="usage-breakdown-header">
                  <span className="usage-breakdown-title">{t("settings.usageInputCache")}</span>
                  <span className="usage-breakdown-value">{formatTokenCount(report.cacheReadTokens)}</span>
                </div>
                <div className="usage-breakdown-desc">
                  {t("settings.usageCacheHitRate")} {cachePct.toFixed(1)}%
                </div>
              </div>
            </>
          )}

          <div className="usage-breakdown-divider" />

          <div className="usage-breakdown-header">
            <span className="usage-breakdown-title">{t("settings.usageOutputTokens")}</span>
            <span className="usage-breakdown-value">{formatTokenCount(report.completionTokens)}</span>
          </div>
          <div className="usage-breakdown-desc">{t("settings.usageOutputDetail")}</div>
          {report.reasoningTokens > 0 && (
            <div className="usage-breakdown-sub">
              <div className="usage-breakdown-header">
                <span className="usage-breakdown-title">{t("settings.tokenUsageReasoning")}</span>
                <span className="usage-breakdown-value">{formatTokenCount(report.reasoningTokens)}</span>
              </div>
              <div className="usage-breakdown-desc">
                {reasoningPct.toFixed(1)}% {t("settings.usageOfOutput")}
              </div>
            </div>
          )}
        </div>
      </SettingsGroup>

      {report.breakdown.length > 0 && (
        <SettingsGroup title={t("settings.usageByModel")}>
          <div className="usage-model-table">
            <div className="usage-model-row usage-model-head">
              <span>{t("settings.usageProviderModel")}</span>
              <span>{t("settings.tokenUsageTotal")}</span>
              <span>{t("settings.tokenUsagePrompt")}</span>
              <span>{t("settings.tokenUsageCompletion")}</span>
              <span>{t("settings.tokenUsageTasks")}</span>
            </div>
            {report.breakdown.map((item) => (
              <div className="usage-model-row" key={`${item.provider}:${item.model}`}>
                <span className="usage-model-name">
                  <strong>{item.model}</strong>
                  <small>{item.provider}</small>
                </span>
                <span>{formatTokenCount(item.totalTokens)}</span>
                <span>{formatTokenCount(item.promptTokens)}</span>
                <span>{formatTokenCount(item.completionTokens)}</span>
                <span>{item.tasks}</span>
              </div>
            ))}
          </div>
        </SettingsGroup>
      )}
    </>
  );
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
