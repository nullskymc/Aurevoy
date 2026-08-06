/**
 * Timeline — 三层式步骤时间轴组件。
 *
 * 将 Agent 的工具调用与计划步骤重组为：
 *   顶层（Summary） → 中层（Steps） → 底层（Details）
 *
 * 支持历史回看与实时执行两种模式。
 */
import { memo, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, MotionConfig } from "framer-motion";
import type {
  ContentBlock,
  TaskRecallSummary,
} from "@aurevoy/shared";
import { MarkdownRenderer, StreamingMarkdownRenderer } from "./MarkdownRenderer";
import { usePlatform } from "../platform/context";
import { t } from "../i18n";
import { ContextMenu } from "./ContextMenu";
import { CanvasCard } from "./generative-ui/CanvasCard";
import type { ContextMenuItem } from "./ContextMenu";
import {
  buildFileMenuItems,
  buildLinkMenuItems,
  contextMenuPoint,
  type ContextMenuState,
} from "./contextMenuActions";
import { getPlanStepStatusLabel } from "./planStatus";
import {
  IconAlertCircle,
  IconBan,
  IconBot,
  IconChevron,
  IconClock,
  IconExternal,
  IconFile,
  IconGlobe,
  IconLoader,
  IconPencil,
  IconTerminal,
} from "../icons";
import "./Timeline.css";

/* ============ 纯数据构建 ============ */
import type {
  AgentRoundData,
  PlanStepGroupData,
  TimelineStepData,
} from "./timelineData";
import {
  flattenProcessActivityRows,
  formatProcessedSummaryLabel,
  formatProcessingSummaryLabel,
} from "./timelineProcessData";
import type { ProcessActivityRow, ProcessSegmentData } from "./timelineProcessData";
import { useTimelineRoundViewModel } from "./useTimelineRoundViewModel";

export {
  buildAgentRoundFromMessage,
  buildLiveAgentRoundData,
  computeSummaryFromSteps,
  dedupeContentBlocks,
  truncateTitle,
} from "./timelineData";
export {
  flattenProcessActivityRows,
  formatProcessedSummaryLabel,
  formatProcessingSummaryLabel,
  mergeAgentRoundData,
  normalizeLiveStatus,
  resolveLiveStatusText,
} from "./timelineProcessData";
export type { AgentRoundData, PlanStepGroupData, StepKind, TimelineStepData } from "./timelineData";
export type { ProcessActivityRow, ProcessSegmentData } from "./timelineProcessData";

/* ============ 组件 ============ */

/** 步骤状态图标组件 */
function StepStatus({ status }: { status: TimelineStepData["status"] }) {
  if (status === "running") return <span className="timeline-step-status is-running">运行中</span>;
  if (status === "failed") return <span className="timeline-step-status is-failed">失败</span>;
  if (status === "cancelled") return <span className="timeline-step-status is-cancelled">已取消</span>;
  return null;
}

function StepGlyph({ step }: { step: TimelineStepData }) {
  if (step.status === "running") {
    return (
      <span className="timeline-step-glyph is-running" aria-hidden="true">
        <IconLoader size={15} />
      </span>
    );
  }
  if (step.status === "cancelled") {
    return (
      <span className="timeline-step-glyph is-cancelled" aria-hidden="true">
        <IconBan size={15} />
      </span>
    );
  }
  if (step.kind === "search" || step.kind === "browse") {
    return (
      <span className="timeline-step-glyph" aria-hidden="true">
        <IconGlobe size={15} />
      </span>
    );
  }
  if (step.status === "failed") {
    return (
      <span className="timeline-step-glyph is-failed" aria-hidden="true">
        <IconAlertCircle size={15} />
      </span>
    );
  }
  return (
    <span className="timeline-step-glyph" aria-hidden="true">
      <IconClock size={15} />
    </span>
  );
}

function stepDisplayLabel(step: TimelineStepData): string {
  if (step.toolName === "web_search" || step.toolName === "search_grep" || step.toolName === "grep" || step.toolName === "glob") return "Searched";
  if (step.toolName === "web_fetch") return "Fetched URL";
  if (step.kind === "browse") return "Opened page";
  if (step.kind === "file_read") return "Read file";
  if (step.kind === "file_write") return "Wrote file";
  if (step.kind === "edit") return "Edited file";
  if (step.kind === "command") return "Ran command";
  return step.toolName ?? "Ran tool";
}

