import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ClarificationRequest,
  Message,
  PlanStep,
  RevertMode,
  Task,
  TaskArtifact,
  TaskPhase,
  TaskStatus,
  ToolRiskLevel,
} from "@aurevoy/shared";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { t } from "../i18n";

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
  busy: boolean;
  /** 当前运行轮次的实时工具活动（来自事件流） */
  liveToolActivity: ToolActivity[];
  online?: boolean | null;
  /** 工具审批决策回调（批准/拒绝） */
  onToolDecision: (callId: string, approved: boolean) => void;
  onClarificationAnswer: (clarificationId: string, answer: string) => void;
  onArtifactDecision: (artifactId: string, status: "confirmed" | "rejected") => void;
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
  /** 停止当前流式生成 */
  onStop?: () => void;
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
  busy,
  liveToolActivity,
  online = null,
  onToolDecision,
  onClarificationAnswer,
  onArtifactDecision,
  canResume = false,
  hasArchivedMessages = false,
  onUserMessageEdit,
  onUnrevert,
  onBranch,
  onResume,
  onStop,
}: ConversationProps) {
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const previousTaskIdRef = useRef<string | null>(null);

  // 只在实时运行时跟随最新输出；历史回看保持自然阅读位置。
  useEffect(() => {
    if (busy) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [busy, output, phase, plan, status, liveToolActivity, task.messages.length]);

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

  // 运行中时：已结束的历史渲染到“最后一条用户消息”为止，
  // 当前轮的产出（文本/工具）走实时 live 尾巴，避免与已提交消息重复。
  let lastUserIndex = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") lastUserIndex = index;
  });
  const historyEnd = busy ? lastUserIndex : messages.length - 1;
  const historyMessages = messages.slice(0, historyEnd + 1);

  const hasOutput = output.trim().length > 0;
  const thinking = busy && !hasOutput && liveToolActivity.length === 0;

  return (
    <div className="conversation">
      <div ref={topRef} />
      <div className="conversation-thread">
        {!busy && plan.length > 0 && <PlanCard plan={plan} defaultOpen={false} />}

        {historyMessages.map((message) => {
          if (message.role === "user") {
            return <UserBubble key={message.id} content={message.content} messageId={message.id} onEdit={onUserMessageEdit} onBranch={onBranch} />;
          }
          if (message.role === "assistant") {
            const tools = toolActivitiesFromAssistant(message, resultMap);
            const artifacts = (task.artifacts ?? []).filter((artifact) => artifact.sourceCallId && tools.some((tool) => tool.id === artifact.sourceCallId));
            const hasText = message.content.trim().length > 0;
            if (!hasText && tools.length === 0 && artifacts.length === 0) return null;
            return (
              <article className="doc-block doc-block-agent" key={message.id}>
                <DocumentMeta icon={<AgentIcon />} label="Aurevoy" />
                <div className="doc-body">
                  {tools.length > 0 && (
                    <ToolActivityList items={tools} onDecision={onToolDecision} />
                  )}
                  {artifacts.length > 0 && (
                    <ArtifactList artifacts={artifacts} onDecision={onArtifactDecision} />
                  )}
                  {hasText && <MarkdownRenderer content={message.content} />}
                </div>
                {hasText && <MessageActions content={message.content} />}
              </article>
            );
          }
          return null;
        })}

        {/* 当前运行轮次的实时尾巴 */}
        {busy && (
          <div className="aurevoy-agent-runner-container">
            <AgentRunningTimeline
              busy={busy}
              online={online}
              phase={phase}
              status={status}
              plan={plan}
              liveToolActivity={liveToolActivity}
              onToolDecision={onToolDecision}
              onStop={onStop}
            />

            {(task.clarifications ?? []).filter((item) => item.status === "pending").map((clarification) => (
              <ClarificationCard
                key={clarification.id}
                clarification={clarification}
                onAnswer={onClarificationAnswer}
              />
            ))}

            {(task.artifacts ?? []).filter((item) => item.status === "draft").map((artifact) => (
              <ArtifactCard
                key={artifact.id}
                artifact={artifact}
                onDecision={onArtifactDecision}
              />
            ))}

            {!thinking && hasOutput && (
              <div className="ai-chat-bubble-reply">
                <MarkdownRenderer content={output} />
                <span className="stream-caret" aria-hidden="true" />
              </div>
            )}
          </div>
        )}

        {!busy && (
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

function ArtifactList({
  artifacts,
  onDecision,
}: {
  artifacts: TaskArtifact[];
  onDecision: (artifactId: string, status: "confirmed" | "rejected") => void;
}) {
  return (
    <div className="artifact-list">
      {artifacts.map((artifact) => (
        <ArtifactCard key={artifact.id} artifact={artifact} onDecision={onDecision} />
      ))}
    </div>
  );
}

function ArtifactCard({
  artifact,
  onDecision,
}: {
  artifact: TaskArtifact;
  onDecision: (artifactId: string, status: "confirmed" | "rejected") => void;
}) {
  const [open, setOpen] = useState(artifact.status === "draft");
  const preview = artifact.content.length > 1600 ? `${artifact.content.slice(0, 1600)}\n…` : artifact.content;
  return (
    <section className="artifact-card" data-status={artifact.status}>
      <button type="button" className="artifact-head" onClick={() => setOpen((value) => !value)}>
        <span className="artifact-type">{artifact.type}</span>
        <strong>{artifact.name}</strong>
        <span>{artifact.status}</span>
      </button>
      {open && (
        <div className="artifact-body">
          <MarkdownRenderer content={preview} />
          {artifact.status === "draft" && (
            <div className="artifact-actions">
              <button type="button" onClick={() => onDecision(artifact.id, "rejected")}>
                {t("action.reject")}
              </button>
              <button type="button" onClick={() => onDecision(artifact.id, "confirmed")}>
                {t("action.confirm")}
              </button>
            </div>
          )}
          {artifact.appliedPath && <small>{t("artifact.written")}{artifact.appliedPath}</small>}
        </div>
      )}
    </section>
  );
}

/** 用户消息气泡：可复制；可编辑，编辑后选择恢复模式再提交。 */
function UserBubble({
  content,
  messageId,
  onEdit,
  onBranch,
}: {
  content: string;
  messageId: string;
  onEdit?: (messageId: string, content: string, mode: RevertMode) => void;
  onBranch?: (messageId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [pendingSave, setPendingSave] = useState(false);

  function confirmSave(): void {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setPendingSave(true);
  }

  function selectMode(mode: RevertMode): void {
    const trimmed = draft.trim();
    setEditing(false);
    setPendingSave(false);
    if (trimmed && trimmed !== content) onEdit?.(messageId, trimmed, mode);
  }

  function cancel(): void {
    setDraft(content);
    setEditing(false);
    setPendingSave(false);
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
          {pendingSave && (
            <div className="revert-mode-panel">
              <span className="revert-mode-label">{t("revert.chooseMode")}</span>
              <div className="revert-mode-buttons">
                <button type="button" onClick={() => selectMode("code_and_conv")}>
                  {t("revert.mode.codeAndConv")}
                </button>
                <button type="button" onClick={() => selectMode("conv_only")}>
                  {t("revert.mode.convOnly")}
                </button>
              </div>
            </div>
          )}
          <div className="msg-actions">
            <IconButton label={t("action.cancel")} onClick={cancel}>
              <CloseIcon />
            </IconButton>
            {!pendingSave && (
              <IconButton label={t("action.editAndRetry")} onClick={confirmSave} className="is-confirm">
                <CheckIcon />
              </IconButton>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="user-bubble-row">
      <div className="user-bubble">{content}</div>
      <div className="msg-actions">
        <CopyButton content={content} />
        {onEdit && (
          <IconButton label={t("action.edit")} onClick={() => { setDraft(content); setEditing(true); setPendingSave(false); }}>
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
function MessageActions({ content }: { content: string }) {
  return (
    <div className="msg-actions">
      <CopyButton content={content} />
    </div>
  );
}

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
  onDecision,
}: {
  items: ToolActivity[];
  onDecision: (callId: string, approved: boolean) => void;
}) {
  return (
    <div className="tool-activity">
      {items.map((item) =>
        // 运行中/待确认始终展示完整卡片；已完成/已失败折叠为单行 chip。
        item.status === "running" || item.status === "awaiting" ? (
          <ToolActivityCard key={item.id} item={item} onDecision={onDecision} />
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
  onDecision: (callId: string, approved: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // 状态回到运行中/待确认时（理论上 List 已分流，这里兜底）自动升级为完整卡片。
  useEffect(() => {
    if (item.status === "awaiting" || item.status === "running") setExpanded(true);
  }, [item.status]);

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
  onDecision: (callId: string, approved: boolean) => void;
  /** 由 chip 展开时传入：点击头部收起回到 chip 形态。 */
  onCollapse?: () => void;
  /** chip 展开时默认打开 body（已结束工具的初始 open 否则为 false）。 */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? item.status === "awaiting");
  const [decided, setDecided] = useState(false);

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

  function decide(approved: boolean) {
    setDecided(true);
    onDecision(item.id, approved);
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
      {item.status === "awaiting" && (
        <div className="tool-approval">
          <span className="tool-approval-hint">{t("tool.approvalHint")}</span>
          <div className="tool-approval-actions">
            <button
              type="button"
              className="tool-approval-btn reject"
              disabled={decided}
              onClick={() => decide(false)}
            >
              {t("action.reject")}
            </button>
            <button
              type="button"
              className="tool-approval-btn approve"
              disabled={decided}
              onClick={() => decide(true)}
            >
              {t("action.approve")}
            </button>
          </div>
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

interface AgentRunningTimelineProps {
  busy: boolean;
  online: boolean | null;
  phase: TaskPhase | null;
  status: TaskStatus | null;
  plan: PlanStep[];
  liveToolActivity: ToolActivity[];
  onToolDecision: (callId: string, approved: boolean) => void;
  onStop?: () => void;
}

export function AgentRunningTimeline({
  busy,
  online,
  liveToolActivity,
  onToolDecision,
  onStop,
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

  return (
    <div className="aurevoy-agent-runner-box">
      {online === false && (
        <div className="runner-node is-active fade-in-up">
          <div className="node-dot is-warning">
            <NetworkIcon />
          </div>
          <div className="node-content">
            <span className="badge-network">NETWORK</span>
            <span className="meta-text">正在重新连接 3/5 ...</span>
          </div>
        </div>
      )}

      {liveToolActivity.map((item) => {
        const isFile = /file|dir|write|read|grep|find|artifact/i.test(item.name);
        const isBash = /cmd|command|exec|shell|terminal/i.test(item.name);

        let typeLabel = "Tool";
        let icon = <ToolIcon />;
        let colorClass = "is-tool";

        if (isFile) {
          typeLabel = "Read/Write";
          icon = <FileIcon />;
          colorClass = "is-file";
        } else if (isBash) {
          typeLabel = "Bash";
          icon = <TerminalIcon />;
          colorClass = "is-bash";
        }

        let targetDesc = item.name;
        const argsObj = item.args as any;
        if (argsObj) {
          if (argsObj.TargetFile) targetDesc = getFilename(argsObj.TargetFile);
          else if (argsObj.AbsolutePath) targetDesc = getFilename(argsObj.AbsolutePath);
          else if (argsObj.CommandLine) targetDesc = truncateCommandLine(argsObj.CommandLine);
          else if (argsObj.Query) targetDesc = `Search: "${argsObj.Query}"`;
          else if (argsObj.path) targetDesc = getFilename(argsObj.path);
        }

        return (
          <TimelineToolNode
            key={item.id}
            item={item}
            icon={icon}
            typeLabel={typeLabel}
            colorClass={colorClass}
            targetDesc={targetDesc}
            isBash={isBash}
            onDecision={onToolDecision}
          />
        );
      })}

      {busy && (
        <div className="runner-node is-active fade-in-up">
          <div className="node-dot is-loading">
            <BrainIcon className="spin-icon" />
          </div>
          <div className="node-content">
            <span className="badge-thought">THOUGHT</span>
            <span className="meta-text">for {seconds}s...</span>
          </div>
        </div>
      )}

      {busy && onStop && (
        <div className="runner-global-controls fade-in-up">
          <button type="button" className="btn-stop-global" onClick={onStop}>
            <StopIcon />
            <span>{t("action.stop") || "停止"}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function TimelineToolNode({
  item,
  icon,
  typeLabel,
  colorClass,
  targetDesc,
  isBash,
  onDecision,
}: {
  item: ToolActivity;
  icon: ReactNode;
  typeLabel: string;
  colorClass: string;
  targetDesc: string;
  isBash: boolean;
  onDecision: (callId: string, approved: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(item.status === "awaiting" || item.status === "running");
  const [decided, setDecided] = useState(false);

  useEffect(() => {
    if (item.status === "awaiting") setExpanded(true);
  }, [item.status]);

  const hasDetail = item.output !== undefined || item.error !== undefined || item.args !== undefined;

  function handleDecide(approved: boolean) {
    setDecided(true);
    onDecision(item.id, approved);
  }

  const statusText =
    item.status === "awaiting"
      ? "Awaiting Approval"
      : item.status === "running"
        ? "Running..."
        : item.status === "ok"
          ? "Success"
          : "Failed";

  const isRunning = item.status === "running";
  const badgeType = colorClass.replace("is-", "");

  return (
    <div className={`runner-node is-group ${isRunning ? "is-active" : ""}`}>
      <div className={`node-dot is-${badgeType} ${isRunning ? "is-loading" : ""}`}>
        {isRunning ? <BrainIcon className="spin-icon" /> : icon}
      </div>
      <div className="node-content">
        <div
          className="tool-header"
          onClick={() => hasDetail && setExpanded(!expanded)}
          style={{ cursor: hasDetail ? "pointer" : "default" }}
        >
          <span className={`badge-${badgeType}`}>{typeLabel.toUpperCase()}</span>
          <span className="command-name">{targetDesc}</span>
          <span className={`status-alert is-${item.status}`}>{statusText}</span>
          {hasDetail && <span className="expand-arrow">{expanded ? "⌃" : "›"}</span>}
        </div>

        {expanded && hasDetail && (
          <div className="tool-io-box fade-in-up">
            {isBash ? (
              <>
                {item.args && (
                  <div className="console-line">
                    <span className="terminal-in">IN</span>
                    <pre>{(item.args as any).CommandLine ?? safeStringify(item.args)}</pre>
                  </div>
                )}
                {item.status === "error" && item.error && (
                  <div className="console-line">
                    <span className="terminal-out is-err">ERR</span>
                    <pre>{item.error}</pre>
                  </div>
                )}
                {item.output !== undefined && (
                  <div className="console-line">
                    <span className="terminal-out">OUT</span>
                    <pre>{safeStringify(item.output)}</pre>
                  </div>
                )}
              </>
            ) : (
              <>
                {item.args && safeStringify(item.args) !== "{}" && (
                  <div className="console-line">
                    <span className="terminal-in">ARGS</span>
                    <pre>{safeStringify(item.args)}</pre>
                  </div>
                )}
                {item.status === "error" && item.error && (
                  <div className="console-line">
                    <span className="terminal-out is-err">ERR</span>
                    <pre>{item.error}</pre>
                  </div>
                )}
                {item.output !== undefined && (
                  <div className="console-line">
                    <span className="terminal-out">RESULT</span>
                    <pre>{safeStringify(item.output)}</pre>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {item.status === "awaiting" && (
          <div className="approval-panel">
            <div className="approval-tip">
              ⚠️ 确定执行该操作？风险级别: <span className="text-danger">{item.riskLevel || "unknown"}</span>
            </div>
            <div className="approval-actions">
              <button
                type="button"
                className="btn-reject"
                disabled={decided}
                onClick={(e) => {
                  e.stopPropagation();
                  handleDecide(false);
                }}
              >
                {t("action.reject") || "拒绝执行"}
              </button>
              <button
                type="button"
                className="btn-approve"
                disabled={decided}
                onClick={(e) => {
                  e.stopPropagation();
                  handleDecide(true);
                }}
              >
                {t("action.approve") || "批准运行"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
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

function FileIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="none">
      <path
        d="M4.5 3.5h7l4 4v9a1 1 0 01-1 1h-10a1 1 0 01-1-1v-12a1 1 0 011-1z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M11.5 3.5v4h4" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="none">
      <path
        d="M4.5 6.5l4 3.5-4 3.5M10 13.5h5.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
