import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ClarificationRequest,
  ContentBlock,
  Message,
  MessageAttachment,
  PendingToolApproval,
  PlanStep,
  RevertMode,
  Task,
  TaskPhase,
  TaskStatus,
  ToolRiskLevel,
} from "@aurevoy/shared";
import { ImageViewer } from "./ImageViewer";
import { t } from "../i18n";
import { AgentRound, buildAgentRoundFromMessage, buildLiveAgentRoundData, type AgentRoundData } from "./Timeline";
import { usePlatform } from "../platform/context";
import { ContextMenu } from "./ContextMenu";
import type { ContextMenuItem } from "./ContextMenu";
import {
  buildFileMenuItems,
  buildLinkMenuItems,
  buildTextMenuItems,
  contextMenuPoint,
  linkFromEventTarget,
  type ContextMenuState,
} from "./contextMenuActions";
import {
  buildConversationViewModel,
  type ConversationTurn,
} from "./conversationWorkflow";
import "./Conversation.css";

/** 一次工具调用在 UI 中的活动状态（由 App 从事件或消息派生） */
export interface ToolActivity {
  id: string;
  name: string;
  args: unknown;
  status: "awaiting" | "running" | "ok" | "error";
  riskLevel?: ToolRiskLevel;
  planStepId?: string;
  output?: unknown;
  error?: string;
  errorCode?: string;
  progress?: {
    message: string;
    chunk?: { current: number; total: number };
    percent?: number;
  };
}

type ToolDecisionHandler = (callId: string, approved: boolean) => void;

interface ConversationProps {
  task: Task;
  status: TaskStatus | null;
  phase: TaskPhase | null;
  phaseDetail?: string;
  plan: PlanStep[];
  /** 当前正在生成的这一轮的流式文本尾巴（仅运行中有值） */
  output: string;
  busy: boolean;
  /** 当前运行轮次的实时工具活动（来自事件流） */
  liveToolActivity: ToolActivity[];
  /** 是否显示 live tail（由父组件统一计算，避免与 hiddenAssistantId 逻辑不同步） */
  hasLiveTail: boolean;
  /** 是否默认展开工具参数/结果详情。等待审批的工具始终展开。 */
  defaultToolDetailsOpen?: boolean;
  online?: boolean | null;
  /** 工具审批决策回调（批准/拒绝），只作用于当前这一次工具调用。 */
  onToolDecision: ToolDecisionHandler;
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
  errorCode?: string;
}

function parseToolResultContent(content: string): ToolResultInfo {
  let parsed: unknown = content;
  try {
    parsed = JSON.parse(content);
  } catch {
    /* 保留原文 */
  }
  if (parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)) {
    const record = parsed as Record<string, unknown>;
    return {
      ok: false,
      error: String(record.error),
      errorCode: typeof record.errorCode === "string" ? record.errorCode : undefined,
    };
  }
  return { ok: true, output: parsed };
}

/** 扫描消息，建立 toolCallId → 工具结果 的映射 */
function buildToolResultMap(messages: Message[]): Map<string, ToolResultInfo> {
  const map = new Map<string, ToolResultInfo>();
  for (const message of messages) {
    if (message.role !== "tool" || !message.toolCallId) continue;
    map.set(message.toolCallId, parseToolResultContent(message.content));
  }
  return map;
}

function standaloneToolActivityFromMessage(message: Message): ToolActivity {
  const result = parseToolResultContent(message.content);
  const shortId = (message.toolCallId ?? message.id).slice(0, 8);
  return {
    id: message.toolCallId ?? message.id,
    name: `tool_result:${shortId}`,
    args: {},
    status: result.ok ? "ok" : "error",
    output: result.output,
    error: result.error,
    errorCode: result.errorCode,
  };
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
      planStepId: tc.function.planStepId,
      output: result?.output,
      error: result?.error,
      errorCode: result?.errorCode,
    };
  });
}

