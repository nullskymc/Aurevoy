import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ClarificationRequest,
  ContentBlock,
  Message,
  MessageAttachment,
  PlanStep,
  RevertMode,
  Task,
  TaskPhase,
  TaskStatus,
  ToolRiskLevel,
} from "@aurevoy/shared";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ImageViewer } from "./ImageViewer";
import { t } from "../i18n";
import { AgentRound, buildAgentRoundFromMessage, buildLiveAgentRoundData } from "./Timeline";
import { ThinkingCard } from "./ThinkingTimeline";
import { usePlatform } from "../platform/context";

/** 一次工具调用在 UI 中的活动状态（由 App 从事件或消息派生） */
export interface ToolActivity {
  id: string;
  name: string;
  args: unknown;
  status: "awaiting" | "running" | "ok" | "error";
  riskLevel?: ToolRiskLevel;
  output?: unknown;
  error?: string;
}

interface ConversationProps {
  task: Task;
  status: TaskStatus | null;
  phase: TaskPhase | null;
  plan: PlanStep[];
  /** 当前正在生成的这一轮的流式文本尾巴（仅运行中有值） */
  output: string;
  /** 模型思考链流式文本（DeepSeek R1/V3 reasoning_content，仅运行中有值） */
  reasoning: string;
  busy: boolean;
  /** 当前运行轮次的实时工具活动（来自事件流） */
  liveToolActivity: ToolActivity[];
  /** 是否默认展开工具参数/结果详情。等待审批的工具始终展开。 */
  defaultToolDetailsOpen?: boolean;
  online?: boolean | null;
  /** 工具审批决策回调（批准/拒绝），sessionApprove 表示本次会话自动批准该工具 */
  onToolDecision: (callId: string, approved: boolean, sessionApprove?: boolean) => void;
  onPlanDecision: (approved: boolean) => void;
  onClarificationAnswer: (clarificationId: string, answer: string) => void;
  /** 当前任务是否可恢复（中断/失败等可续跑状态） */
  canResume?: boolean;
  /** 当前任务是否有可撤销的 revert（archivedMessages 非空） */
  hasArchivedMessages?: boolean;
  /** 编辑某条用户消息并重新发起（编辑即等同于"重试"） */
  onUserMessageEdit?: (messageId: string, content: string, mode: RevertMode) => void;
  /** 撤销上一次 revert */
  onUnrevert?: () => void;
  /** 从指定消息处分支 */
  onBranch?: (messageId: string) => void;
  /** 恢复中断的任务 */
  onResume?: () => void;
  /** Agent 本轮通过 attach_content 工具的实时内容块 */
  liveContentBlocks?: ContentBlock[];
}

interface ToolResultInfo {
  ok: boolean;
  output?: unknown;
  error?: string;
}

/** 扫描消息，建立 toolCallId → 工具结果 的映射 */
function buildToolResultMap(messages: Message[]): Map<string, ToolResultInfo> {
  const map = new Map<string, ToolResultInfo>();
  for (const message of messages) {
    if (message.role !== "tool" || !message.toolCallId) continue;
    let parsed: unknown = message.content;
    try {
      parsed = JSON.parse(message.content);
    } catch {
      /* 保留原文 */
    }
    if (parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)) {
      map.set(message.toolCallId, {
        ok: false,
        error: String((parsed as Record<string, unknown>).error),
      });
    } else {
      map.set(message.toolCallId, { ok: true, output: parsed });
    }
  }
  return map;
}

/** 把一条 assistant 消息携带的 toolCalls 派生为工具活动卡片数据 */
function toolActivitiesFromAssistant(
  message: Message,
  resultMap: Map<string, ToolResultInfo>,
): ToolActivity[] {
  if (!message.toolCalls?.length) return [];
  return message.toolCalls.map((tc) => {
    let args: unknown = {};
    try {
      args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      args = tc.function.arguments;
    }
    const result = resultMap.get(tc.id);
    return {
      id: tc.id,
      name: tc.function.name,
      args,
      status: result ? (result.ok ? "ok" : "error") : "running",
      output: result?.output,
      error: result?.error,
    };
  });
}