/** 单个 Timeline 步骤（旧树形详情；主路径已改为扁平 process list） */
function TimelineStepNode({
  step,
  defaultOpen,
  autoOpenRunning = true,
  onAutoCollapse,
}: {
  step: TimelineStepData;
  defaultOpen?: boolean;
  autoOpenRunning?: boolean;
  onAutoCollapse?: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen ?? (autoOpenRunning && step.status === "running"));
  const prevStatusRef = useRef(step.status);

  // Context menu
  const [ctxMenu, setCtxMenu] = useState<{
    open: boolean;
    point?: { x: number; y: number };
    items: ContextMenuItem[];
  }>({ open: false, items: [] });

  function handleStepContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = [
      {
        type: "item",
        id: "copy-title",
        label: "复制标题",
        action: () => navigator.clipboard.writeText(step.title).catch(() => {}),
      },
      ...(step.toolName
        ? [
            {
              type: "item" as const,
              id: "copy-tool-name",
              label: "复制工具名",
              action: () => navigator.clipboard.writeText(step.toolName!).catch(() => {}),
            },
          ]
        : []),
      ...(step.args && Object.keys(step.args).length > 0
        ? [
            {
              type: "item" as const,
              id: "copy-args",
              label: "复制参数",
              action: () =>
                navigator.clipboard
                  .writeText(JSON.stringify(step.args, null, 2))
                  .catch(() => {}),
            },
          ]
        : []),
      ...(step.output
        ? [
            {
              type: "item" as const,
              id: "copy-output",
              label: "复制输出",
              action: () => navigator.clipboard.writeText(step.output!).catch(() => {}),
            },
          ]
        : []),
      ...(step.error
        ? [
            {
              type: "item" as const,
              id: "copy-error",
              label: "复制错误信息",
              action: () => navigator.clipboard.writeText(step.error!).catch(() => {}),
            },
          ]
        : []),
    ];
    setCtxMenu({
      open: true,
      point: contextMenuPoint(e),
      items,
    });
  }

  // 自动展开/折叠逻辑
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = step.status;
    if (autoOpenRunning && step.status === "running") {
      setOpen(true);
    } else if (prev === "running" && (step.status === "success" || step.status === "failed")) {
      // 刚完成：短暂停留后折叠（成功）或保持展开（失败）
      if (step.status === "success") {
        const timer = setTimeout(() => {
          setOpen(false);
          onAutoCollapse?.();
        }, 800);
        return () => clearTimeout(timer);
      }
      // 失败保持展开
    }
  }, [autoOpenRunning, step.status]);

  const hasDetails = step.logs != null || step.error != null || step.output != null || (step.status === "running" && step.progress != null);
  const searchPreview = buildSearchPreview(step);

  return (
    <motion.div
      className="timeline-step"
      data-status={step.status}
      onContextMenu={handleStepContextMenu}
      variants={{
        hidden: { opacity: 0, y: -8 },
        show: { opacity: 1, y: 0 },
      }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      layout
    >
      <div className="timeline-step-header">
        <StepGlyph step={step} />
        <button
          type="button"
          className="timeline-step-title-btn"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className="timeline-step-tool">{stepDisplayLabel(step)}</span>
          {step.title && <span className="timeline-step-title">{step.title}</span>}
            <StepStatus status={step.status} />
          {hasDetails && (
            <span className="timeline-step-caret" data-open={open}>
              <IconChevron size={10} />
            </span>
          )}
        </button>
      </div>

      <AnimatePresence initial={false}>
        {open && hasDetails && (
          <motion.div
            className="timeline-step-details"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ height: { duration: 0.2, ease: "easeOut" }, opacity: { duration: 0.12 } }}
          >
            {searchPreview ? (
              <SearchPreviewView preview={searchPreview} />
            ) : step.logs ? (
              <div className="timeline-step-log">
                <pre>{step.logs}</pre>
              </div>
            ) : step.output ? (
              <div className="timeline-step-log">
                <pre>{step.output}</pre>
              </div>
            ) : null}
            {step.error && (
              <div className="timeline-step-error">
                <IconAlertCircle size={12} />
                <span>{step.error}</span>
              </div>
            )}
            {step.status === "running" && step.progress && (
              <div className="timeline-step-log is-running">
                <div className="timeline-step-progress">
                  {step.progress.percent != null ? (
                    <div className="progress-bar">
                      <div className="progress-bar-fill" style={{ width: `${step.progress.percent}%` }} />
                    </div>
                  ) : (
                    <span className="stream-caret" />
                  )}
                  <span className="progress-text">{step.progress.message}</span>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <ContextMenu
        items={ctxMenu.items}
        open={ctxMenu.open}
        anchorPoint={ctxMenu.point}
        onClose={() => setCtxMenu((p) => ({ ...p, open: false }))}
      />
    </motion.div>
  );
}

interface SearchPreviewResult {
  title: string;
  url: string;
  snippet?: string;
  host: string;
}

interface SearchPreviewData {
  untrusted: boolean;
  query: string;
  resultCount: number;
  results: SearchPreviewResult[];
}

function buildSearchPreview(step: TimelineStepData): SearchPreviewData | null {
  if (step.toolName !== "web_search") return null;
  const source = normalizeSearchOutput(step.rawOutput ?? step.output);
  if (!source) return null;
  const query = source.query || (typeof step.args?.query === "string" ? step.args.query : "");
  const results = source.results.slice(0, 6).map((item) => ({
    title: item.title,
    url: item.url,
    snippet: item.snippet,
    host: hostFromUrl(item.url),
  }));
  return {
    untrusted: source.untrusted,
    query,
    resultCount: source.resultCount || source.results.length,
    results,
  };
}

function normalizeSearchOutput(value: unknown): { untrusted: boolean; query: string; resultCount: number; results: SearchPreviewResult[] } | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const rawResults = Array.isArray(record.results) ? record.results : [];
  const results = rawResults
    .map((item): SearchPreviewResult | null => {
      if (!item || typeof item !== "object") return null;
      const result = item as Record<string, unknown>;
      const title = typeof result.title === "string" ? result.title : "";
      const url = typeof result.url === "string" ? result.url : typeof result.link === "string" ? result.link : "";
      if (!title || !url) return null;
      const snippet = typeof result.snippet === "string"
        ? result.snippet
        : typeof result.content === "string"
          ? result.content
          : undefined;
      return { title, url, snippet, host: hostFromUrl(url) };
    })
    .filter((item): item is SearchPreviewResult => item !== null);
  return {
    untrusted: record.untrusted === true,
    query: typeof record.query === "string" ? record.query : "",
    resultCount: typeof record.resultCount === "number" ? record.resultCount : results.length,
    results,
  };
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function SearchPreviewView({ preview }: { preview: SearchPreviewData }) {
  const platform = usePlatform();
  return (
    <div className="timeline-search-preview">
      <div className="timeline-search-head">
        <span className="timeline-search-query">{preview.query || "web search"}</span>
        {preview.untrusted ? <span className="timeline-search-untrusted">{t("timeline.externalUntrusted")}</span> : null}
        <span className="timeline-search-count">{preview.resultCount} result{preview.resultCount === 1 ? "" : "s"}</span>
      </div>
      {preview.results.length > 0 ? (
        <div className="timeline-search-results">
          {preview.results.map((result, index) => (
            <a
              key={`${result.url}-${index}`}
              className="timeline-search-result"
              href={result.url}
              title={result.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => {
                event.preventDefault();
                void platform.openExternal?.(result.url);
              }}
            >
              <span className="timeline-search-favicon" aria-hidden="true">{result.host.slice(0, 1).toUpperCase()}</span>
              <span className="timeline-search-result-main">
                <span className="timeline-search-result-title">{result.title}</span>
                {result.snippet && <span className="timeline-search-snippet">{result.snippet}</span>}
              </span>
              <span className="timeline-search-host">{result.host}</span>
            </a>
          ))}
        </div>
      ) : (
        <div className="timeline-search-empty">No results</div>
      )}
    </div>
  );
}

interface KnowledgePreviewResult {
  file: string;
  snippet: string;
  score: number;
  chunkIndex?: number;
}

interface KnowledgePreviewData {
  found: number;
  citationCount: number;
  results: KnowledgePreviewResult[];
}

function buildKnowledgePreview(step: TimelineStepData): KnowledgePreviewData | null {
  if (step.toolName !== "recall") return null;
  let value = step.rawOutput ?? step.output;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const results = (Array.isArray(record.results) ? record.results : [])
    .map((item): KnowledgePreviewResult | null => {
      if (!item || typeof item !== "object") return null;
      const result = item as Record<string, unknown>;
      const file = typeof result.file === "string"
        ? result.file
        : typeof result.filePath === "string" ? result.filePath : "";
      const snippet = typeof result.snippet === "string"
        ? result.snippet
        : typeof result.content === "string" ? result.content : "";
      if (!file || !snippet) return null;
      return {
        file,
        snippet,
        score: typeof result.score === "number" ? result.score : 0,
        chunkIndex: typeof result.chunkIndex === "number" ? result.chunkIndex : undefined,
      };
    })
    .filter((item): item is KnowledgePreviewResult => item !== null)
    .slice(0, 8);
  if (results.length === 0 && record.found !== 0) return null;
  const citations = Array.isArray(record.citations) ? record.citations.length : 0;
  return {
    found: typeof record.found === "number" ? record.found : results.length,
    citationCount: citations,
    results,
  };
}

function KnowledgePreviewView({
  preview,
  onOpenWorkspacePath,
}: {
  preview: KnowledgePreviewData;
  onOpenWorkspacePath?: (path: string) => void;
}) {
  return (
    <div className="timeline-knowledge-preview">
      <div className="timeline-search-head">
        <span className="timeline-search-query">{t("recall.knowledgeBase")}</span>
        <span className="timeline-search-count">{preview.found} · {t("recall.citations")} {preview.citationCount}</span>
      </div>
      {preview.results.length > 0 ? (
        <div className="timeline-knowledge-results">
          {preview.results.map((result, index) => (
            <div className="timeline-knowledge-result" key={`${result.file}-${result.chunkIndex ?? index}`}>
              <button
                type="button"
                className="timeline-knowledge-file"
                onClick={() => onOpenWorkspacePath?.(result.file)}
                disabled={!onOpenWorkspacePath}
                title={result.file}
              >
                {result.file}{result.chunkIndex != null ? `#${result.chunkIndex}` : ""}
              </button>
              <span className="timeline-knowledge-score">{result.score.toFixed(2)}</span>
              <p>{result.snippet}</p>
            </div>
          ))}
        </div>
      ) : (
        <div className="timeline-search-empty">{t("recall.noneUsed")}</div>
      )}
    </div>
  );
}

function ResearchSourcesView({
  data,
  onOpenWorkspacePath,
}: {
  data: AgentRoundData;
  onOpenWorkspacePath?: (path: string) => void;
}) {
  const steps = data.planStepGroups.flatMap((group) => group.steps);
  const entries = steps.flatMap((step) => {
    const search = buildSearchPreview(step);
    if (search) return [{ id: `${step.id}-search`, node: <SearchPreviewView preview={search} /> }];
    const knowledge = buildKnowledgePreview(step);
    if (knowledge) {
      return [{ id: `${step.id}-knowledge`, node: <KnowledgePreviewView preview={knowledge} onOpenWorkspacePath={onOpenWorkspacePath} /> }];
    }
    return [];
  });
  if (entries.length === 0) return null;
  return (
    <details className="research-sources">
      <summary>{t("recall.sources")}</summary>
      <div className="research-sources-body">
        {entries.map((entry) => <div key={entry.id}>{entry.node}</div>)}
      </div>
    </details>
  );
}

/** @deprecated 主对话不再渲染树形分组；保留供可选详细模式 */
export function PlanStepGroup({
  group,
  isLast,
  defaultOpen,
  autoOpenRunningTools = true,
  onStepAutoCollapse,
}: {
  group: PlanStepGroupData;
  index: number;
  isLast: boolean;
  defaultOpen?: boolean;
  autoOpenRunningTools?: boolean;
  onStepAutoCollapse?: () => void;
}) {
  const runningCount = group.steps.filter((s) => s.status === "running").length;
  const failedCount = group.steps.filter((s) => s.status === "failed").length;
  const doneCount = group.steps.filter((s) => s.status === "success").length;

  const stepContainerVariants = {
    hidden: {},
    show: { transition: { staggerChildren: 0.06 } },
  };

  const statusText =
    group.status === "blocked"
      ? getPlanStepStatusLabel("blocked")
      : runningCount > 0
        ? `${t("plan.step.running")} ${runningCount}`
        : failedCount > 0
          ? `${t("plan.step.failed")} ${failedCount}`
          : group.status === "cancelled"
            ? t("plan.step.cancelled")
          : group.status === "pending"
            ? t("plan.step.pending")
            : `${t("plan.step.completed")} ${doneCount}`;

  return (
    <motion.div
      className="timeline-plan-group"
      data-status={group.status}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      layout
    >
      {/* 计划步骤描述行 */}
      <div className="timeline-plan-head">
        <span className="timeline-plan-connector" />
        {group.description && (
          <span className="timeline-plan-desc">
            {group.description}
            <span className="timeline-plan-count">
              <span
                className={
                  group.status === "failed" || group.status === "blocked" || group.status === "cancelled"
                    ? `timeline-plan-status-text is-${group.status}`
                    : "timeline-plan-status-text"
                }
              >
                {statusText}
              </span>
            </span>
          </span>
        )}
      </div>
      {group.blockedReason ? (
        <p className="timeline-plan-blocked-reason" role="status">
          {group.blockedReason}
        </p>
      ) : null}

      {/* 步骤列表 */}
      {group.steps.length > 0 && (
        <motion.div
          className="timeline-plan-steps"
          variants={stepContainerVariants}
          initial="hidden"
          animate="show"
        >
          {group.steps.map((step) => (
            <TimelineStepNode
              key={step.id}
              step={step}
              defaultOpen={defaultOpen}
              autoOpenRunning={autoOpenRunningTools}
              onAutoCollapse={onStepAutoCollapse}
            />
          ))}
        </motion.div>
      )}

      {/* 分组尾部连接线 */}
      {!isLast && <div className="timeline-plan-trail" />}
    </motion.div>
  );
}

/* ============ 内容块渲染 ============ */

/** Agent 通过 attach_content / present_ui 工具附加的富内容块。 */
function ContentBlockView({
  block,
  onOpenWorkspacePath,
}: {
  block: ContentBlock;
  /** 在侧边工作台打开文件预览（attach_content 默认行为） */
  onOpenWorkspacePath?: (path: string) => void;
}) {
  const platform = usePlatform();
  const [feedback, setFeedback] = useState<string | null>(null);

  const showFeedback = (msg: string) => {
    setFeedback(msg);
    setTimeout(() => setFeedback(null), 2000);
  };

  // Context menu for file_reference blocks
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>({ open: false, items: [] });

  function handleFileContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({
      open: true,
      point: contextMenuPoint(e),
      items: buildFileMenuItems({
        path: block.content,
        name: block.name,
        platform,
      }),
    });
  }

  function handleLinkContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({
      open: true,
      point: contextMenuPoint(e),
      items: buildLinkMenuItems({
        url: block.content,
        label: block.name,
        platform,
      }),
    });
  }

  switch (block.type) {
    case "ui":
      return block.kind === "canvas" ? <CanvasCard block={block} /> : null;
    case "file_reference": {
      const handleFileClick = async () => {
        if (onOpenWorkspacePath) {
          onOpenWorkspacePath(block.content);
          showFeedback(t("workbench.openedInSidebar"));
          return;
        }
        try {
          if (platform.openFile) {
            await platform.openFile(block.content);
            showFeedback("已打开");
            return;
          }
        } catch { /* 平台不支持打开文件，回退到复制路径 */ }
        try {
          await navigator.clipboard.writeText(block.content);
          showFeedback("已复制路径");
        } catch {
          showFeedback("无法打开文件");
        }
      };
      return (
        <>
          <div
            className={`content-block is-file ${feedback ? "is-active" : ""}`}
            onClick={handleFileClick}
            onContextMenu={handleFileContextMenu}
            title={block.content}
          >
            <IconFile className="content-block-icon" size={16} />
            <span className="content-block-name">
              {block.name || block.content.split("/").pop() || block.content}
            </span>
            {block.untrusted ? <span className="timeline-search-untrusted">{t("timeline.externalUntrusted")}</span> : null}
            <span className="content-block-path">
              {feedback || block.content}
            </span>
          </div>
          <ContextMenu
            items={ctxMenu.items}
            open={ctxMenu.open}
            anchorPoint={ctxMenu.point}
            onClose={() => setCtxMenu((p) => ({ ...p, open: false }))}
          />
        </>
      );
    }
    case "image": {
      const src = platform.filePathToUrl(block.content);
      if (!src) return null;
      return (
        <>
          <div
            className="content-block is-image"
            onClick={() => onOpenWorkspacePath?.(block.content)}
            onContextMenu={handleFileContextMenu}
            title={block.content}
            role={onOpenWorkspacePath ? "button" : undefined}
          >
            <img
              src={src}
              alt={block.name || "agent image"}
              className="content-block-image"
            />
            {block.name && <span className="content-block-caption">{block.name}</span>}
          </div>
          <ContextMenu
            items={ctxMenu.items}
            open={ctxMenu.open}
            anchorPoint={ctxMenu.point}
            onClose={() => setCtxMenu((p) => ({ ...p, open: false }))}
          />
        </>
      );
    }
    case "link": {
      return (
        <>
          <a
          className="content-block is-link"
          href={block.content}
          onClick={(event) => {
            event.preventDefault();
            void platform.openExternal?.(block.content);
          }}
          onContextMenu={handleLinkContextMenu}
          target="_blank"
          rel="noopener noreferrer"
        >
          <IconExternal className="content-block-icon" size={14} />
          <span>{block.name || block.content}</span>
        </a>
          <ContextMenu
            items={ctxMenu.items}
            open={ctxMenu.open}
            anchorPoint={ctxMenu.point}
            onClose={() => setCtxMenu((p) => ({ ...p, open: false }))}
          />
        </>
      );
    }
    default:
      return null;
  }
}
function ProcessActivityIcon({ icon }: { icon?: ProcessActivityRow["icon"] }) {
  if (icon === "search" || icon === "browse") {
    return <IconGlobe size={14} />;
  }
  if (icon === "agent") {
    return <IconBot size={14} />;
  }
  if (icon === "command") {
    return <IconTerminal size={14} />;
  }
  if (icon === "file") {
    return <IconFile size={14} />;
  }
  if (icon === "edit") {
    return <IconPencil size={14} />;
  }
  return <span aria-hidden="true">·</span>;
}

