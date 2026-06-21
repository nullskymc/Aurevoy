/**
 * ThinkingTimeline — Agent 推理过程时间轴组件。
 *
 * 将 Agent 的 think/command/done 阶段渲染为垂直时间轴，每个"思考块"支持折叠/展开动画，
 * 折叠时显示一句话摘要。本组件为纯展示组件，不管理 SSE 事件流：
 * - fullText 在流式过程中逐步更新
 * - summary 在 SSE 完成由父组件设置
 * - summary 为 undefined 或空字符串时渲染骨架屏
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n";

/* ============ 类型定义 ============ */

/** 思考块数据 */
export interface ThinkingBlock {
  id: string;
  phase: number;
  summary: string;
  fullText: string;
  defaultOpen?: boolean;
}

/** 命令执行块 */
export interface CommandBlock {
  id: string;
  cmd: string;
}

/** 任务完成块 */
export interface DoneBlock {
  id: string;
  text: string;
  count?: number;
}

export type TimelineItem =
  | { type: "thinking"; data: ThinkingBlock }
  | { type: "command"; data: CommandBlock }
  | { type: "done"; data: DoneBlock };

export interface ThinkingTimelineProps {
  userMessage: string;
  items: TimelineItem[];
}

/* ============ 内联 SVG 图标 ============ */

/** 大脑图标（思考过程 header） */
function BrainIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10" cy="10" r="3" stroke="currentColor" strokeWidth="1.2" />
      <path d="M10 3v4M10 13v4M3 10h4M13 10h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/** 星号图标（summary 行前缀） */
function StarIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none">
      <path
        d="M8 1.5l1.8 3.7 4.2.6-3 3 .7 4.2L8 11.2l-3.7 2 .7-4.2-3-3 4.2-.6L8 1.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 绿色勾选图标（done card） */
function CheckCircleIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none">
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6.5 10l2.5 2.5L14 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ============ 子组件 ============ */

/**
 * ThinkingCard — 折叠/展开思考块。
 *
 * 动画时序：
 * - 折叠（收起）：全文淡出 + 摘要淡入，300ms 同步
 * - 展开：摘要淡出（250ms）→ 间隔（150ms）→ 全文淡入（350ms）
 */
export function ThinkingCard({ data }: { data: ThinkingBlock }) {
  const [expanded, setExpanded] = useState(data.defaultOpen !== false);
  const [animating, setAnimating] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    };
  }, []);

  const handleToggle = useCallback(() => {
    if (animating) return;
    setAnimating(true);

    if (expanded) {
      // 折叠：全文淡出 + 摘要淡入，300ms 同时完成
      setExpanded(false);
      timerRef.current = window.setTimeout(() => setAnimating(false), 300);
    } else {
      // 展开：摘要淡出 250ms，等待 150ms，全文淡入 350ms
      setExpanded(true);
      timerRef.current = window.setTimeout(() => setAnimating(false), 250 + 150 + 350);
    }
  }, [expanded, animating]);

  // 渲染可见性：折叠时显示摘要，展开时显示全文
  const showSummary = !expanded || (expanded && animating);
  const showBody = expanded || (!expanded && animating);

  const hasSummary = data.summary.length > 0;

  // 展开动画期间，摘要使用 250ms 过渡，全文使用 350ms 过渡并延迟 400ms
  const summaryTransition = expanded && animating ? "250ms" : undefined;
  const bodyTransition = expanded && animating ? "350ms" : undefined;
  const bodyDelay = expanded && animating ? "400ms" : undefined;

  return (
    <div className="thinking-timeline-card">
      {/* 卡片头部（思考过程 + 折叠/展开按钮） */}
      <button
        type="button"
        className="thinking-timeline-card-header"
        onClick={handleToggle}
        aria-expanded={expanded}
      >
        <span className="thinking-timeline-card-icon">
          <BrainIcon />
        </span>
        <span className="thinking-timeline-card-label">
          {t("thinking.label")}
        </span>
        <span className="thinking-timeline-card-toggle">
          {expanded ? t("thinking.collapse") : t("thinking.expand")}
          <span className="thinking-timeline-chevron" data-expanded={expanded}>
            ▼
          </span>
        </span>
      </button>

      {/* 摘要行：折叠时可见，展开时隐藏 */}
      <div
        className="thinking-timeline-summary-wrap"
        data-visible={showSummary}
        style={{
          transitionDuration: summaryTransition,
        } as React.CSSProperties}
      >
        <div className="thinking-timeline-summary-inner">
          <span className="thinking-timeline-summary-icon">
            <StarIcon />
          </span>
          {hasSummary ? (
            <span className="thinking-timeline-summary-text">{data.summary}</span>
          ) : (
            <div className="thinking-timeline-skeleton" />
          )}
        </div>
      </div>

      {/* 全文展开区：展开时可见，折叠时隐藏 */}
      <div
        className="thinking-timeline-body-wrap"
        data-visible={showBody}
        style={{
          transitionDuration: bodyTransition,
          transitionDelay: bodyDelay,
        } as React.CSSProperties}
      >
        <div className="thinking-timeline-body-inner">{data.fullText}</div>
      </div>
    </div>
  );
}