export function Conversation({
  task,
  status,
  phase,
  plan,
  output,
  reasoning,
  busy,
  liveToolActivity,
  defaultToolDetailsOpen = false,
  onToolDecision,
  onClarificationAnswer,
  canResume = false,
  hasArchivedMessages = false,
  onUserMessageEdit,
  onUnrevert,
  onBranch,
  onResume,
  liveContentBlocks = [],
}: ConversationProps) {
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const previousTaskIdRef = useRef<string | null>(null);
  const hasScrolledToTail = useRef(false);

  const hasStreamingContent = output.trim().length > 0 || reasoning.trim().length > 0;
  const hasLiveTail = busy || liveToolActivity.length > 0 || phase === "waiting_approval" || hasStreamingContent;

  // 只在实时运行/等待审批时跟随最新输出；历史回看保持自然阅读位置。
  useEffect(() => {
    if (liveToolActivity.length > 0) {
      // 有工具活动时，首次出现时滚动一次即可，避免 liveToolActivity 新引用反复触发
      if (!hasScrolledToTail.current) {
        bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
        hasScrolledToTail.current = true;
      }
    } else if (phase === "waiting_approval") {
      // 审批态下且 liveToolActivity 仍为空，仍滚动到尾部
      if (!hasScrolledToTail.current) {
        bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
        hasScrolledToTail.current = true;
      }
    } else if (hasLiveTail) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    } else {
      hasScrolledToTail.current = false;
    }
  }, [hasLiveTail, output, phase, plan, status, liveToolActivity.length, task.messages.length]);

  // 切换历史任务时回到任务顶部，避免复用滚动容器导致摘要被顶栏遮住。
  useEffect(() => {
    if (previousTaskIdRef.current === task.id) return;
    previousTaskIdRef.current = task.id;
    const resetScroll = () => {
      const scrollParent = topRef.current?.closest(".main-scroll");
      if (scrollParent instanceof HTMLElement) {
        scrollParent.scrollTo({ top: 0, behavior: "auto" });
      } else {
        topRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
      }
    };
    resetScroll();
    window.requestAnimationFrame(resetScroll);
  }, [task.id]);

  const messages = task.messages;
  const resultMap = buildToolResultMap(messages);

  return (
    <div className="conversation">
      <div ref={topRef} />
      <div className="conversation-thread">


        {messages.map((message) => {
          if (message.role === "user") {
            return (
              <UserBubble
                key={message.id}
                content={message.content}
                messageId={message.id}
                attachments={message.attachments}
                onEdit={onUserMessageEdit}
                onBranch={onBranch}
              />
            );
          }
          if (message.role === "assistant") {
            return (
              <AgentRound
                key={message.id}
                data={buildAgentRoundFromMessage(message, resultMap, task.plan)}
                busy={false}
                defaultToolDetailsOpen={defaultToolDetailsOpen}
              />
            );
          }
          if (message.role === "tool") return null;
          return null;
        })}

        {/* 当前运行轮次的实时尾巴 */}
        {/* 当前运行轮次的实时尾巴 — Timeline 格式 */}
        {hasLiveTail && (
          <div className="aurevoy-agent-runner-container">
            <AgentRound
              key="live-tail"
              data={buildLiveAgentRoundData({
                plan,
                liveToolActivity,
                output,
                reasoning,
                phase,
                contentBlocks: liveContentBlocks,
              })}
              busy={true}
              defaultToolDetailsOpen={defaultToolDetailsOpen}
            />

            {/* 兜底审批 UI：当 liveToolActivity 尚无审批项但 task.pendingApprovals 已有数据时 */}
            {phase === "waiting_approval" && liveToolActivity.filter((item) => item.status === "awaiting").length === 0 && (task.pendingApprovals ?? []).length > 0 && (
              <section className="tool-run-summary" data-status="awaiting">
                <div className="tool-run-head">
                  <span className="tool-run-dot" aria-hidden="true" />
                  <span className="tool-run-title">执行工具</span>
                  <span className="tool-run-names">{(task.pendingApprovals ?? []).map(pa => pa.call.toolName).join("、")}</span>
                  <span className="tool-run-status">等待确认 {(task.pendingApprovals ?? []).length}</span>
                </div>
                {(task.pendingApprovals ?? []).map(pa => ({
                  id: pa.call.id,
                  name: pa.call.toolName,
                  args: pa.call.args,
                  status: "awaiting" as const,
                  riskLevel: pa.riskLevel,
                })).map(item => (
                  <ApprovalInline key={item.id} item={item} onDecision={onToolDecision} />
                ))}
              </section>
            )}

            {(task.clarifications ?? []).filter((item) => item.status === "pending").map((clarification) => (
              <ClarificationCard
                key={clarification.id}
                clarification={clarification}
                onAnswer={onClarificationAnswer}
              />
            ))}

          </div>
        )}
        {!hasLiveTail && (
          <div className="turn-actions" aria-label={t("conv.turnActions")}>
            {hasArchivedMessages && onUnrevert && (
              <button type="button" className="ghost-btn" onClick={onUnrevert}>
                {t("action.unrevert")}
              </button>
            )}
            {canResume && onResume && (
              <button type="button" className="ghost-btn" onClick={onResume}>
                {t("action.resume")}
              </button>
            )}
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function ClarificationCard({
  clarification,
  onAnswer,
}: {
  clarification: ClarificationRequest;
  onAnswer: (clarificationId: string, answer: string) => void;
}) {
  const [answer, setAnswer] = useState(clarification.options?.[0] ?? "");
  const [submitted, setSubmitted] = useState(false);

  function submit(value = answer) {
    const trimmed = value.trim();
    if (!trimmed) return;
    setSubmitted(true);
    onAnswer(clarification.id, trimmed);
  }

  return (
    <section className="clarification-card" aria-label={t("clarification.label")}>
      <div className="clarification-head">
        <strong>{t("clarification.title")}</strong>
        <span>{t("clarification.waiting")}</span>
      </div>
      <p>{clarification.question}</p>
      {clarification.context && <small>{clarification.context}</small>}
      {clarification.options?.length ? (
        <div className="clarification-options">
          {clarification.options.map((option) => (
            <button type="button" key={option} disabled={submitted} onClick={() => submit(option)}>
              {option}
            </button>
          ))}
        </div>
      ) : (
        <div className="clarification-input-row">
          <input
            value={answer}
            disabled={submitted}
            placeholder={t("clarification.inputPlaceholder")}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
          <button type="button" disabled={submitted || !answer.trim()} onClick={() => submit()}>
            {t("action.reply")}
          </button>
        </div>
      )}
    </section>
  );
}



/** 用户消息气泡：可复制；可编辑，编辑后选择恢复模式再提交。 */
function UserBubble({
  content,
  messageId,
  attachments,
  onEdit,
  onBranch,
}: {
  content: string;
  messageId: string;
  attachments?: MessageAttachment[];
  onEdit?: (messageId: string, content: string, mode: RevertMode) => void;
  onBranch?: (messageId: string) => void;
}) {
  const platform = usePlatform();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [viewingImage, setViewingImage] = useState<string | null>(null);

  function confirmSave(): void {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setEditing(false);
    if (trimmed && trimmed !== content) onEdit?.(messageId, trimmed, "code_and_conv");
  }

  function cancel(): void {
    setDraft(content);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="user-bubble-row is-editing">
        <div className="user-bubble-edit">
          <textarea
            className="user-bubble-input"
            value={draft}
            autoFocus
            rows={Math.min(8, Math.max(1, draft.split("\n").length))}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                confirmSave();
              } else if (event.key === "Escape") {
                cancel();
              }
            }}
          />
          <div className="msg-actions">
            <IconButton label={t("action.cancel")} onClick={cancel}>
              <CloseIcon />
            </IconButton>
            <IconButton label={t("action.editAndRetry")} onClick={confirmSave} className="is-confirm">
              <CheckIcon />
            </IconButton>
          </div>
        </div>
      </div>
    );
  }

  const imageAttachments = attachments?.filter((a) => a.type === 'image') ?? [];

  return (
    <div className="user-bubble-row">
      <div className="user-bubble-col">
        <div className="user-bubble">{content}</div>
        {imageAttachments.length > 0 && (
          <div className="user-bubble-images">
            {imageAttachments.map((att) => {
              const src = (() => {
                try { return platform.filePathToUrl(att.path); } catch { return null; }
              })();
              return src ? (
                <img
                  key={att.id}
                  className="user-bubble-image"
                  src={src}
                  alt={att.name}
                  loading="lazy"
                  onClick={() => setViewingImage(att.path)}
                />
              ) : (
                <span key={att.id} className="user-bubble-image-placeholder">
                  📷 {att.name}
                </span>
              );
            })}
          </div>
        )}
        {viewingImage && (
          <ImageViewer
            src={viewingImage}
            onClose={() => setViewingImage(null)}
          />
        )}
      </div>
      <div className="msg-actions">
        <CopyButton content={content} />
        {onEdit && (
          <IconButton label={t("action.edit")} onClick={() => { setDraft(content); setEditing(true); }}>
            <PencilIcon />
          </IconButton>
        )}
        {onBranch && (
          <IconButton label={t("action.branch")} onClick={() => onBranch(messageId)}>
            <ForkIcon />
          </IconButton>
        )}
      </div>
    </div>
  );
}