function LiveStatusLine({ text }: { text: string }) {
  // 工具 progress 可能每秒更新数十次；为每条文案启动进出场动画会持续打断动画。
  return <div className="process-live-status" role="status" aria-live="polite">{text}</div>;
}

/**
 * Live 过程块：
 *   已处理 10s
 *   ────────
 *   运行子智能体 · 调研：…   ← 每个子代理一行，SSE 全程保留
 *   正在搜索网页…            ← 无活动行时的灰字回落
 */
export function LiveProcessBlock({
  statusText,
  activityRows = [],
  startedAtMs,
  showFallbackStatus = true,
}: {
  statusText: string;
  /** 子代理/工具活动行；有则全程展示，完成后由抽屉收纳同一套 rows */
  activityRows?: ProcessActivityRow[];
  startedAtMs?: number | null;
  /** 无 activityRows 时是否显示灰字状态（有打字机正文时可关） */
  showFallbackStatus?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAtMs == null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAtMs]);

  const durationMs =
    startedAtMs != null && Number.isFinite(startedAtMs)
      ? Math.max(0, now - startedAtMs)
      : null;
  const header = formatProcessingSummaryLabel(durationMs);
  const hasRows = activityRows.length > 0;

  return (
    <div
      className="process-live-block"
      data-process="live"
      data-status-visible={hasRows || showFallbackStatus ? "true" : "false"}
    >
      <div className="process-summary-static">{header}</div>
      <div className="process-summary-rule is-always" aria-hidden="true" />
      {hasRows ? <ProcessActivityList rows={activityRows} live /> : null}
      {!hasRows && showFallbackStatus ? <LiveStatusLine text={statusText} /> : null}
    </div>
  );
}

