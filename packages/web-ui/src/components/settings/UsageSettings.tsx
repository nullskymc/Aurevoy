import { useEffect, useMemo, useState } from "react";
import type {
  TokenUsageDailyPoint,
  TokenUsageReport,
  TokenUsageReportBreakdown,
} from "@aurevoy/shared";
import { t } from "../../i18n";
import { getTokenUsageReport } from "../../api";
import { ProviderIcon, providerLabel } from "../providerIcons";
import { SettingsChoiceGroup } from "./layout";
import {
  avgTokensPerTask,
  buildCompositionRows,
  cacheHitRate,
  composeInputShare,
  composeOutputShare,
  dailyBarHeight,
  formatCost,
  formatDayLabel,
  formatExactTokens,
  formatPct,
  formatTokenCount,
  pct,
  shareBarWidth,
  shouldShowDayLabel,
  summarizeDailyActivity,
  type UsageCompositionRow,
} from "./usageFormat";

export { formatTokenCount, formatCost, pct } from "./usageFormat";

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
          <div className="usage-skeleton usage-skeleton-glance" />
          <div className="usage-skeleton-row">
            <div className="usage-skeleton usage-skeleton-block" />
            <div className="usage-skeleton usage-skeleton-block" />
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
  const composition = useMemo(() => buildCompositionRows(report), [report]);
  const daily = report.daily ?? [];
  const dailySummary = useMemo(() => summarizeDailyActivity(daily), [daily]);
  const inputShare = composeInputShare(report.promptTokens, report.completionTokens);
  const outputShare = composeOutputShare(report.promptTokens, report.completionTokens);
  const composeBase = report.promptTokens + report.completionTokens;
  const coveragePct = pct(report.measuredTasks, report.tasks);
  const cacheHitPct = cacheHitRate(
    report.cacheReadTokens,
    report.promptTokens,
    report.cacheWriteTokens,
  );
  const topShare = report.breakdown[0]
    ? pct(report.breakdown[0].totalTokens, report.totalTokens)
    : 0;
  const avgPerTask = avgTokensPerTask(report.totalTokens, report.measuredTasks);
  const peakTokens = report.peakDay?.totalTokens ?? dailySummary.peakTokens;
  const peakDate = report.peakDay?.date ?? dailySummary.peakDate;

  return (
    <div className="usage-page">
      <SettingsChoiceGroup title={t("settings.usageOverview")}>
        <div className="usage-dashboard">
          <header className="usage-dash-head">
            <div className="usage-dash-head-copy">
              <p className="usage-dash-caption">{t("settings.usageHeroCaption")}</p>
            </div>
            <button
              type="button"
              className="settings-secondary-btn usage-refresh-btn"
              onClick={onReload}
            >
              {t("settings.refresh")}
            </button>
          </header>

          {/* Codex-style glance cards: primary numbers at a glance */}
          <div className="usage-glance" role="group" aria-label={t("settings.usageOverview")}>
            <GlanceCard
              label={t("settings.tokenUsageTotal")}
              value={formatTokenCount(report.totalTokens)}
              title={formatExactTokens(report.totalTokens)}
              hint={
                avgPerTask > 0
                  ? `${formatTokenCount(avgPerTask)} ${t("settings.usageAvgPerTask")}`
                  : t("settings.usageHeroCaption")
              }
              emphasize
            />
            <GlanceCard
              label={t("settings.tokenUsageEstimatedCost")}
              value={formatCost(report.estimatedCostUsd)}
              title={
                report.estimatedCostUsd > 0
                  ? `$${report.estimatedCostUsd.toFixed(6)}`
                  : t("settings.usageCostUnavailable")
              }
              hint={
                report.estimatedCostUsd > 0
                  ? "USD"
                  : t("settings.usageCostUnavailable")
              }
              tone="cost"
            />
            <GlanceCard
              label={t("settings.usageCoverage")}
              value={`${report.measuredTasks}/${report.tasks}`}
              hint={`${coveragePct.toFixed(0)}% ${t("settings.usageCoverageHint")}`}
            />
            <GlanceCard
              label={t("settings.usagePeakDay")}
              value={peakTokens > 0 ? formatTokenCount(peakTokens) : "—"}
              title={
                peakTokens > 0
                  ? `${peakDate ?? ""} · ${formatExactTokens(peakTokens)}`
                  : undefined
              }
              hint={
                peakTokens > 0 && peakDate
                  ? `${formatDayLabel(peakDate)} · ${dailySummary.activeDays}${t("settings.usageActiveDaysSuffix")}`
                  : t("settings.usageNoDailyActivity")
              }
            />
          </div>

          {/* Daily activity chart (task usage attributed by last report day) */}
          {daily.length > 0 && (
            <DailyActivityChart
              daily={daily}
              peakTokens={peakTokens}
              windowTokens={dailySummary.windowTokens}
              activeDays={dailySummary.activeDays}
              todayTokens={dailySummary.todayTokens}
            />
          )}

          {/* Claude-style input / output composition */}
          <section className="usage-compose-panel" aria-label={t("settings.usageComposition")}>
            <div className="usage-section-label">{t("settings.usageComposition")}</div>
            <div
              className="usage-compose-bar"
              role="img"
              aria-label={t("settings.usageComposition")}
            >
              {composeBase > 0 ? (
                <>
                  <span
                    className="usage-compose-seg is-input"
                    style={{
                      width: `${shareBarWidth(report.promptTokens, composeBase, 2)}%`,
                    }}
                  />
                  <span
                    className="usage-compose-seg is-output"
                    style={{
                      width: `${shareBarWidth(report.completionTokens, composeBase, 2)}%`,
                    }}
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
                <em title={formatExactTokens(report.promptTokens)}>
                  {formatTokenCount(report.promptTokens)} ·{" "}
                  {formatPct(report.promptTokens, report.totalTokens)}
                </em>
              </span>
              <span className="usage-legend-item">
                <i className="usage-dot is-output" />
                {t("settings.usageOutputTokens")}
                <em title={formatExactTokens(report.completionTokens)}>
                  {formatTokenCount(report.completionTokens)} ·{" "}
                  {formatPct(report.completionTokens, report.totalTokens)}
                </em>
              </span>
              {inputShare > 0 && outputShare > 0 && (
                <span className="usage-legend-ratio" aria-hidden="true">
                  {inputShare.toFixed(0)}/{outputShare.toFixed(0)}
                </span>
              )}
              {cacheHitPct != null && report.cacheReadTokens > 0 && (
                <span className="usage-legend-item">
                  <i className="usage-dot is-cache" />
                  {t("settings.usageCacheHitRate")}
                  <em>{cacheHitPct.toFixed(1)}%</em>
                </span>
              )}
              {report.breakdown.length > 0 && (
                <span className="usage-legend-item">
                  <i className="usage-dot is-output" />
                  {t("settings.usageModelsUsed")}
                  <em>
                    {report.breakdown.length}
                    {topShare > 0 ? ` · ${t("settings.usageTopModel")} ${topShare.toFixed(0)}%` : ""}
                  </em>
                </span>
              )}
            </div>
          </section>
        </div>
      </SettingsChoiceGroup>

      <SettingsChoiceGroup title={t("settings.usageBreakdown")}>
        <div className="usage-metric-list">
          {composition.map((row) => (
            <CompositionRow key={row.id} row={row} report={report} />
          ))}
        </div>
      </SettingsChoiceGroup>

      {report.breakdown.length > 0 && (
        <SettingsChoiceGroup title={t("settings.usageByModel")}>
          <div className="usage-model-list">
            {report.breakdown.map((item, index) => (
              <ModelUsageCard
                key={`${item.provider}:${item.model}`}
                item={item}
                rank={index + 1}
                totalTokens={report.totalTokens}
              />
            ))}
          </div>
        </SettingsChoiceGroup>
      )}
    </div>
  );
}

function DailyActivityChart({
  daily,
  peakTokens,
  windowTokens,
  activeDays,
  todayTokens,
}: {
  daily: TokenUsageDailyPoint[];
  peakTokens: number;
  windowTokens: number;
  activeDays: number;
  todayTokens: number;
}) {
  const hasActivity = windowTokens > 0;

  return (
    <section className="usage-daily" aria-label={t("settings.usageDailyActivity")}>
      <div className="usage-daily-head">
        <div>
          <div className="usage-section-label">{t("settings.usageDailyActivity")}</div>
          <p className="usage-daily-caption">{t("settings.usageDailyCaption")}</p>
        </div>
        <div className="usage-daily-stats">
          <span>
            <em>{t("settings.usageWindowTokens")}</em>
            <b title={formatExactTokens(windowTokens)}>{formatTokenCount(windowTokens)}</b>
          </span>
          <span>
            <em>{t("settings.usageActiveDays")}</em>
            <b>
              {activeDays}/{daily.length}
            </b>
          </span>
          <span>
            <em>{t("settings.usageToday")}</em>
            <b title={formatExactTokens(todayTokens)}>{formatTokenCount(todayTokens)}</b>
          </span>
        </div>
      </div>

      {hasActivity ? (
        <div
          className="usage-daily-chart"
          role="img"
          aria-label={t("settings.usageDailyActivity")}
          style={{ gridTemplateColumns: `repeat(${daily.length}, minmax(0, 1fr))` }}
        >
          {daily.map((point, index) => {
            const height = dailyBarHeight(point.totalTokens, peakTokens);
            const showLabel = shouldShowDayLabel(index, daily.length);
            const isPeak = peakTokens > 0 && point.totalTokens === peakTokens && point.totalTokens > 0;
            const isToday = index === daily.length - 1;
            return (
              <div
                key={point.date}
                className={`usage-daily-col${isToday ? " is-today" : ""}${isPeak ? " is-peak" : ""}`}
                title={`${point.date}: ${formatExactTokens(point.totalTokens)} · ${point.tasks} ${t("settings.tokenUsageTasks")}`}
              >
                <div className="usage-daily-bar-track">
                  <span
                    className={`usage-daily-bar${point.totalTokens > 0 ? " is-active" : ""}`}
                    style={{ height: `${height}%` }}
                  />
                </div>
                <span className={`usage-daily-tick${showLabel ? " is-visible" : ""}`}>
                  {showLabel ? formatDayLabel(point.date) : ""}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="usage-daily-empty">{t("settings.usageNoDailyActivity")}</p>
      )}
    </section>
  );
}

function GlanceCard({
  label,
  value,
  hint,
  title,
  emphasize,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  title?: string;
  emphasize?: boolean;
  tone?: "cost";
}) {
  return (
    <div className={`usage-glance-card${emphasize ? " is-emphasize" : ""}${tone === "cost" ? " is-cost" : ""}`}>
      <span className="usage-glance-label">{label}</span>
      <strong className="usage-glance-value" title={title}>
        {value}
      </strong>
      <small className="usage-glance-hint">{hint}</small>
    </div>
  );
}

function CompositionRow({
  row,
  report,
}: {
  row: UsageCompositionRow;
  report: TokenUsageReport;
}) {
  const label = compositionLabel(row.id);
  const detail = compositionDetail(row.id);
  const shareLabel =
    row.relativeOf === "input" && row.relativeShare != null
      ? `${row.relativeShare.toFixed(1)}% ${t("settings.usageOfInput")}`
      : row.relativeOf === "output" && row.relativeShare != null
        ? `${row.relativeShare.toFixed(1)}% ${t("settings.usageOfOutput")}`
        : `${row.shareOfTotal.toFixed(1)}%`;

  return (
    <div className="usage-metric-row">
      <div className="usage-metric-head">
        <span className="usage-metric-name">
          <i className={`usage-dot ${row.tone}`} />
          {label}
        </span>
        <span className="usage-metric-value" title={formatExactTokens(row.value)}>
          {formatTokenCount(row.value)}
        </span>
      </div>
      <div className="usage-metric-bar" aria-hidden="true">
        <span
          className={`usage-metric-fill ${row.tone}`}
          style={{ width: `${shareBarWidth(row.value, report.totalTokens)}%` }}
        />
      </div>
      <div className="usage-metric-meta">
        <span>{detail}</span>
        <span>{shareLabel}</span>
      </div>
    </div>
  );
}

function compositionLabel(id: string): string {
  switch (id) {
    case "prompt":
      return t("settings.usageInputTokens");
    case "completion":
      return t("settings.usageOutputTokens");
    case "reasoning":
      return t("settings.tokenUsageReasoning");
    case "cache-read":
      return t("settings.usageInputCache");
    case "cache-write":
      return t("settings.usageOutputCache");
    default:
      return id;
  }
}

function compositionDetail(id: string): string {
  switch (id) {
    case "prompt":
      return t("settings.usageInputDetail");
    case "completion":
      return t("settings.usageOutputDetail");
    case "reasoning":
      return t("settings.usageReasoningDetail");
    case "cache-read":
      return t("settings.usageCacheReadDetail");
    case "cache-write":
      return t("settings.usageCacheWriteDetail");
    default:
      return "";
  }
}

function ModelUsageCard({
  item,
  rank,
  totalTokens,
}: {
  item: TokenUsageReportBreakdown;
  rank: number;
  totalTokens: number;
}) {
  const share = pct(item.totalTokens, totalTokens);
  const cacheHit =
    cacheHitRate(item.cacheReadTokens, item.promptTokens, item.cacheWriteTokens) ?? 0;

  return (
    <article className="usage-model-card">
      <header className="usage-model-card-head">
        <div className="usage-model-identity">
          <span className="usage-model-rank" aria-label={`#${rank}`}>
            {rank}
          </span>
          <ProviderIcon
            provider={item.provider}
            size={22}
            className="settings-provider-glyph usage-model-icon"
          />
          <div className="usage-model-name">
            <strong title={item.model}>{item.model}</strong>
            <small title={item.provider}>{providerLabel(item.provider)}</small>
          </div>
        </div>
        <div className="usage-model-totals">
          <strong title={formatExactTokens(item.totalTokens)}>
            {formatTokenCount(item.totalTokens)}
          </strong>
          <small>
            {share.toFixed(1)}%
            {item.estimatedCostUsd > 0 ? ` · ${formatCost(item.estimatedCostUsd)}` : ""}
          </small>
        </div>
      </header>

      <div className="usage-model-share" aria-hidden="true">
        <span style={{ width: `${shareBarWidth(item.totalTokens, totalTokens)}%` }} />
      </div>

      <div className="usage-model-stats">
        <span>
          <em>{t("settings.tokenUsagePrompt")}</em>
          <b title={formatExactTokens(item.promptTokens)}>
            {formatTokenCount(item.promptTokens)}
          </b>
        </span>
        <span>
          <em>{t("settings.tokenUsageCompletion")}</em>
          <b title={formatExactTokens(item.completionTokens)}>
            {formatTokenCount(item.completionTokens)}
          </b>
        </span>
        <span>
          <em>{t("settings.tokenUsageTasks")}</em>
          <b>{item.tasks}</b>
        </span>
        <span>
          <em>{t("settings.tokenUsageEstimatedCost")}</em>
          <b
            title={
              item.estimatedCostUsd > 0
                ? `$${item.estimatedCostUsd.toFixed(6)}`
                : undefined
            }
          >
            {formatCost(item.estimatedCostUsd)}
          </b>
        </span>
        {item.reasoningTokens > 0 && (
          <span>
            <em>{t("settings.tokenUsageReasoning")}</em>
            <b title={formatExactTokens(item.reasoningTokens)}>
              {formatTokenCount(item.reasoningTokens)}
            </b>
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

function UsageChartIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" aria-hidden="true">
      <rect x="3.5" y="12" width="3.5" height="7.5" rx="1" fill="currentColor" opacity="0.35" />
      <rect x="9" y="8" width="3.5" height="11.5" rx="1" fill="currentColor" opacity="0.55" />
      <rect x="14.5" y="5" width="3.5" height="14.5" rx="1" fill="currentColor" opacity="0.75" />
      <path
        d="M4 4.5h16"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        opacity="0.35"
      />
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