/** Agent 消息底部的纯 icon 操作行（当前：复制）。 */
function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      label={copied ? t("action.copied") : t("action.copy")}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(content);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          /* 剪贴板不可用时静默忽略 */
        }
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </IconButton>
  );
}

function IconButton({
  label,
  onClick,
  children,
  className,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={className ? `msg-action-btn ${className}` : "msg-action-btn"}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
      <rect x="6.5" y="6.5" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <path d="M13 6.5V5a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h1.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinejoin="round" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
      <path d="M4 14.5l-.6 2.6 2.6-.6L16 6.5a1.5 1.5 0 00-2.1-2.1L4 14.5z" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
      <path d="M4.5 10.5l3.2 3.2L15.5 6" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
      <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function ForkIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
      <circle cx="6" cy="5" r="2" stroke="currentColor" strokeWidth="1.3" fill="none" />
      <circle cx="14" cy="5" r="2" stroke="currentColor" strokeWidth="1.3" fill="none" />
      <circle cx="10" cy="15" r="2" stroke="currentColor" strokeWidth="1.3" fill="none" />
      <path d="M6 7v2a4 4 0 004 4M14 7v2a4 4 0 01-4 4" stroke="currentColor" strokeWidth="1.3" fill="none" />
    </svg>
  );
}

