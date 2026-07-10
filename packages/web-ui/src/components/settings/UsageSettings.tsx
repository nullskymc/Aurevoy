import { useEffect, useMemo, useState } from "react";
import type { TokenUsageReport, TokenUsageReportBreakdown } from "@aurevoy/shared";
import { t } from "../../i18n";
import { getTokenUsageReport } from "../../api";
import { ProviderIcon, providerLabel } from "../providerIcons";
import { SettingsChoiceGroup } from "./layout";

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

  useEffect(() => {
    reload();
  }, []);

  if (loading) {
    return (
      <SettingsChoiceGroup title={t("settings.usageOverview")}>
        <div className="usage-shell usage-shell-loading" aria-busy="true">
          <div className="usage-skeleton usage-skeleton-hero" />
          <div className="usage-skeleton-row">
            <div className="usage-skeleton usage-skeleton-block" />
            <div className="usage-skeleton usage-skeleton-block" />
          </div>
          <div className="usage-skeleton usage-skeleton-list" />
        </div>
      </SettingsChoiceGroup>
    );
  }

  if (error) {
    return (
      <SettingsChoiceGroup title={t("settings.usageOverview")}>
        <div className="usage-empty usage-empty-error">
          <div className="usage-empty-icon" aria-hidden="true">
            <UsageAlertIcon />
          </div>
          <strong>{t("settings.usageFetchFailed")}</strong>
          <p>{t("settings.tokenUsageDesc")}</p>
          <button type="button" className="settings-secondary-btn" onClick={reload}>
            {t("settings.refresh")}
          </button>
        </div>
      </SettingsChoiceGroup>
    );
  }

  if (!report?.available) {
    return (
      <SettingsChoiceGroup title={t("settings.usageOverview")}>
        <div className="usage-empty">
          <div className="usage-empty-icon" aria-hidden="true">
            <UsageChartIcon />
          </div>
          <strong>{t("settings.tokenUsageUnavailable")}</strong>
          <p>{t("settings.usageEmptyHint")}</p>
          <button type="button" className="settings-secondary-btn" onClick={reload}>
            {t("settings.refresh")}
          </button>
        </div>
      </SettingsChoiceGroup>
    );
  }

  return <UsageReportView report={report} onReload={reload} />;
}