/** CommandCard — 命令执行卡片 */
function CommandCard({ cmd }: { cmd: string }) {
  return (
    <div className="thinking-timeline-cmd-card">
      <span className="thinking-timeline-cmd-label">[{t("thinking.cmd")}]</span>
      <span className="thinking-timeline-cmd-text">{cmd}</span>
      <span className="thinking-timeline-cmd-chevron" aria-hidden="true">›</span>
    </div>
  );
}

/** DoneCard — 任务完成卡片 */
function DoneCard({ text, count }: { text: string; count?: number }) {
  return (
    <div className="thinking-timeline-done-card">
      <span className="thinking-timeline-done-check">
        <CheckCircleIcon />
      </span>
      <span className="thinking-timeline-done-text">{text}</span>
      {count != null && (
        <span className="thinking-timeline-done-badge">
          {t("thinking.complete")} {count}
        </span>
      )}
    </div>
  );
}

/** TimelineDot — 时间轴圆点 + 连接线 */
function TimelineDot({
  type,
  isLast,
}: {
  type: "thinking" | "command" | "done";
  isLast: boolean;
}) {
  return (
    <div className="thinking-timeline-dot-col">
      <div className="thinking-timeline-dot" data-type={type} aria-hidden="true" />
      <div className="thinking-timeline-line" data-hidden={isLast} />
    </div>
  );
}

/** PhaseLabel — 阶段标签 */
function PhaseLabel({ phase }: { phase: number }) {
  return (
    <div className="thinking-timeline-phase">
      {t("thinking.phase")} {phase}
    </div>
  );
}

/* ============ 主组件 ============ */

/**
 * ThinkingTimeline — 垂直时间轴。
 *
 * 将用户消息气泡渲染在时间轴上方（右侧对齐，与导轨独立），
 * 依次渲染 thinking / command / done 三个阶段的时间块。
 *
 * @example
 * <ThinkingTimeline
 *   userMessage="删除不需要的 PDF 文件"
 *   items={[
 *     { type: "thinking", data: { id: "1", phase: 1, summary: "...", fullText: "..." } },
 *     { type: "command",  data: { id: "2", cmd: "rm generate_hormuz_pdf.py" } },
 *     { type: "thinking", data: { id: "3", phase: 2, summary: "...", fullText: "..." } },
 *     { type: "done",     data: { id: "4", text: "已清理干净", count: 1 } },
 *   ]}
 * />
 */
export function ThinkingTimeline({ userMessage, items }: ThinkingTimelineProps) {
  return (
    <div className="thinking-timeline">
      {/* 用户消息气泡（独立于时间轴导轨，右侧对齐） */}
      {userMessage.length > 0 && (
        <div className="thinking-timeline-user">
          <div className="thinking-timeline-user-bubble">{userMessage}</div>
        </div>
      )}

      {/* 时间轴导轨 */}
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        switch (item.type) {
          case "thinking":
            return (
              <div key={item.data.id} className="thinking-timeline-item">
                <TimelineDot type="thinking" isLast={isLast} />
                <div className="thinking-timeline-content">
                  <PhaseLabel phase={item.data.phase} />
                  <ThinkingCard data={item.data} />
                </div>
              </div>
            );
          case "command":
            return (
              <div key={item.data.id} className="thinking-timeline-item">
                <TimelineDot type="command" isLast={isLast} />
                <div className="thinking-timeline-content">
                  <CommandCard cmd={item.data.cmd} />
                </div>
              </div>
            );
          case "done":
            return (
              <div key={item.data.id} className="thinking-timeline-item">
                <TimelineDot type="done" isLast={isLast} />
                <div className="thinking-timeline-content">
                  <DoneCard text={item.data.text} count={item.data.count} />
                </div>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