export const ProcessActivityList = memo(function ProcessActivityList({
  rows,
  live = false,
}: {
  rows: ProcessActivityRow[];
  /** live 列表不折叠，始终展开 */
  live?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <ul
      className="process-activity-list"
      data-live={live ? "true" : undefined}
      aria-label="执行过程"
    >
      {rows.map((row) => (
        <li
          key={row.id}
          className="process-activity-row"
          data-kind={row.kind}
          data-status={row.status}
          data-icon={row.icon}
        >
          <span className="process-activity-icon" aria-hidden="true">
            <ProcessActivityIcon icon={row.icon} />
          </span>
          <span className="process-activity-label">{row.label}</span>
        </li>
      ))}
    </ul>
  );
}, (previous, next) => {
  if (previous.live !== next.live || previous.rows.length !== next.rows.length) return false;
  return previous.rows.every((row, index) => {
    const candidate = next.rows[index];
    return candidate != null
      && row.id === candidate.id
      && row.status === candidate.status
      && row.label === candidate.label
      && row.detail === candidate.detail
      && row.icon === candidate.icon
      && row.kind === candidate.kind;
  });
});

function CompletedProcess({
  data,
  defaultOpen = false,
  durationMs,
  segments,
  onOpenWorkspacePath,
}: {
  data: AgentRoundData;
  defaultOpen?: boolean;
  durationMs?: number | null;
  segments?: ProcessSegmentData[];
  onOpenWorkspacePath?: (path: string) => void;
}) {
  const rows = flattenProcessActivityRows(data);
  const stepCount = data.planStepGroups.reduce((acc, g) => acc + g.steps.length, 0);
  const subagentCount = data.subagentRuns?.length ?? 0;
  if (rows.length === 0 && stepCount === 0 && subagentCount === 0) return null;

  const [open, setOpen] = useState(defaultOpen);
  const label = formatProcessedSummaryLabel({
    stepCount,
    subagentCount,
    durationMs,
    failed: data.status === "failed",
    cancelled: data.status === "cancelled",
  });

  return (
    <div className="process-completed" data-status={data.status} data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="process-summary-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="process-summary-label">{label}</span>
        <span className="process-summary-caret" data-open={open ? "true" : "false"} aria-hidden="true">
          ▾
        </span>
      </button>
      <div className="process-summary-rule is-always" aria-hidden="true" />
      {open && segments && segments.length > 0 ? (
        <div className="process-completed-segments">
          {segments.map((segment) => (
            <section key={segment.id} className="process-completed-segment" data-message-id={segment.id}>
              {segment.narration && (
                <article className="process-completed-narration">
                  <MarkdownRenderer content={segment.narration} onOpenWorkspacePath={onOpenWorkspacePath} />
                </article>
              )}
              {segment.activityRows.length > 0 && <ProcessActivityList rows={segment.activityRows} />}
            </section>
          ))}
        </div>
      ) : open ? (
        <ProcessActivityList rows={rows} />
      ) : null}
    </div>
  );
}