function UsageReportView({
  report,
  onReload,
}: {
  report: TokenUsageReport;
  onReload: () => void;
}) {
  const metrics = useMemo(() => buildMetrics(report), [report]);
  const composeBase = report.promptTokens + report.completionTokens;
  const inputShare = pct(report.promptTokens, composeBase);
  const outputShare = pct(report.completionTokens, composeBase);
  const inputOfTotal = pct(report.promptTokens, report.totalTokens);
  const outputOfTotal = pct(report.completionTokens, report.totalTokens);
  const coveragePct = pct(report.measuredTasks, report.tasks);
  const topShare = report.breakdown[0]
    ? pct(report.breakdown[0].totalTokens, report.totalTokens)
    : 0;

  return (
    <div className="usage-page">
      <SettingsChoiceGroup title={t("settings.usageOverview")}>
        <div className="usage-hero">
          <div className="usage-hero-top">
            <div className="usage-hero-main">
              <span className="usage-hero-label">{t("settings.tokenUsageTotal")}</span>
              <div className="usage-hero-value" title={formatExact(report.totalTokens)}>
                {formatTokenCount(report.totalTokens)}
              </div>
              <p className="usage-hero-caption">{t("settings.usageHeroCaption")}</p>
            </div>

            <div className="usage-hero-side">
              <div className="usage-hero-cost">
                <span className="usage-hero-label">{t("settings.tokenUsageEstimatedCost")}</span>
                <div
                  className="usage-hero-cost-value"
                  title={
                    report.estimatedCostUsd > 0
                      ? `$${report.estimatedCostUsd.toFixed(6)}`
                      : undefined
                  }
                >
                  {formatCost(report.estimatedCostUsd)}
                </div>
                <span className="usage-hero-cost-unit">USD</span>
              </div>
              <button type="button" className="settings-secondary-btn usage-refresh-btn" onClick={onReload}>
                {t("settings.refresh")}
              </button>
            </div>
          </div>

          <div className="usage-compose" aria-hidden={composeBase <= 0}>
            <div className="usage-compose-bar" role="img" aria-label={t("settings.usageComposition")}>
              {composeBase > 0 ? (
                <>
                  <span
                    className="usage-compose-seg is-input"
                    style={{ width: `${Math.max(inputShare, inputShare > 0 ? 2 : 0)}%` }}
                  />
                  <span
                    className="usage-compose-seg is-output"
                    style={{ width: `${Math.max(outputShare, outputShare > 0 ? 2 : 0)}%` }}
                  />
                </>
              ) : (
                <span className="usage-compose-seg is-empty" style={{ width: "100%" }} />
              )}
            </div>
            <div className="usage-compose-legend">
              <span className="usage-legend-item">
                <i className="usage-dot is-input" />
                {t("settings.usageInputTokens")}
                <em title={formatExact(report.promptTokens)}>
                  {formatTokenCount(report.promptTokens)} · {inputOfTotal.toFixed(1)}%
                </em>
              </span>
              <span className="usage-legend-item">
                <i className="usage-dot is-output" />
                {t("settings.usageOutputTokens")}
                <em title={formatExact(report.completionTokens)}>
                  {formatTokenCount(report.completionTokens)} · {outputOfTotal.toFixed(1)}%
                </em>
              </span>
            </div>
          </div>

          <div className="usage-insight-row">
            <div className="usage-insight">
              <span className="usage-insight-label">{t("settings.usageCoverage")}</span>
              <strong>
                {report.measuredTasks}
                <span className="usage-insight-sep">/</span>
                {report.tasks}
              </strong>
              <small>
                {coveragePct.toFixed(0)}% {t("settings.usageCoverageHint")}
              </small>
            </div>
            <div className="usage-insight">
              <span className="usage-insight-label">{t("settings.usageCacheHitRate")}</span>
              <strong title={formatExact(report.cacheReadTokens)}>
                {report.promptTokens > 0
                  ? `${pct(report.cacheReadTokens, report.promptTokens).toFixed(1)}%`
                  : "—"}
              </strong>
              <small>
                {report.cacheReadTokens > 0
                  ? `${formatTokenCount(report.cacheReadTokens)} ${t("settings.usageInputCache")}`
                  : t("settings.usageNoCache")}
              </small>
            </div>
            <div className="usage-insight">
              <span className="usage-insight-label">{t("settings.usageModelsUsed")}</span>
              <strong>{report.breakdown.length}</strong>
              <small>
                {report.breakdown[0]
                  ? `${t("settings.usageTopModel")} ${topShare.toFixed(0)}%`
                  : t("settings.usageNoModels")}
              </small>
            </div>
          </div>
        </div>
      </SettingsChoiceGroup>

      <SettingsChoiceGroup title={t("settings.usageBreakdown")}>
        <div className="usage-metric-list">
          {metrics.map((metric) => (
            <div className="usage-metric-row" key={metric.id}>
              <div className="usage-metric-head">
                <span className="usage-metric-name">
                  <i className={`usage-dot ${metric.tone}`} />
                  {metric.label}
                </span>
                <span className="usage-metric-value" title={formatExact(metric.value)}>
                  {formatTokenCount(metric.value)}
                </span>
              </div>
              <div className="usage-metric-bar" aria-hidden="true">
                <span
                  className={`usage-metric-fill ${metric.tone}`}
                  style={{ width: `${Math.max(metric.share, metric.value > 0 ? 1.5 : 0)}%` }}
                />
              </div>
              <div className="usage-metric-meta">
                <span>{metric.detail}</span>
                <span>{metric.shareLabel}</span>
              </div>
            </div>
          ))}
        </div>
      </SettingsChoiceGroup>

      {report.breakdown.length > 0 && (
        <SettingsChoiceGroup title={t("settings.usageByModel")}>
          <div className="usage-model-list">
            {report.breakdown.map((item) => (
              <ModelUsageCard
                key={`${item.provider}:${item.model}`}
                item={item}
                totalTokens={report.totalTokens}
              />
            ))}
          </div>
        </SettingsChoiceGroup>
      )}
    </div>
  );
}

