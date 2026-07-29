import type { PendingQueueItem } from "@aurevoy/shared";
import { t } from "../i18n";

export interface AgentStatusDockProps {
  retry: { attempt?: number; maxAttempts?: number; delayMs?: number; reason?: string } | null;
  queue: PendingQueueItem[];
  compaction: { summary?: string; tokensBefore?: number; tokensAfter?: number; automatic: boolean } | null;
  formatTokens: (value: number) => string;
  onDismissCompaction: () => void;
  onClearQueue?: (kind: "steering" | "follow_up" | "all") => void;
}

/**
 * Agent 运行期轻量状态条：重试提示、待投递队列、压缩结果。
 * 全部信息只读；只在有内容时渲染，保持输入区干净。
 */
export function AgentStatusDock({
  retry,
  queue,
  compaction,
  formatTokens,
  onDismissCompaction,
  onClearQueue,
}: AgentStatusDockProps) {
  const hasRetry = !!retry;
  const hasQueue = queue.length > 0;
  const hasCompaction = !!compaction;
  if (!hasRetry && !hasQueue && !hasCompaction) return null;

  return (
    <div className="agent-status-dock" role="status" aria-live="polite">
      {hasRetry && (
        <span className="agent-status-dock__chip agent-status-dock__chip--warn" title={retry.reason ?? undefined}>
          <span className="agent-status-dock__dot" aria-hidden="true" />
          {t("agentStatus.retrying")}
          {typeof retry.attempt === "number" && typeof retry.maxAttempts === "number"
            ? ` · ${t("agentStatus.retryDetail")
                .replace("{attempt}", String(retry.attempt))
                .replace("{maxAttempts}", String(retry.maxAttempts))}`
            : ""}
        </span>
      )}
      {hasQueue && (
        <span className="agent-status-dock__queue">
          <span
            className="agent-status-dock__chip"
            title={queue
              .map((item) => `${item.kind === "steering" ? t("agentStatus.queueSteering") : t("agentStatus.queueFollowUp")}: ${item.preview}`)
              .join("\n")}
          >
            {queue.length} {t("agentStatus.queuePending")}
          </span>
          {onClearQueue && (
            <button
              type="button"
              className="agent-status-dock__queue-clear"
              onClick={() => onClearQueue("all")}
              title={t("agentStatus.queueClearHint")}
            >
              {t("agentStatus.queueClear")}
            </button>
          )}
        </span>
      )}
      {hasCompaction && (
        <span className="agent-status-dock__chip agent-status-dock__chip--ok">
          {compaction.automatic ? t("agentStatus.compactedAuto") : t("agentStatus.compactedManual")}
          {typeof compaction.tokensBefore === "number" && typeof compaction.tokensAfter === "number"
            ? ` · ${t("agentStatus.compactedDrop")} ${formatTokens(compaction.tokensBefore)} → ${formatTokens(compaction.tokensAfter)}`
            : ""}
          <button
            type="button"
            className="agent-status-dock__dismiss"
            aria-label={t("a11y.closeNotice")}
            onClick={onDismissCompaction}
          >
            ×
          </button>
        </span>
      )}
    </div>
  );
}