function DocumentMeta({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="doc-meta">
      <span className="doc-meta-icon" aria-hidden="true">
        {icon}
      </span>
      <span>{label}</span>
    </div>
  );
}

function AgentIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <path
        d="M4.2 5.8c0-.9.7-1.6 1.6-1.6h8.4c.9 0 1.6.7 1.6 1.6v5.9c0 .9-.7 1.6-1.6 1.6H8l-3.2 2.5v-2.5c-.5-.2-.8-.8-.8-1.4V5.8z"
        stroke="currentColor"
        strokeWidth="1.35"
        fill="none"
        strokeLinejoin="round"
      />
      <path d="M7.2 8.2h5.6M7.2 10.6h3.8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

export function ToolActivityList({
  items,
  defaultDetailsOpen = false,
  onDecision,
}: {
  items: ToolActivity[];
  defaultDetailsOpen?: boolean;
  onDecision: (callId: string, approved: boolean, sessionApprove?: boolean) => void;
}) {
  return (
    <div className="tool-activity">
      {items.map((item) =>
        // 等待审批始终展示完整卡片；其他状态遵循用户的工具详情偏好。
        item.status === "awaiting" || defaultDetailsOpen ? (
          <ToolActivityCard
            key={item.id}
            item={item}
            defaultOpen={defaultDetailsOpen || item.status === "awaiting"}
            onDecision={onDecision}
          />
        ) : (
          <ToolChip key={item.id} item={item} onDecision={onDecision} />
        ),
      )}
    </div>
  );
}