function ModelUsageCard({
  item,
  totalTokens,
}: {
  item: TokenUsageReportBreakdown;
  totalTokens: number;
}) {
  const share = pct(item.totalTokens, totalTokens);
  const cacheHit =
    item.promptTokens > 0 ? pct(item.cacheReadTokens, item.promptTokens) : 0;

  return (
    <article className="usage-model-card">
      <header className="usage-model-card-head">
        <div className="usage-model-identity">
          <ProviderIcon provider={item.provider} size={22} className="settings-provider-glyph usage-model-icon" />
          <div className="usage-model-name">
            <strong title={item.model}>{item.model}</strong>
            <small title={item.provider}>{providerLabel(item.provider)}</small>
          </div>
        </div>
        <div className="usage-model-totals">
          <strong title={formatExact(item.totalTokens)}>{formatTokenCount(item.totalTokens)}</strong>
          <small>{share.toFixed(1)}%</small>
        </div>
      </header>

      <div className="usage-model-share" aria-hidden="true">
        <span style={{ width: `${Math.max(share, item.totalTokens > 0 ? 1.5 : 0)}%` }} />
      </div>

      <div className="usage-model-stats">
        <span>
          <em>{t("settings.tokenUsagePrompt")}</em>
          <b title={formatExact(item.promptTokens)}>{formatTokenCount(item.promptTokens)}</b>
        </span>
        <span>
          <em>{t("settings.tokenUsageCompletion")}</em>
          <b title={formatExact(item.completionTokens)}>{formatTokenCount(item.completionTokens)}</b>
        </span>
        <span>
          <em>{t("settings.tokenUsageTasks")}</em>
          <b>{item.tasks}</b>
        </span>
        {item.estimatedCostUsd > 0 && (
          <span>
            <em>{t("settings.tokenUsageEstimatedCost")}</em>
            <b title={`$${item.estimatedCostUsd.toFixed(6)}`}>{formatCost(item.estimatedCostUsd)}</b>
          </span>
        )}
        {item.reasoningTokens > 0 && (
          <span>
            <em>{t("settings.tokenUsageReasoning")}</em>
            <b title={formatExact(item.reasoningTokens)}>{formatTokenCount(item.reasoningTokens)}</b>
          </span>
        )}
        {item.cacheReadTokens > 0 && (
          <span>
            <em>{t("settings.usageCacheHitRate")}</em>
            <b>{cacheHit.toFixed(1)}%</b>
          </span>
        )}
      </div>
    </article>
  );
}

type MetricTone = "is-input" | "is-output" | "is-reasoning" | "is-cache" | "is-cache-write";

function buildMetrics(report: TokenUsageReport) {
  const rows: Array<{
    id: string;
    label: string;
    value: number;
    share: number;
    shareLabel: string;
    detail: string;
    tone: MetricTone;
  }> = [
    {
      id: "prompt",
      label: t("settings.usageInputTokens"),
      value: report.promptTokens,
      share: pct(report.promptTokens, report.totalTokens),
      shareLabel: `${pct(report.promptTokens, report.totalTokens).toFixed(1)}%`,
      detail: t("settings.usageInputDetail"),
      tone: "is-input",
    },
    {
      id: "completion",
      label: t("settings.usageOutputTokens"),
      value: report.completionTokens,
      share: pct(report.completionTokens, report.totalTokens),
      shareLabel: `${pct(report.completionTokens, report.totalTokens).toFixed(1)}%`,
      detail: t("settings.usageOutputDetail"),
      tone: "is-output",
    },
  ];

  if (report.reasoningTokens > 0) {
    rows.push({
      id: "reasoning",
      label: t("settings.tokenUsageReasoning"),
      value: report.reasoningTokens,
      share: pct(report.reasoningTokens, report.totalTokens),
      shareLabel: `${pct(report.reasoningTokens, report.completionTokens).toFixed(1)}% ${t("settings.usageOfOutput")}`,
      detail: t("settings.usageReasoningDetail"),
      tone: "is-reasoning",
    });
  }

  if (report.cacheReadTokens > 0) {
    rows.push({
      id: "cache-read",
      label: t("settings.usageInputCache"),
      value: report.cacheReadTokens,
      share: pct(report.cacheReadTokens, report.totalTokens),
      shareLabel: `${pct(report.cacheReadTokens, report.promptTokens).toFixed(1)}% ${t("settings.usageOfInput")}`,
      detail: t("settings.usageCacheReadDetail"),
      tone: "is-cache",
    });
  }

  if (report.cacheWriteTokens > 0) {
    rows.push({
      id: "cache-write",
      label: t("settings.usageOutputCache"),
      value: report.cacheWriteTokens,
      share: pct(report.cacheWriteTokens, report.totalTokens),
      shareLabel: `${pct(report.cacheWriteTokens, report.totalTokens).toFixed(1)}%`,
      detail: t("settings.usageCacheWriteDetail"),
      tone: "is-cache-write",
    });
  }

  return rows;
}

function pct(part: number, whole: number): number {
  if (!whole || whole <= 0 || !Number.isFinite(part)) return 0;
  return (part / whole) * 100;
}

export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}k`;
  return String(Math.round(n));
}

function formatExact(n: number): string {
  return `${Math.round(n).toLocaleString()} tokens`;
}

function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "—";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function UsageChartIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" aria-hidden="true">
      <rect x="3.5" y="12" width="3.5" height="7.5" rx="1" fill="currentColor" opacity="0.35" />
      <rect x="9" y="8" width="3.5" height="11.5" rx="1" fill="currentColor" opacity="0.55" />
      <rect x="14.5" y="5" width="3.5" height="14.5" rx="1" fill="currentColor" opacity="0.75" />
      <path d="M4 4.5h16" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.35" />
    </svg>
  );
}

function UsageAlertIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 8v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="12" cy="16" r="0.9" fill="currentColor" />
    </svg>
  );
}