/** 展示本轮自动召回的来源状态；只呈现计数和状态，不把隐藏正文混入对话。 */
export function RecallSummaryView({ summary }: { summary?: TaskRecallSummary }) {
  if (!summary) return null;
  const sources = [
    { key: "memory", label: t("recall.memory"), value: summary.memory },
    { key: "knowledgeBase", label: t("recall.knowledgeBase"), value: summary.knowledgeBase },
  ];
  const enabledSources = sources.filter((source) => source.value.enabled);
  if (enabledSources.length === 0) return null;
  const usedCount = enabledSources.filter((source) => source.value.status === "used").length;
  return (
    <details className="recall-summary" data-used-count={usedCount}>
      <summary>
        <span>{t("recall.summary")}</span>
        <span className="recall-summary-count">
          {usedCount > 0 ? `${usedCount}/${enabledSources.length}` : t("recall.noneUsed")}
        </span>
      </summary>
      <div className="recall-summary-body">
        {sources.map((source) => (
          <div className="recall-summary-row" key={source.key} data-status={source.value.status}>
            <span className="recall-summary-label">{source.label}</span>
            <span className="recall-summary-status">
              {source.value.enabled ? t(`recall.status.${source.value.status}` as "recall.status.disabled") : t("recall.status.disabled")}
              {source.value.enabled && source.value.count > 0 ? ` · ${source.value.count}` : ""}
              {source.value.enabled && source.value.citationCount > 0 ? ` · ${t("recall.citations")} ${source.value.citationCount}` : ""}
            </span>
          </div>
        ))}
        <p className="recall-summary-hint">{t("recall.settingsHint")}</p>
      </div>
    </details>
  );
}