/** 紧凑态：已结束的工具调用折叠为单行 chip，点击展开为完整卡片。 */
function ToolChip({
  item,
  onDecision,
}: {
  item: ToolActivity;
  onDecision: (callId: string, approved: boolean, sessionApprove?: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (expanded) {
    return (
      <ToolActivityCard
        item={item}
        onDecision={onDecision}
        defaultOpen
        onCollapse={() => setExpanded(false)}
      />
    );
  }

  return (
    <button
      type="button"
      className="tool-chip"
      data-status={item.status}
      onClick={() => setExpanded(true)}
      aria-label={`${t("tool.viewPrefix")}${getToolKindLabel(item.name)} ${item.name} ${t("tool.viewSuffix")}`}
    >
      <span className="tool-chip-icon" aria-hidden="true">
        {toolStatusIcon(item.status)}
      </span>
      <span className="tool-chip-name">{item.name}</span>
      {item.riskLevel && item.riskLevel !== "safe" && (
        <span className="tool-chip-risk" data-risk={item.riskLevel}>
          {item.riskLevel === "dangerous" ? t("tool.risk.dangerousShort") : t("tool.risk.cautionShort")}
        </span>
      )}
    </button>
  );
}

function toolStatusIcon(status: ToolActivity["status"]): string {
  switch (status) {
    case "ok":
      return "·";
    case "error":
      return "✕";
    case "awaiting":
      return "!";
    case "running":
    default:
      return "◌";
  }
}

function getToolKindLabel(name: string): string {
  return /cmd|command|exec|shell|terminal/i.test(name) ? t("tool.kind.command") : t("tool.kind.tool");
}

function ToolActivityCard({
  item,
  onDecision,
  onCollapse,
  defaultOpen,
}: {
  item: ToolActivity;
  onDecision: (callId: string, approved: boolean, sessionApprove?: boolean) => void;
  /** 由 chip 展开时传入：点击头部收起回到 chip 形态。 */
  onCollapse?: () => void;
  /** chip 展开时默认打开 body（已结束工具的初始 open 否则为 false）。 */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? item.status === "awaiting");
  const [decided, setDecided] = useState<'approve' | 'reject' | null>(null);

  // 状态变为待确认时自动展开（useState 初始值不随 props 更新，需 effect 补齐）
  useEffect(() => {
    if (item.status === "awaiting") setOpen(true);
  }, [item.status]);

  const statusText =
    item.status === "awaiting"
      ? t("tool.status.awaiting")
      : item.status === "running"
        ? t("tool.status.running")
        : item.status === "ok"
          ? t("tool.status.ok")
          : t("tool.status.error");
  const icon = toolStatusIcon(item.status);
  const kindLabel = getToolKindLabel(item.name);
  const detail =
    item.status === "error"
      ? item.error ?? t("tool.unknownError")
      : item.output !== undefined
        ? safeStringify(item.output)
        : null;
  const argsText = safeStringify(item.args);

  function decide(approved: boolean, sessionApprove?: boolean) {
    setDecided(approved ? 'approve' : 'reject');
    onDecision(item.id, approved, sessionApprove);
  }

  return (
    <section className="tool-card" data-open={open} data-status={item.status} aria-label={`${kindLabel}${t("tool.invoke")} ${item.name}`}>
      <button
        type="button"
        className="tool-card-head"
        onClick={() => {
          // 由 chip 展开的卡片：再次点击头部收起回 chip；否则普通折叠切换。
          if (open && onCollapse) onCollapse();
          else setOpen((v) => !v);
        }}
      >
        <span className="tool-card-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="tool-card-kind">{kindLabel}</span>
        <span className="tool-card-name">{item.name}</span>
        {item.riskLevel && item.riskLevel !== "safe" && (
          <span className="tool-card-risk" data-risk={item.riskLevel}>
            {item.riskLevel === "dangerous" ? t("tool.risk.dangerous") : t("tool.risk.caution")}
          </span>
        )}
        <span className="tool-card-status">{statusText}</span>
        <span className="tool-card-caret" data-open={open} aria-hidden="true">
          ⌄
        </span>
      </button>
      {open && (
        <div className="tool-card-body">
          {argsText !== "{}" && (
            <div className="tool-card-field">
              <span className="tool-card-field-label">{t("tool.field.args")}</span>
              <pre>{argsText}</pre>
            </div>
          )}
          {detail !== null && (
            <div className="tool-card-field">
              <span className="tool-card-field-label">{item.status === "error" ? t("tool.field.error") : t("tool.field.result")}</span>
              <pre>{detail}</pre>
            </div>
          )}
        </div>
      )}
      {!decided && item.status === "awaiting" && (
        <div className="tool-approval">
          <span className="tool-approval-hint">{t("tool.approvalHint")}</span>
          <div className="tool-approval-actions">
            <button
              type="button"
              className="tool-approval-btn approve-once"
              onClick={() => decide(true)}
            >
              {t("action.approveOnce")}
            </button>
            <button
              type="button"
              className="tool-approval-btn approve-session"
              onClick={() => decide(true, true)}
            >
              {t("action.approveSession")}
            </button>
            <button
              type="button"
              className="tool-approval-btn reject"
              onClick={() => decide(false)}
            >
              {t("action.reject")}
            </button>
          </div>
        </div>
      )}
      {decided && item.status === "awaiting" && (
        <div className="tool-approval tool-approval--decided" data-decision={decided}>
          <span className="tool-approval-result">
            {decided === 'approve' ? '✓ 已批准' : '✕ 已拒绝'}
          </span>
        </div>
      )}
    </section>
  );
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function PlanCard({ plan, defaultOpen = true }: { plan: PlanStep[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const done = plan.filter((step) => step.status === "completed").length;

  return (
    <section className="plan-card" aria-label={t("plan.title")}>
      <button type="button" className="plan-card-head" onClick={() => setOpen((value) => !value)}>
        <span className="plan-card-title">{t("plan.title")}</span>
        <span className="plan-card-progress">
          {done}/{plan.length}
        </span>
        <span className="plan-card-caret" data-open={open}>
          ⌄
        </span>
      </button>

      {open && (
        <ol className="plan-steps">
          {plan.map((step, index) => (
            <li key={step.id} className="plan-step" data-status={step.status}>
              <span className="plan-step-marker">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="plan-step-text">{step.description}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function PlanApprovalCard({
  plan,
  onDecision,
}: {
  plan: PlanStep[];
  onDecision: (approved: boolean) => void;
}) {
  const [decided, setDecided] = useState(false);

  function decide(approved: boolean): void {
    setDecided(true);
    onDecision(approved);
  }

  return (
    <section className="plan-approval-card" aria-label={t("event.planApprovalRequest")}>
      <div className="plan-approval-head">
        <strong>{t("event.planApprovalRequest")}</strong>
        <span>{plan.length} {t("event.unitPlanSteps")}</span>
      </div>
      <PlanCard plan={plan} defaultOpen />
      <div className="plan-approval-actions">
        <button type="button" disabled={decided} onClick={() => decide(true)}>
          {t("action.approveOnce")}
        </button>
        <button type="button" disabled={decided} onClick={() => decide(false)}>
          {t("action.reject")}
        </button>
      </div>
    </section>
  );
}

interface AgentRunningTimelineProps {
  busy: boolean;
  online: boolean | null;
  phase: TaskPhase | null;
  status: TaskStatus | null;
  plan: PlanStep[];
  output: string;
  reasoning: string;
  liveToolActivity: ToolActivity[];
  onToolDecision: (callId: string, approved: boolean, sessionApprove?: boolean) => void;
  onPlanDecision: (approved: boolean) => void;
}

/** 阶段 → 展示信息映射 */
interface PhaseDisplay {
  badge: string;
  icon: ReactNode;
  label: string;
  colorClass: string;
}

function phaseDisplay(phase: TaskPhase | null): PhaseDisplay {
  switch (phase) {
    case "initializing":
      return { badge: "初始化", icon: <PlayIcon />, label: "初始化中", colorClass: "is-init" };
    case "planning":
      return { badge: "计划", icon: <ClipboardIcon />, label: "生成执行计划", colorClass: "is-plan" };
    case "thinking":
      return { badge: "思考", icon: <BrainIcon className="spin-icon" />, label: "思考中", colorClass: "is-thought" };
    case "calling_tool":
      return { badge: "工具", icon: <ToolIcon />, label: "调用工具", colorClass: "is-tool" };
    case "waiting_approval":
      return { badge: "确认", icon: <ShieldIcon />, label: "等待审批", colorClass: "is-wait" };
    case "waiting_clarification":
      return { badge: "追问", icon: <ChatIcon />, label: "等待回复", colorClass: "is-ask" };
    case "finalizing":
      return { badge: "收尾", icon: <CheckIcon />, label: "整理结果", colorClass: "is-done" };
    case "failed":
      return { badge: "失败", icon: <ErrorIcon />, label: "任务失败", colorClass: "is-error" };
    case "cancelled":
      return { badge: "停止", icon: <StopIcon />, label: "已取消", colorClass: "is-stop" };
    default:
      return { badge: "思考", icon: <BrainIcon className="spin-icon" />, label: "思考中", colorClass: "is-thought" };
  }
}

export function AgentRunningTimeline({
  busy,
  online,
  phase,
  status: _status,
  plan,
  output,
  reasoning,
  liveToolActivity,
  onToolDecision,
  onPlanDecision,
}: AgentRunningTimelineProps) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!busy) {
      setSeconds(0);
      return;
    }
    const timer = setInterval(() => {
      setSeconds((s) => s + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const display = phaseDisplay(phase);
  const hasOutput = output.trim().length > 0;
  const hasReasoning = reasoning.trim().length > 0;
  const isThinking = phase === "thinking";
  const showStreamingReasoning = hasReasoning && (isThinking || busy);
  const showStreamingOutput = hasOutput && (isThinking || busy);
  const pendingApprovalTools = liveToolActivity.filter((item) => item.status === "awaiting");
  const awaitingPlanApproval = phase === "waiting_approval" && pendingApprovalTools.length === 0 && plan.some((step) => step.status === "proposed");

  return (
    <div className="aurevoy-agent-runner-box">
      {online === false && (
        <div className="runner-node is-active fade-in-up">
          <div className="node-dot is-warning">
            <NetworkIcon />
          </div>
          <div className="node-content">
            <span className="badge-network">NETWORK</span>
            <span className="meta-text">正在重新连接…</span>
          </div>
        </div>
      )}

      {awaitingPlanApproval ? (
        <PlanApprovalCard plan={plan} onDecision={onPlanDecision} />
      ) : !pendingApprovalTools.length && plan.length > 0 && phase !== "planning" && phase !== "initializing" && (
        <PlanCard plan={plan} defaultOpen={false} />
      )}

      {liveToolActivity.length > 0 && (
        <ToolRunSummary items={liveToolActivity} onDecision={onToolDecision} />
      )}

      {busy && liveToolActivity.length === 0 && (
        <div className="runner-node is-active fade-in-up">
          <div className={`node-dot ${isThinking ? "is-loading" : ""} ${display.colorClass}`}>
            {display.icon}
          </div>
          <div className="node-content">
            <span className={`badge-thought ${display.colorClass}`}>{display.badge}</span>
            <span className="meta-text">{display.label} · {seconds}s</span>
          </div>
        </div>
      )}

      {/* 思考链（ThinkingCard） */}
      {showStreamingReasoning && (
        <ThinkingCard data={{
          id: 'live-reasoning',
          phase: 1,
          summary: '',
          fullText: reasoning,
          defaultOpen: false,
        }} />
      )}

      {/* 流式输出文本（thinking 阶段实时打字机效果） */}
      {showStreamingOutput && (
        <article className="doc-block doc-block-agent">
          <DocumentMeta icon={<AgentIcon />} label="Aurevoy" />
          <div className="doc-body">
            <div className="stream-preview">
              <MarkdownRenderer content={output} />
              {busy && <span className="stream-caret" aria-hidden="true" />}
            </div>
          </div>
        </article>
      )}

    </div>
  );
}

function ToolRunSummary({
  items,
  defaultOpen = false,
  onDecision,
}: {
  items: ToolActivity[];
  defaultOpen?: boolean;
  onDecision?: (callId: string, approved: boolean, sessionApprove?: boolean) => void;
}) {
  const awaiting = items.filter((item) => item.status === "awaiting");
  const [open, setOpen] = useState(defaultOpen || awaiting.length > 0);
  const running = items.filter((item) => item.status === "running").length;
  const failed = items.filter((item) => item.status === "error").length;
  const done = items.filter((item) => item.status === "ok").length;
  const groupedNames = summarizeToolNames(items);
  const statusText = awaiting.length
    ? `等待确认 ${awaiting.length}`
    : running
      ? `执行中 ${running}`
      : failed
        ? `失败 ${failed}`
        : `完成 ${done}`;

  useEffect(() => {
    if (awaiting.length > 0) setOpen(true);
  }, [awaiting.length]);

  return (
    <section className="tool-run-summary" data-status={awaiting.length ? "awaiting" : running ? "running" : failed ? "error" : "ok"}>
      <div className="tool-run-head">
        <span className="tool-run-dot" aria-hidden="true" />
        <span className="tool-run-title">执行工具</span>
        <span className="tool-run-names">{groupedNames}</span>
        <span className="tool-run-status">{statusText}</span>
        <button type="button" className="tool-run-toggle" onClick={() => setOpen((value) => !value)}>
          {open ? "收起" : "详情"}
        </button>
      </div>
      {open && (
        <div className="tool-run-details">
          {items.map((item) => (
            <div key={item.id}>
              <div className="tool-run-detail-row" data-status={item.status}>
                <span>{item.name}</span>
                <small>{toolTargetLabel(item)}</small>
                <em>{toolStatusLabel(item.status)}</em>
              </div>
              {item.status === "ok" && item.output != null && (
                <div className="tool-run-detail-result">
                  <code>{formatToolResult(item)}</code>
                </div>
              )}
              {item.status === "error" && item.error && (
                <div className="tool-run-detail-result tool-run-detail-result--error">
                  <code>{item.error}</code>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {onDecision && awaiting.map((item) => (
        <ApprovalInline key={item.id} item={item} onDecision={onDecision} />
      ))}
    </section>
  );
}

function ApprovalInline({
  item,
  onDecision,
}: {
  item: ToolActivity;
  onDecision: (callId: string, approved: boolean, sessionApprove?: boolean) => void;

}) {
  const [decided, setDecided] = useState<'approve' | 'reject' | null>(null);

  function handleDecide(approved: boolean, sessionApprove?: boolean) {
    setDecided(approved ? 'approve' : 'reject');
    onDecision(item.id, approved, sessionApprove);
  }

  if (decided) {
    return (
      <div className="tool-run-approval tool-run-approval--decided" data-decision={decided}>
        <span className="tool-run-approval-result">
          {decided === 'approve' ? '✓ 已批准' : '✕ 已拒绝'} · {toolApprovalLabel(item)}
        </span>
      </div>
    );
  }

  return (
    <div className="tool-run-approval">
      <span>{t("tool.approvalHint")} · {toolApprovalLabel(item)}</span>
      <div className="tool-run-approval-actions">
        <button type="button" onClick={() => handleDecide(true)}>
          {t("action.approveOnce")}
        </button>
        <button type="button" onClick={() => handleDecide(true, true)}>
          {t("action.approveSession")}
        </button>
        <button type="button" onClick={() => handleDecide(false)}>
          {t("action.reject")}
        </button>
      </div>
    </div>
  );
}

function toolApprovalLabel(item: ToolActivity): string {
  if (item.name !== "execute_command") return item.name;
  const argsObj = item.args as Record<string, unknown> | null;
  if (!argsObj || typeof argsObj !== "object") return item.name;
  const command = typeof argsObj.command === "string" ? argsObj.command : "";
  const commandArgs = Array.isArray(argsObj.args)
    ? argsObj.args.map((arg) => String(arg))
    : [];
  return truncateCommandLine([command, ...commandArgs].filter(Boolean).join(" ")) || item.name;
}

function summarizeToolNames(items: ToolActivity[]): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
  const entries = [...counts.entries()];
  const visible = entries.slice(0, 3).map(([name, count]) => (count > 1 ? `${name} x${count}` : name));
  const hidden = entries.length - visible.length;
  return hidden > 0 ? `${visible.join("、")} +${hidden}` : visible.join("、");
}

function toolStatusLabel(status: ToolActivity["status"]): string {
  switch (status) {
    case "awaiting":
      return "待确认";
    case "running":
      return "执行中";
    case "ok":
      return "完成";
    case "error":
      return "失败";
  }
}

function formatToolResult(item: ToolActivity): string {
  if (item.output == null) return "";
  if (typeof item.output === "string") return item.output;
  try {
    const text = JSON.stringify(item.output, null, 2);
    return text.length > 2000 ? text.slice(0, 1997) + "..." : text;
  } catch {
    return String(item.output);
  }
}

function toolTargetLabel(item: ToolActivity): string {
  const argsObj = item.args as Record<string, unknown> | null;
  if (!argsObj || typeof argsObj !== "object") return "";
  if (item.name === "execute_command") return toolApprovalLabel(item);
  const target =
    argsObj.TargetFile ??
    argsObj.AbsolutePath ??
    argsObj.path ??
    argsObj.filePath ??
    argsObj.CommandLine ??
    argsObj.Query;
  return typeof target === "string" ? truncateCommandLine(getFilename(target) || target) : "";
}

function getFilename(pathStr: string): string {
  if (!pathStr) return "";
  const parts = pathStr.split(/[/\\]/);
  return parts[parts.length - 1] || pathStr;
}

function truncateCommandLine(cmd: string): string {
  if (!cmd) return "";
  if (cmd.length > 50) {
    return cmd.slice(0, 47) + "...";
  }
  return cmd;
}

/* ============ Vector Icons (Premium outline SVGs, no emojis) ============ */

function NetworkIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="none">
      <path
        d="M10 3.5l6.5 11.5H3.5L10 3.5z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M10 8v3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="10" cy="14" r="0.8" fill="currentColor" />
    </svg>
  );
}

function BrainIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="none">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="10" cy="10" r="3" stroke="currentColor" strokeWidth="1.2" />
      <path d="M10 3v4M10 13v4M3 10h4M13 10h4" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true" fill="none">
      <rect x="5" y="5" width="10" height="10" rx="1.5" fill="currentColor" />
    </svg>
  );
}

function ToolIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="none">
      <circle cx="10" cy="10" r="3" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="none">
      <polygon points="5,2 18,10 5,18" fill="currentColor" />
    </svg>
  );
}

function ClipboardIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="none">
      <rect x="6" y="2" width="10" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 5h2v11.5A1.5 1.5 0 007.5 18H15" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="none">
      <path d="M10 2L3 5v5c0 3.5 3 7 7 8 4-1 7-4.5 7-8V5L10 2z" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="none">
      <path d="M3 5h14v9H7l-4 3V5z" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="none">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
      <line x1="7" y1="7" x2="13" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="13" y1="7" x2="7" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// Keep references for unused type exports
void toolActivitiesFromAssistant;
void ClarificationCard;