function collectApprovalItems(
  liveToolActivity: ToolActivity[],
  pendingApprovals: PendingToolApproval[],
): ToolActivity[] {
  const byId = new Map<string, ToolActivity>();
  for (const item of liveToolActivity) {
    if (item.status === "awaiting") byId.set(item.id, item);
  }
  for (const approval of pendingApprovals) {
    const existing = byId.get(approval.call.id);
    byId.set(approval.call.id, {
      id: approval.call.id,
      name: approval.call.toolName,
      args: approval.call.args,
      status: "awaiting",
      riskLevel: approval.riskLevel,
      planStepId: approval.call.planStepId,
      ...existing,
    });
  }
  return [...byId.values()];
}

export function Conversation({
  task,
  phase,
  phaseDetail,
  plan,
  output,
  liveToolActivity,
  hasLiveTail,
  defaultToolDetailsOpen = false,
  onToolDecision,
  onPlanDecision,
  onClarificationAnswer,
  canResume = false,
  hasArchivedMessages = false,
  onUserMessageEdit,
  onUnrevert,
  onBranch,
  onResume,
  liveContentBlocks = [],
}: ConversationProps) {
  const platform = usePlatform();
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const previousTaskIdRef = useRef<string | null>(null);

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>({ open: false, items: [] });

  const closeCtxMenu = useCallback(() => {
    setCtxMenu((prev) => ({ ...prev, open: false }));
  }, []);

  function handleAgentContextMenu(e: React.MouseEvent, message: Message) {
    e.preventDefault();
    e.stopPropagation();
    const link = linkFromEventTarget(e.target);
    const items = link
      ? buildLinkMenuItems({ url: link.url, label: link.label, platform })
      : buildTextMenuItems({ text: message.content, copyLabel: t("action.copy") });
    setCtxMenu({
      open: true,
      point: contextMenuPoint(e),
      items,
    });
  }

  const liveScrollSignature = liveToolActivity
    .map((item) => `${item.id}:${item.status}:${item.progress?.message ?? ""}:${item.progress?.percent ?? ""}`)
    .join("|");

  // SSE 流式过程中统一滚动到底部
  useEffect(() => {
    if (!hasLiveTail && phase !== "waiting_approval") return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [hasLiveTail, output, phase, liveScrollSignature, task.messages.length, liveContentBlocks.length]);

  // 切换到历史任务：滚动到最后一条消息开头；SSE 激活时不干预（由流式效果接棒）
  useEffect(() => {
    if (hasLiveTail || phase === "waiting_approval") return;
    if (previousTaskIdRef.current === task.id) return;
    previousTaskIdRef.current = task.id;

    requestAnimationFrame(() => {
      const thread = document.querySelector(".conversation .conversation-thread");
      if (!thread) return;
      const turns = thread.querySelectorAll(":scope > .conversation-turn");
      const lastTurn = turns[turns.length - 1];
      if (lastTurn) {
        lastTurn.scrollIntoView({ behavior: "auto", block: "start" });
      }
    });
  }, [task.id, hasLiveTail, phase]);

  const messages = task.messages;
  const resultMap = buildToolResultMap(messages);
  const viewModel = buildConversationViewModel({
    messages,
    liveToolActivity,
    output,
    hasLiveTail,
  });
  const liveRoundData = hasLiveTail
    ? buildLiveAgentRoundData({
        plan,
        liveToolActivity: viewModel.liveToolActivity,
        output: viewModel.liveOutput,
        phase,
        contentBlocks: liveContentBlocks,
      })
    : null;
  const approvalItems = collectApprovalItems(viewModel.liveToolActivity, task.pendingApprovals ?? []);
  const showPlanApproval = phase === "waiting_approval" && approvalItems.length === 0 && plan.length > 0;

  return (
    <div className="conversation">
      <div ref={topRef} />
      <div className="conversation-thread">

        {viewModel.turns.map((turn, index) => (
          <ConversationTurnView
            key={turn.id}
            turn={turn}
            isLiveTurn={hasLiveTail && index === viewModel.turns.length - 1}
            resultMap={resultMap}
            plan={task.plan}
            defaultToolDetailsOpen={defaultToolDetailsOpen}
            onToolDecision={onToolDecision}
            onAgentContextMenu={handleAgentContextMenu}
            onUserMessageEdit={onUserMessageEdit}
            onBranch={onBranch}
            liveRoundData={hasLiveTail && index === viewModel.turns.length - 1 ? liveRoundData : null}
            phaseDetail={hasLiveTail && index === viewModel.turns.length - 1 ? phaseDetail : undefined}
          />
        ))}

        {hasLiveTail && (
          <div className="aurevoy-agent-runner-container">
            {approvalItems.length > 0 && (
              <section className="tool-run-summary" data-status="awaiting">
                <div className="tool-run-head">
                  <span className="tool-run-dot" aria-hidden="true" />
                  <span className="tool-run-title">执行工具</span>
                  <span className="tool-run-names">{approvalItems.map((item) => item.name).join("、")}</span>
                  <span className="tool-run-status">等待确认 {approvalItems.length}</span>
                </div>
                {approvalItems.map(item => (
                  <ApprovalInline key={item.id} item={item} onDecision={onToolDecision} />
                ))}
              </section>
            )}

            {showPlanApproval && (
              <PlanApprovalInline
                plan={plan}
                onDecision={onPlanDecision}
              />
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

      <ContextMenu
        items={ctxMenu.items}
        open={ctxMenu.open}
        anchorPoint={ctxMenu.point}
        onClose={closeCtxMenu}
      />
    </div>
  );
}

function ConversationTurnView({
  turn,
  isLiveTurn,
  resultMap,
  plan,
  defaultToolDetailsOpen,
  onToolDecision,
  onAgentContextMenu,
  onUserMessageEdit,
  onBranch,
  liveRoundData,
  phaseDetail,
}: {
  turn: ConversationTurn;
  isLiveTurn: boolean;
  resultMap: Map<string, ToolResultInfo>;
  plan: PlanStep[];
  defaultToolDetailsOpen: boolean;
  onToolDecision: ToolDecisionHandler;
  onAgentContextMenu: (event: React.MouseEvent, message: Message) => void;
  onUserMessageEdit?: (messageId: string, content: string, mode: RevertMode) => void;
  onBranch?: (messageId: string) => void;
  liveRoundData?: AgentRoundData | null;
  phaseDetail?: string;
}) {
  const assistantMessages = turn.agentMessages.filter((message) => message.role === "assistant");
  const attachContentToolCallIds = collectAttachContentToolCallIds(turn.agentMessages);
  const finalMessage = isLiveTurn ? null : findFinalAssistantMessage(turn.agentMessages);
  const finalMessages = finalMessage
    ? [stripProcessNarrationForPresentation(finalMessage)].filter(isRenderableAssistantMessage)
    : [];
  const presentationMessages = assistantMessages.filter(
    (message) => message.id !== finalMessage?.id && isPresentationAssistantMessage(message),
  ).map(stripProcessNarrationForPresentation).filter(isRenderableAssistantMessage);
  const presentationMessageIds = new Set(presentationMessages.map((message) => message.id));
  const finalProcessMessages = finalMessage && isPresentationOnlyAssistantMessage(finalMessage) && hasProcessNarration(finalMessage)
    ? [finalMessage]
    : [];
  const workflowMessages = assistantMessages.filter(
    (message) => message.id !== finalMessage?.id && (!isPresentationOnlyAssistantMessage(message) || hasProcessNarration(message)),
  ).concat(finalProcessMessages);
  const standaloneToolMessages = turn.agentMessages.filter(
    (message) => message.role === "tool" && (!message.toolCallId || !attachContentToolCallIds.has(message.toolCallId)),
  );

  return (
    <div className="conversation-turn">
      {turn.user && (
        <UserBubble
          content={turn.user.content}
          messageId={turn.user.id}
          attachments={turn.user.attachments}
          delivery={turn.user.delivery}
          onEdit={onUserMessageEdit}
          onBranch={onBranch}
        />
      )}

      {(finalMessages.length > 0 || presentationMessages.length > 0 || workflowMessages.length > 0 || standaloneToolMessages.length > 0 || liveRoundData) && (
        <div className="agent-turn">
          {(workflowMessages.length > 0 || standaloneToolMessages.length > 0 || liveRoundData) && (
            <AgentWorkflowDrawer
              assistantMessages={workflowMessages}
              presentationMessageIds={presentationMessageIds}
              standaloneToolMessages={standaloneToolMessages}
              liveRoundData={liveRoundData}
              phaseDetail={phaseDetail}
              resultMap={resultMap}
              plan={plan}
              defaultToolDetailsOpen={defaultToolDetailsOpen}
              onToolDecision={onToolDecision}
              defaultOpen={isLiveTurn}
            />
          )}

          {presentationMessages.map((message) => (
            <div
              key={`presentation-${message.id}`}
              className="agent-final-response"
              onContextMenu={(event) => onAgentContextMenu(event, message)}
            >
              <AgentRound
                data={buildAgentRoundFromMessage(message, resultMap, plan)}
                busy={false}
                defaultToolDetailsOpen={defaultToolDetailsOpen}
                showWorkflow={false}
              />
            </div>
          ))}

          {finalMessages.map((message) => (
            <div
              key={message.id}
              className="agent-final-response"
              onContextMenu={(event) => onAgentContextMenu(event, message)}
            >
                  {getFailureInfo(message) ? (
                    <AgentFailureCard message={message} />
                  ) : (
                    <>
                  <AgentRound
                    data={buildAgentRoundFromMessage(message, resultMap, plan)}
                    busy={false}
                    defaultToolDetailsOpen={defaultToolDetailsOpen}
                    showWorkflow={false}
                  />
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function findFinalAssistantMessage(messages: Message[]): Message | null {
  const attachContentToolCallIds = collectAttachContentToolCallIds(messages);
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "tool") {
      if (message.toolCallId && attachContentToolCallIds.has(message.toolCallId)) continue;
      return null;
    }
    if (message.role !== "assistant") continue;
    if ((message.toolCalls?.length ?? 0) === 0) return message;
    return isPresentationOnlyAssistantMessage(message) ? message : null;
  }
  return null;
}

function getFailureInfo(message: Message): { message: string; category?: string } | null {
  if (message.failure) return message.failure;
  const legacyMatch = message.content.match(/^任务失败，原因：([\s\S]*?)(?:\n\n错误分类：([a-z_]+))?$/);
  if (!legacyMatch) return null;
  return {
    message: legacyMatch[1]?.trim() || message.content,
    category: legacyMatch[2],
  };
}

function AgentFailureCard({ message }: { message: Message }) {
  const failure = getFailureInfo(message);
  if (!failure) return null;
  return (
    <section className="agent-failure-card" role="alert" aria-label="任务失败">
      <div className="agent-failure-head">
        <span className="agent-failure-rule" aria-hidden="true" />
        <strong>运行失败</strong>
        {failure.category && <span>{failure.category}</span>}
      </div>
      <div className="agent-failure-message">{failure.message}</div>
    </section>
  );
}

function isPresentationOnlyAssistantMessage(message: Message): boolean {
  const toolCalls = message.toolCalls ?? [];
  return toolCalls.length > 0 && toolCalls.every((toolCall) => toolCall.function.name === "attach_content");
}

function isPresentationAssistantMessage(message: Message): boolean {
  return isPresentationOnlyAssistantMessage(message) || (message.contentBlocks?.length ?? 0) > 0;
}

function hasProcessNarration(message: Message): boolean {
  return (message.toolCalls?.length ?? 0) > 0 && message.content.trim().length > 0;
}

function stripProcessNarrationForPresentation(message: Message): Message {
  return hasProcessNarration(message) ? { ...message, content: "" } : message;
}

function isRenderableAssistantMessage(message: Message): boolean {
  return !!message.failure || message.content.trim().length > 0 || (message.contentBlocks?.length ?? 0) > 0;
}

function collectAttachContentToolCallIds(messages: Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const toolCall of message.toolCalls ?? []) {
      if (toolCall.function.name === "attach_content") ids.add(toolCall.id);
    }
  }
  return ids;
}

function AgentWorkflowDrawer({
  assistantMessages,
  presentationMessageIds,
  standaloneToolMessages,
  liveRoundData,
  phaseDetail,
  resultMap,
  plan,
  defaultToolDetailsOpen,
  onToolDecision,
  defaultOpen = false,
}: {
  assistantMessages: Message[];
  presentationMessageIds: Set<string>;
  standaloneToolMessages: Message[];
  liveRoundData?: AgentRoundData | null;
  phaseDetail?: string;
  resultMap: Map<string, ToolResultInfo>;
  plan: PlanStep[];
  defaultToolDetailsOpen: boolean;
  onToolDecision: ToolDecisionHandler;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const rounds = assistantMessages.map((message) =>
    buildAgentRoundFromMessage(stripPresentationBlocksForWorkflow(message, presentationMessageIds), resultMap, plan),
  );
  const failed = rounds.some((round) => round.status === "failed") ||
    standaloneToolMessages.some((message) => !parseToolResultContent(message.content).ok) ||
    liveRoundData?.status === "failed";
  const summary = "Thought process";

  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);

  return (
    <section className="workflow-drawer" data-open={open} data-status={failed ? "failed" : "completed"}>
      <button
        type="button"
        className="workflow-drawer-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`${open ? "收起" : "展开"}执行步骤${failed ? "，包含失败步骤" : ""}`}
      >
        <span className="workflow-drawer-icon" aria-hidden="true">
          <WorkflowIcon />
        </span>
        <span className="workflow-drawer-count">{summary}</span>
        <span className="workflow-drawer-caret" data-open={open} aria-hidden="true">
          <ChevronRightIcon />
        </span>
      </button>

      {open && (
        <div className="workflow-drawer-body">
          {rounds.map((round) => (
            <AgentRound
              key={round.id}
              data={round}
              busy={false}
              defaultToolDetailsOpen={defaultToolDetailsOpen}
              showWorkflow
              showOutput
            />
          ))}
          {liveRoundData && (
            <AgentRound
              key="live-workflow-round"
              data={liveRoundData}
              busy={true}
              defaultToolDetailsOpen={defaultToolDetailsOpen}
              showWorkflow
              showOutput
              phaseDetail={phaseDetail}
            />
          )}
          {standaloneToolMessages.length > 0 && (
            <ToolActivityList
              items={standaloneToolMessages.map(standaloneToolActivityFromMessage)}
              defaultDetailsOpen={defaultToolDetailsOpen}
              onDecision={onToolDecision}
            />
          )}
        </div>
      )}
    </section>
  );
}

function stripPresentationBlocksForWorkflow(message: Message, presentationMessageIds: Set<string>): Message {
  if (!presentationMessageIds.has(message.id) && !(message.contentBlocks?.length)) return message;
  return { ...message, contentBlocks: undefined };
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
function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function UserBubble({
  content,
  messageId,
  attachments,
  delivery,
  onEdit,
  onBranch,
}: {
  content: string;
  messageId: string;
  attachments?: MessageAttachment[];
  delivery?: Message["delivery"];
  onEdit?: (messageId: string, content: string, mode: RevertMode) => void;
  onBranch?: (messageId: string) => void;
}) {
  const platform = usePlatform();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [viewingImage, setViewingImage] = useState<string | null>(null);

  // User bubble context menu
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>({ open: false, items: [] });

  function handleUserBubbleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = [
      ...buildTextMenuItems({ text: content, copyLabel: t("action.copy") }),
      ...(onEdit
        ? [
            {
              type: "item" as const,
              id: "edit",
              label: t("action.edit"),
              icon: <PencilIcon />,
              action: () => {
                setDraft(content);
                setEditing(true);
              },
            },
          ]
        : []),
      ...(onBranch
        ? [
            {
              type: "item" as const,
              id: "branch",
              label: t("action.branch"),
              icon: <ForkIcon />,
              action: () => onBranch(messageId),
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

  function handleAttachmentContextMenu(e: React.MouseEvent, attachment: MessageAttachment) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({
      open: true,
      point: contextMenuPoint(e),
      items: buildFileMenuItems({
        path: attachment.path,
        name: attachment.name,
        platform,
        openLabel: attachment.type === "image" ? "打开图片" : "用默认 App 打开",
      }),
    });
  }

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

  const visibleAttachments = attachments ?? [];

  return (
    <div className="user-bubble-row" onContextMenu={handleUserBubbleContextMenu}>
      <div className="user-bubble-col">
        {delivery && (
          <span className="user-bubble-delivery">
            {delivery === "follow_up" ? "Follow-up" : "Steering"}
          </span>
        )}
        <div className="user-bubble">{content}</div>
        {visibleAttachments.length > 0 && (
          <div className="user-bubble-attachments">
            {visibleAttachments.map((att) => {
              const src = (() => {
                try { return platform.filePathToUrl(att.path); } catch { return null; }
              })();
              if (att.type === 'image') {
                return src ? (
                  <button
                    key={att.id}
                    type="button"
                    className="user-bubble-attachment is-image"
                    onClick={() => setViewingImage(att.path)}
                    onContextMenu={(event) => handleAttachmentContextMenu(event, att)}
                    title={att.path}
                  >
                    <img
                      className="user-bubble-image"
                      src={src}
                      alt={att.name}
                      loading="lazy"
                    />
                    <span className="user-bubble-attachment-name">{att.name}</span>
                  </button>
                ) : (
                  <span
                    key={att.id}
                    className="user-bubble-attachment"
                    title={att.path}
                    onContextMenu={(event) => handleAttachmentContextMenu(event, att)}
                  >
                    <AttachmentFileIcon />
                    <span className="user-bubble-attachment-copy">
                      <span className="user-bubble-attachment-name">{att.name}</span>
                      <span className="user-bubble-attachment-meta">{formatFileSize(att.size)}</span>
                    </span>
                  </span>
                );
              }
              return (
                <span
                  key={att.id}
                  className="user-bubble-attachment"
                  title={att.path}
                  onContextMenu={(event) => handleAttachmentContextMenu(event, att)}
                >
                  <AttachmentFileIcon />
                  <span className="user-bubble-attachment-copy">
                    <span className="user-bubble-attachment-name">{att.name}</span>
                    <span className="user-bubble-attachment-meta">{formatFileSize(att.size)}</span>
                  </span>
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

      <ContextMenu
        items={ctxMenu.items}
        open={ctxMenu.open}
        anchorPoint={ctxMenu.point}
        onClose={() => setCtxMenu((p) => ({ ...p, open: false }))}
      />
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

function WorkflowIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <circle cx="5" cy="5" r="2.25" stroke="currentColor" strokeWidth="1.35" fill="none" />
      <circle cx="15" cy="5" r="2.25" stroke="currentColor" strokeWidth="1.35" fill="none" />
      <circle cx="10" cy="15" r="2.25" stroke="currentColor" strokeWidth="1.35" fill="none" />
      <path d="M7.25 5h5.5M5 7.25v2.25A5.5 5.5 0 0010 15M15 7.25v2.25A5.5 5.5 0 0110 15" stroke="currentColor" strokeWidth="1.35" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
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
  onDecision: ToolDecisionHandler;
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
  onDecision: ToolDecisionHandler;
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
      {item.progress && item.status === "running" && (
        <span className="tool-chip-progress">
          {item.progress.percent != null ? `${item.progress.percent}%` : "..."}
        </span>
      )}
      {item.riskLevel && item.riskLevel !== "safe" && (
        <span className="tool-chip-risk" data-risk={item.riskLevel}>
          {item.riskLevel === "dangerous" ? t("tool.risk.dangerousShort") : t("tool.risk.cautionShort")}
        </span>
      )}
    </button>
  );
}

function AttachmentFileIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <path d="M6 2.75h5.1L15 6.65v10.6H6a2 2 0 01-2-2V4.75a2 2 0 012-2z" stroke="currentColor" strokeWidth="1.35" fill="none" strokeLinejoin="round" />
      <path d="M11 3v4h4" stroke="currentColor" strokeWidth="1.35" fill="none" strokeLinejoin="round" />
      <path d="M7.25 11h5.5M7.25 14h4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
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
  return /cmd|command|exec|shell|terminal|bash/i.test(name) ? t("tool.kind.command") : t("tool.kind.tool");
}

function ToolActivityCard({
  item,
  onDecision,
  onCollapse,
  defaultOpen,
}: {
  item: ToolActivity;
  onDecision: ToolDecisionHandler;
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
      ? formatToolError(item.error ?? t("tool.unknownError"), item.errorCode)
      : item.output !== undefined
        ? safeStringify(item.output)
        : null;
  const argsText = safeStringify(item.args);

  function decide(approved: boolean) {
    setDecided(approved ? 'approve' : 'reject');
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
          {item.progress && item.status === "running" && (
            <div className="tool-card-progress">
              {item.progress.percent != null ? (
                <div className="progress-bar">
                  <div
                    className="progress-bar-fill"
                    style={{ width: `${item.progress.percent}%` }}
                  />
                </div>
              ) : (
                <div className="progress-bar is-indeterminate">
                  <div className="progress-bar-fill" />
                </div>
              )}
              <span className="progress-text">
                {item.progress.message}
                {item.progress.chunk && (
                  <span className="progress-chunk">
                    {" "}({item.progress.chunk.current}/{item.progress.chunk.total})
                  </span>
                )}
              </span>
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

function formatToolError(error: string, errorCode?: string): string {
  if (!errorCode) return error;
  const label =
    errorCode === "schema_validation_failed" ? "参数校验失败" :
    errorCode === "approval_denied" ? "审批未通过" :
    errorCode === "execution_failed" ? "执行失败" :
    errorCode;
  return `${label}\n${error}`;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ApprovalInline({
  item,
  onDecision,
}: {
  item: ToolActivity;
  onDecision: ToolDecisionHandler;

}) {
  const [decided, setDecided] = useState<'approve' | 'reject' | null>(null);

  function handleDecide(approved: boolean) {
    setDecided(approved ? 'approve' : 'reject');
    onDecision(item.id, approved);
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
        <button type="button" onClick={() => handleDecide(false)}>
          {t("action.reject")}
        </button>
      </div>
    </div>
  );
}

function PlanApprovalInline({
  plan,
  onDecision,
}: {
  plan: PlanStep[];
  onDecision: (approved: boolean) => void;
}) {
  const [decided, setDecided] = useState<'approve' | 'reject' | null>(null);

  function handleDecide(approved: boolean) {
    setDecided(approved ? 'approve' : 'reject');
    onDecision(approved);
  }

  return (
    <section className="tool-run-summary plan-approval-inline" data-status={decided ?? "awaiting"}>
      <div className="tool-run-head">
        <span className="tool-run-dot" aria-hidden="true" />
        <span className="tool-run-title">执行计划</span>
        <span className="tool-run-names">{plan.length} 个步骤</span>
        <span className="tool-run-status">{decided ? "已处理" : "等待确认"}</span>
      </div>
      <ol className="plan-approval-steps">
        {plan.map((step, index) => (
          <li key={step.id}>
            <span>{index + 1}</span>
            <p>{step.description}</p>
          </li>
        ))}
      </ol>
      {decided ? (
        <div className="tool-run-approval tool-run-approval--decided" data-decision={decided}>
          <span className="tool-run-approval-result">
            {decided === 'approve' ? '✓ 已批准' : '✕ 已拒绝'}
          </span>
        </div>
      ) : (
        <div className="tool-run-approval">
          <span>确认后 Agent 将按该计划继续执行</span>
          <div className="tool-run-approval-actions">
            <button type="button" onClick={() => handleDecide(true)}>
              {t("action.approveOnce")}
            </button>
            <button type="button" onClick={() => handleDecide(false)}>
              {t("action.reject")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function toolApprovalLabel(item: ToolActivity): string {
  if (item.name !== "execute_command" && item.name !== "bash") return item.name;
  const argsObj = item.args as Record<string, unknown> | null;
  if (!argsObj || typeof argsObj !== "object") return item.name;
  const command = typeof argsObj.command === "string" ? argsObj.command : "";
  const commandArgs = Array.isArray(argsObj.args)
    ? argsObj.args.map((arg) => String(arg))
    : [];
  return truncateCommandLine([command, ...commandArgs].filter(Boolean).join(" ")) || item.name;
}

function truncateCommandLine(cmd: string): string {
  if (!cmd) return "";
  if (cmd.length > 50) {
    return cmd.slice(0, 47) + "...";
  }
  return cmd;
}

// Keep references for unused type exports
void toolActivitiesFromAssistant;
void ClarificationCard;