/**
 * AgentRound — 单轮 Agent 呈现。
 * live：状态流（无工具卡时间轴）；完成后：可展开扁平活动列表 + 裸 Markdown 交付。
 */
export function AgentRound({
  data,
  busy = false,
  defaultToolDetailsOpen = false,
  showWorkflow = true,
  showOutput = true,
  phaseDetail,
  /** live 计时起点（ms epoch）；缺省不显示秒数 */
  processStartedAtMs,
  /** 完成后的耗时（ms） */
  processDurationMs,
  /** 完成态按 assistant message 保留的叙事—工具有序分段。 */
  processSegments,
  onOpenWorkspacePath,
}: {
  data: AgentRoundData;
  busy?: boolean;
  defaultToolDetailsOpen?: boolean;
  showWorkflow?: boolean;
  showOutput?: boolean;
  phaseDetail?: string;
  processStartedAtMs?: number | null;
  processDurationMs?: number | null;
  processSegments?: ProcessSegmentData[];
  onOpenWorkspacePath?: (path: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    hasProcess,
    showDelivery,
    liveStatusText,
    activityRows,
    contentBlocks,
  } = useTimelineRoundViewModel({ data, busy, showOutput, phaseDetail });

  const outputNode = showDelivery ? (
    <article className={`timeline-output process-delivery${busy ? " is-streaming" : ""}`}>
      <div className="doc-body process-delivery-body">
        {busy
          ? <StreamingMarkdownRenderer content={data.markdownOutput!} onOpenWorkspacePath={onOpenWorkspacePath} />
          : <MarkdownRenderer content={data.markdownOutput!} onOpenWorkspacePath={onOpenWorkspacePath} />}
      </div>
    </article>
  ) : null;

  const contentBlocksNode = showOutput && contentBlocks.length > 0 ? (
    <div className="content-blocks">
      {contentBlocks.map((block) => (
        <ContentBlockView
          key={block.id}
          block={block}
          onOpenWorkspacePath={onOpenWorkspacePath}
        />
      ))}
    </div>
  ) : null;

  const sourceNode = showOutput && !busy
    ? <ResearchSourcesView data={data} onOpenWorkspacePath={onOpenWorkspacePath} />
    : null;

  const processNode = showWorkflow ? (
    busy ? (
      <LiveProcessBlock
        statusText={liveStatusText}
        activityRows={activityRows}
        startedAtMs={processStartedAtMs}
        // 已有活动行时不靠灰字；无行且未在打字机交付时显示「正在思考」等
        showFallbackStatus={!showDelivery && activityRows.length === 0}
      />
    ) : hasProcess ? (
      <CompletedProcess
        data={data}
        defaultOpen={defaultToolDetailsOpen}
        durationMs={processDurationMs}
        segments={processSegments}
        onOpenWorkspacePath={onOpenWorkspacePath}
      />
    ) : null
  ) : null;

  // live：状态在前；完成后：摘要在交付之前（与 Codex 一致）
  return (
    <MotionConfig reducedMotion="user">
      <div
        ref={containerRef}
        className={`timeline-agent-round process-agent-round ${busy ? "is-live" : ""} ${data.status === "failed" ? "is-failed" : data.status === "cancelled" ? "is-cancelled" : ""}`}
        data-status={data.status}
        data-process={busy ? "live" : hasProcess ? "completed" : "none"}
      >
        {processNode}
        {outputNode}
        {sourceNode}
        {contentBlocksNode}
      </div>
    </MotionConfig>
  );
}
