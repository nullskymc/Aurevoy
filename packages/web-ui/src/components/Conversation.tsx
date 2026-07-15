import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ClarificationRequest,
  ContentBlock,
  Message,
  MessageAttachment,
  PendingToolApproval,
  PlanStep,
  RevertMode,
  SubagentRun,
  Task,
  TaskPhase,
  TaskStatus,
  ToolRiskLevel,
} from "@aurevoy/shared";
import { ImageViewer } from "./ImageViewer";
import { t } from "../i18n";
import {
  AgentRound,
  buildAgentRoundFromMessage,
  buildLiveAgentRoundData,
  dedupeContentBlocks,
  mergeAgentRoundData,
  type AgentRoundData,
} from "./Timeline";
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
  /** 工具审批决策回调（对话内工具卡若仍展示待批时可复用；主审批在 ApprovalsDock）。 */
  onToolDecision: ToolDecisionHandler;
  onClarificationAnswer: (clarificationId: string, answer: string) => void;
  /** 当前任务是否可恢复（中断/失败等可续跑状态） */
  canResume?: boolean;
  /** 当前任务是否有可撤销的 revert（archivedMessages 非空） */
  hasArchivedMessages?: boolean;
  /** 内联编辑用户消息后立刻 revert + continue 重试 */
  onUserMessageEdit?: (
    messageId: string,
    content: string,
    mode: RevertMode,
    attachments?: MessageAttachment[],
  ) => void;
  /** 任务运行中时禁用编辑入口 */
  editDisabled?: boolean;
  /** 撤销上一次 revert */
  onUnrevert?: () => void;
  /** 从指定消息处分支 */
  onBranch?: (messageId: string) => void;
  /** 恢复中断的任务 */
  onResume?: () => void;
  /** Agent 本轮通过 attach_content / present_ui 的实时内容块 */
  liveContentBlocks?: ContentBlock[];
  /** 限定 UI choice 提交 → 作为用户消息续聊 */
  onUiChoice?: (payload: { partId: string; actionId: string; selection: unknown }) => void;
  /** 对话内文件引用 → 侧边工作台预览 */
  onOpenWorkspacePath?: (path: string) => void;
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
  busy,
  liveToolActivity,
  hasLiveTail,
  defaultToolDetailsOpen = false,
  onToolDecision,
  onClarificationAnswer,
  canResume = false,
  hasArchivedMessages = false,
  onUserMessageEdit,
  editDisabled,
  onUnrevert,
  onBranch,
  onResume,
  liveContentBlocks = [],
  onUiChoice,
  onOpenWorkspacePath,
}: ConversationProps) {
  const messageEditDisabled = editDisabled ?? busy;
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
  // 已落到历史消息上的 contentBlocks 不再塞进 live tail，避免「每条消息底部都挂同一文件卡」
  const historicalContentBlockIds = new Set(
    messages.flatMap((message) => dedupeContentBlocks(message.contentBlocks).map((block) => block.id)),
  );
  const liveOnlyContentBlocks = dedupeContentBlocks(liveContentBlocks).filter(
    (block) => !historicalContentBlockIds.has(block.id),
  );
  const liveRoundData = hasLiveTail
    ? buildLiveAgentRoundData({
        plan,
        liveToolActivity: viewModel.liveToolActivity,
        output: viewModel.liveOutput,
        phase,
        contentBlocks: liveOnlyContentBlocks,
        subagentRuns: task.subagentRuns ?? [],
      })
    : null;
  return (
    <div className="conversation">
      <div ref={topRef} />
      <div className="conversation-thread">

        {viewModel.turns.map((turn, index) => (
          <ConversationTurnView
            onUiChoice={onUiChoice}
            onOpenWorkspacePath={onOpenWorkspacePath}
            key={turn.id}
            turn={turn}
            isLiveTurn={hasLiveTail && index === viewModel.turns.length - 1}
            resultMap={resultMap}
            plan={task.plan}
            subagentRuns={task.subagentRuns ?? []}
            defaultToolDetailsOpen={defaultToolDetailsOpen}
            onToolDecision={onToolDecision}
            onAgentContextMenu={handleAgentContextMenu}
            onUserMessageEdit={onUserMessageEdit}
            editDisabled={messageEditDisabled}
            onBranch={onBranch}
            liveRoundData={hasLiveTail && index === viewModel.turns.length - 1 ? liveRoundData : null}
            phaseDetail={hasLiveTail && index === viewModel.turns.length - 1 ? phaseDetail : undefined}
          />
        ))}

        {/* ask-user 追问：留在对话流内 */}
        {(() => {
          const pending = (task.clarifications ?? []).filter((item) => item.status === "pending");
          if (pending.length === 0) return null;
          return (
            <div className="process-gates process-gates--inline" aria-label={t("clarification.label")}>
              {pending.map((clarification) => (
                <ClarificationCard
                  key={clarification.id}
                  clarification={clarification}
                  onAnswer={onClarificationAnswer}
                />
              ))}
            </div>
          );
        })()}
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
  isLiveTurn: _isLiveTurn,
  resultMap,
  plan,
  subagentRuns,
  defaultToolDetailsOpen,
  onToolDecision,
  onAgentContextMenu,
  onUserMessageEdit,
  editDisabled,
  onBranch,
  liveRoundData,
  phaseDetail,
  onUiChoice,
  onOpenWorkspacePath,
}: {
  turn: ConversationTurn;
  isLiveTurn: boolean;
  resultMap: Map<string, ToolResultInfo>;
  plan: PlanStep[];
  subagentRuns: SubagentRun[];
  defaultToolDetailsOpen: boolean;
  onToolDecision: ToolDecisionHandler;
  onAgentContextMenu: (event: React.MouseEvent, message: Message) => void;
  onUserMessageEdit?: (
    messageId: string,
    content: string,
    mode: RevertMode,
    attachments?: MessageAttachment[],
  ) => void;
  editDisabled?: boolean;
  onBranch?: (messageId: string) => void;
  liveRoundData?: AgentRoundData | null;
  phaseDetail?: string;
  onUiChoice?: (payload: { partId: string; actionId: string; selection: unknown }) => void;
  onOpenWorkspacePath?: (path: string) => void;
}) {
  const assistantMessages = turn.agentMessages.filter((message) => message.role === "assistant");
  const attachContentToolCallIds = collectAttachContentToolCallIds(turn.agentMessages);
  // 直播中也解析 final，用于把过程旁白从交付区剔除；直播正文主要靠 liveRoundData
  const finalMessage = findFinalAssistantMessage(turn.agentMessages);
  /**
   * 用户可见交付面：按消息时间序渲染正文 + 文件卡。
   * 含非 presentation 工具的过程旁白（如「我先去看工作区…」）只进过程层，不进交付。
   */
  const deliveryMessages = buildDeliveryMessages(assistantMessages, finalMessage, {
    // 直播且终稿尚未落库：交付区不抢 live 流式区（避免中间条旁白当正文）
    excludeProcessNarration: true,
  });
  const deliveryMessageIds = new Set(deliveryMessages.map((message) => message.id));
  const workflowMessages = assistantMessages.filter((message) => {
    // 含 list_dir/read 等过程工具的旁白：只进过程层
    if (isProcessToolNarration(message)) return true;
    if (finalMessage && message.id === finalMessage.id) {
      // 终稿：仅当是 presentation+旁白时才进过程层，正文终稿不进
      return isPresentationOnlyAssistantMessage(message) && hasProcessNarration(message);
    }
    // 非终稿：原逻辑（非纯 presentation，或 presentation 带旁白）
    return !isPresentationOnlyAssistantMessage(message) || hasProcessNarration(message);
  });
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
          editDisabled={editDisabled}
          onBranch={onBranch}
        />
      )}

      {(deliveryMessages.length > 0 || workflowMessages.length > 0 || standaloneToolMessages.length > 0 || liveRoundData) && (
        <div className="agent-turn">
          {(workflowMessages.length > 0 || standaloneToolMessages.length > 0 || liveRoundData) && (
            <AgentProcessStream
              assistantMessages={workflowMessages}
              presentationMessageIds={deliveryMessageIds}
              standaloneToolMessages={standaloneToolMessages}
              liveRoundData={liveRoundData}
              phaseDetail={phaseDetail}
              resultMap={resultMap}
              plan={plan}
              subagentRuns={subagentRuns}
              defaultToolDetailsOpen={defaultToolDetailsOpen}
              onToolDecision={onToolDecision}
              onUiChoice={onUiChoice}
              onOpenWorkspacePath={onOpenWorkspacePath}
              turnStartedAt={turn.user?.createdAt}
            />
          )}

          {deliveryMessages.map((message) => (
            <div
              key={message.id}
              className="agent-final-response"
              onContextMenu={(event) => onAgentContextMenu(event, message)}
            >
              {getFailureInfo(message) ? (
                <AgentFailureCard message={message} />
              ) : (
                <AgentRound
                  data={buildAgentRoundFromMessage(
                    // 交付面只渲染正文/块；过程工具由 AgentProcessStream 负责，避免剥掉同条消息的用户可见交付
                    { ...message, toolCalls: undefined },
                    resultMap,
                    plan,
                    subagentRuns,
                  )}
                  busy={false}
                  defaultToolDetailsOpen={defaultToolDetailsOpen}
                  showWorkflow={false}
                  onUiChoice={onUiChoice}
                  onOpenWorkspacePath={onOpenWorkspacePath}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 组装本 turn 对用户可见的交付消息（正文 / 文件 / UI），保持与消息历史一致的时序。
 * - file_reference / image / link：跟发起 attach 的那条 assistant 消息走
 * - 纯 present_ui（只有 ui 块、无正文）：仍放到「有正文的最终回复」之后，避免 choice 压住提问
 * - 过程旁白（含 list_dir/read 等非 presentation 工具的中间 assistant）**不进交付**
 */
function buildDeliveryMessages(
  assistantMessages: Message[],
  finalMessage: Message | null,
  options?: { excludeProcessNarration?: boolean },
): Message[] {
  const excludeProcess = options?.excludeProcessNarration !== false;

  const candidates = assistantMessages.filter((message) => {
    if (excludeProcess && isProcessToolNarration(message)) return false;
    if (getFailureInfo(message)) return true;
    if (message.content.trim().length > 0) return true;
    if ((message.contentBlocks?.length ?? 0) > 0) return true;
    return false;
  });

  const primary: Message[] = [];
  const deferredUiOnly: Message[] = [];

  for (const message of candidates) {
    const blocks = message.contentBlocks ?? [];
    const hasText = message.content.trim().length > 0 || Boolean(getFailureInfo(message));
    const hasNonUiBlocks = blocks.some((block) => block.type !== "ui");
    const hasUiBlocks = blocks.some((block) => block.type === "ui");

    // 纯 UI 交互块：延后，保持「先说清问题再出 choice」
    if (!hasText && !hasNonUiBlocks && hasUiBlocks) {
      deferredUiOnly.push(message);
      continue;
    }
    primary.push(message);
  }

  // 若还没有 final 正文（直播中），ui 块仍按时间序跟在当前已有交付后面
  if (!finalMessage || (excludeProcess && isProcessToolNarration(finalMessage))) {
    return [...primary, ...deferredUiOnly];
  }

  // 有 final 时：先按时间序输出正文/文件，再把纯 UI 放到末尾（通常 final 已在 primary 内）
  const primaryIds = new Set(primary.map((message) => message.id));
  if (!primaryIds.has(finalMessage.id) && isRenderableAssistantMessage(finalMessage)) {
    primary.push(finalMessage);
  }
  return [...primary, ...deferredUiOnly];
}

function findFinalAssistantMessage(messages: Message[]): Message | null {
  const presentationToolCallIds = collectPresentationToolCallIds(messages);
  // 从后往前：跳过纯 present_ui/attach_content 轮次，优先取带正文、无过程工具的 final 回复
  let presentationOnlyFallback: Message | null = null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "tool") {
      if (message.toolCallId && presentationToolCallIds.has(message.toolCallId)) continue;
      // 普通 tool 结果打断「尾部 final」搜索
      break;
    }
    if (message.role !== "assistant") continue;
    if ((message.toolCalls?.length ?? 0) === 0) {
      if (message.content.trim().length > 0 || (message.contentBlocks?.length ?? 0) > 0) {
        return message;
      }
      continue;
    }
    if (isPresentationOnlyAssistantMessage(message)) {
      // 仅交付块的消息：若后面没有更好的正文 final，再回退用它
      if (!presentationOnlyFallback) presentationOnlyFallback = message;
      continue;
    }
    // 含非 presentation 工具的 assistant：不是用户可读 final
    break;
  }
  return presentationOnlyFallback;
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

function failureCategoryLabel(category?: string): string | null {
  if (!category) return null;
  switch (category) {
    case "timeout":
      return t("failure.category.timeout");
    case "budget":
      return t("failure.category.budget");
    case "configuration":
      return t("failure.category.configuration");
    case "model":
      return t("failure.category.model");
    case "tool":
      return t("failure.category.tool");
    case "permission":
      return t("failure.category.permission");
    case "cancelled":
      return t("failure.category.cancelled");
    case "parse":
      return t("failure.category.parse");
    default:
      return category;
  }
}

function AgentFailureCard({ message }: { message: Message }) {
  const failure = getFailureInfo(message);
  if (!failure) return null;
  const categoryLabel = failureCategoryLabel(failure.category);
  const isBudget =
    failure.category === "budget" ||
    /预算|budget|最大轮次|maxIterations/i.test(failure.message);
  return (
    <section
      className="agent-failure-card"
      data-kind={isBudget ? "budget" : failure.category || "unknown"}
      role="alert"
      aria-label={t("failure.title")}
    >
      <div className="agent-failure-head">
        <span className="agent-failure-icon" aria-hidden="true">
          {isBudget ? <BudgetIcon /> : <FailureIcon />}
        </span>
        <div className="agent-failure-titles">
          <strong>{isBudget ? t("failure.budgetTitle") : t("failure.title")}</strong>
          {categoryLabel && <span className="agent-failure-badge">{categoryLabel}</span>}
        </div>
      </div>
      <div className="agent-failure-message">{failure.message}</div>
      {isBudget && (
        <p className="agent-failure-tip">{t("failure.budgetTip")}</p>
      )}
    </section>
  );
}

/** 仅用于向用户交付附件/UI 的工具，不参与「工作流过程」叙事 */
const PRESENTATION_TOOL_NAMES = new Set(["attach_content", "present_ui"]);

function isPresentationToolName(name: string): boolean {
  return PRESENTATION_TOOL_NAMES.has(name);
}

function isPresentationOnlyAssistantMessage(message: Message): boolean {
  const toolCalls = message.toolCalls ?? [];
  return toolCalls.length > 0 && toolCalls.every((toolCall) => isPresentationToolName(toolCall.function.name));
}

/** 含非 presentation 工具的 assistant：过程旁白/工具轮，正文不进交付区 */
function isProcessToolNarration(message: Message): boolean {
  const toolCalls = message.toolCalls ?? [];
  if (toolCalls.length === 0) return false;
  return toolCalls.some((toolCall) => !isPresentationToolName(toolCall.function.name));
}

function hasProcessNarration(message: Message): boolean {
  return isProcessToolNarration(message) && message.content.trim().length > 0;
}

function isRenderableAssistantMessage(message: Message): boolean {
  return !!message.failure || message.content.trim().length > 0 || (message.contentBlocks?.length ?? 0) > 0;
}

function collectPresentationToolCallIds(messages: Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const toolCall of message.toolCalls ?? []) {
      if (isPresentationToolName(toolCall.function.name)) {
        ids.add(toolCall.id);
      }
    }
  }
  return ids;
}

/** @deprecated 名称保留兼容；实际含 present_ui */
function collectAttachContentToolCallIds(messages: Message[]): Set<string> {
  return collectPresentationToolCallIds(messages);
}

/**
 * 主对话过程层：同一 turn 合并为 **一个** 过程块（live 状态流 或 单个「已处理」）。
 * 不再按 assistant 消息各画一条「已处理」。
 */
function AgentProcessStream({
  assistantMessages,
  presentationMessageIds,
  standaloneToolMessages,
  liveRoundData,
  phaseDetail,
  resultMap,
  plan,
  subagentRuns,
  defaultToolDetailsOpen,
  onToolDecision,
  onUiChoice,
  onOpenWorkspacePath,
  turnStartedAt,
}: {
  assistantMessages: Message[];
  presentationMessageIds: Set<string>;
  standaloneToolMessages: Message[];
  liveRoundData?: AgentRoundData | null;
  phaseDetail?: string;
  resultMap: Map<string, ToolResultInfo>;
  plan: PlanStep[];
  subagentRuns: SubagentRun[];
  defaultToolDetailsOpen: boolean;
  onToolDecision: ToolDecisionHandler;
  onUiChoice?: (payload: { partId: string; actionId: string; selection: unknown }) => void;
  onOpenWorkspacePath?: (path: string) => void;
  /** 本轮用户消息时间，用于「已处理 Xs」计时 */
  turnStartedAt?: string;
}) {
  const historicalRounds = assistantMessages.map((message) =>
    buildAgentRoundFromMessage(
      stripPresentationBlocksForWorkflow(message, presentationMessageIds),
      resultMap,
      plan,
      subagentRuns,
    ),
  );
  const mergedHistorical = mergeAgentRoundData(historicalRounds, "turn-process");
  // live 时只展示实时状态流；完成后只展示合并后的一个「已处理」
  const showLive = Boolean(liveRoundData);
  const showCompleted = !showLive && mergedHistorical != null;

  const processStartedAtMs = resolveProcessStartMs(turnStartedAt);
  const processDurationMs = (() => {
    const start = turnStartedAt ? Date.parse(turnStartedAt) : NaN;
    if (!Number.isFinite(start)) return null;
    const endIso =
      assistantMessages[assistantMessages.length - 1]?.createdAt ??
      standaloneToolMessages[standaloneToolMessages.length - 1]?.createdAt;
    if (!endIso) return null;
    const end = Date.parse(endIso);
    if (!Number.isFinite(end) || end < start) return null;
    // 仅接受合理区间（避免坏时钟）
    const ms = end - start;
    return ms > 0 && ms < 24 * 60 * 60 * 1000 ? ms : null;
  })();

  return (
    <div className="agent-process-stream" data-process-stream="true">
      {showCompleted && mergedHistorical && (
        <AgentRound
          key={mergedHistorical.id}
          data={mergedHistorical}
          busy={false}
          defaultToolDetailsOpen={defaultToolDetailsOpen}
          showWorkflow
          showOutput={false}
          processDurationMs={processDurationMs}
          onUiChoice={onUiChoice}
          onOpenWorkspacePath={onOpenWorkspacePath}
        />
      )}
      {showLive && liveRoundData && (
        <AgentRound
          key="live-process-round"
          data={liveRoundData}
          busy
          defaultToolDetailsOpen={defaultToolDetailsOpen}
          showWorkflow
          // 流式正文：无运行中工具时打字机输出；有工具时仅灰字过程摘要
          showOutput
          processStartedAtMs={processStartedAtMs}
          onUiChoice={onUiChoice}
          onOpenWorkspacePath={onOpenWorkspacePath}
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
  );
}

function stripPresentationBlocksForWorkflow(message: Message, presentationMessageIds: Set<string>): Message {
  // 交付面已单独渲染 contentBlocks；workflow 抽屉只保留工具过程，避免同一文件卡出现两次
  if (presentationMessageIds.has(message.id) || (message.contentBlocks?.length ?? 0) > 0) {
    return { ...message, contentBlocks: undefined };
  }
  return message;
}

/** live 计时：过旧的 createdAt（恢复会话）退回 Date.now()，避免「已处理 8000m」 */
function resolveProcessStartMs(iso?: string): number {
  const now = Date.now();
  if (!iso) return now;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return now;
  if (now - t > 6 * 60 * 60 * 1000 || t > now + 60_000) return now;
  return t;
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
    <section className="approval-card gate-card" aria-label={t("clarification.label")}>
      <header className="approval-card-head">
        <span className="approval-card-title">{t("clarification.title")}</span>
        <span className="approval-card-meta">{t("clarification.waiting")}</span>
      </header>
      <p className="approval-card-body">{clarification.question}</p>
      {clarification.context ? (
        <p className="approval-card-context">{clarification.context}</p>
      ) : null}
      {clarification.options?.length ? (
        <div className="gate-card-options">
          {clarification.options.map((option) => (
            <button
              type="button"
              key={option}
              className="gate-card-chip"
              disabled={submitted}
              onClick={() => submit(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : (
        <div className="gate-card-input-row">
          <input
            value={answer}
            disabled={submitted}
            placeholder={t("clarification.inputPlaceholder")}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
          <button
            type="button"
            className="approval-card-btn approval-card-btn--allow"
            disabled={submitted || !answer.trim()}
            onClick={() => submit()}
          >
            {t("action.reply")}
          </button>
        </div>
      )}
    </section>
  );
}



/** 用户消息气泡：可复制；内联轻量编辑后立刻重试（revert + continue）。 */
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
  editDisabled,
  onBranch,
}: {
  content: string;
  messageId: string;
  attachments?: MessageAttachment[];
  delivery?: Message["delivery"];
  onEdit?: (
    messageId: string,
    content: string,
    mode: RevertMode,
    attachments?: MessageAttachment[],
  ) => void;
  editDisabled?: boolean;
  onBranch?: (messageId: string) => void;
}) {
  const platform = usePlatform();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [viewingImage, setViewingImage] = useState<string | null>(null);

  // User bubble context menu
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>({ open: false, items: [] });

  function beginEdit(): void {
    if (editDisabled || !onEdit) return;
    setDraft(content);
    setEditing(true);
  }

  function handleUserBubbleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = [
      ...buildTextMenuItems({ text: content, copyLabel: t("action.copy") }),
      ...(onEdit && !editDisabled
        ? [
            {
              type: "item" as const,
              id: "edit",
              label: t("action.edit"),
              icon: <PencilIcon />,
              action: beginEdit,
            },
          ]
        : []),
      ...(onBranch && !editDisabled
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
    if (!trimmed || editDisabled) return;
    setEditing(false);
    // 默认 code_and_conv：截断对话并清理后续 plan / checkpoint；附件随原消息一并续跑
    onEdit?.(
      messageId,
      trimmed,
      "code_and_conv",
      attachments && attachments.length > 0 ? attachments : undefined,
    );
  }

  function cancel(): void {
    setDraft(content);
    setEditing(false);
  }

  if (editing) {
    const lineCount = Math.max(1, draft.split("\n").length);
    const canSubmit = draft.trim().length > 0 && !editDisabled;
    return (
      <div className="user-bubble-row is-editing">
        <div className="user-edit-bubble" role="form" aria-label={t("action.editAndRetry")}>
          <textarea
            className="user-edit-bubble-input"
            value={draft}
            autoFocus
            rows={Math.min(8, Math.max(1, lineCount))}
            placeholder={t("editRetry.placeholder")}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              // Enter 发送；Shift+Enter 换行（与 Composer 一致）
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                confirmSave();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancel();
              }
            }}
          />
          <div className="user-edit-bubble-actions">
            <button type="button" className="user-edit-bubble-btn is-cancel" onClick={cancel}>
              {t("action.cancel")}
            </button>
            <button
              type="button"
              className="user-edit-bubble-btn is-send"
              onClick={confirmSave}
              disabled={!canSubmit}
            >
              {t("composer.send")}
            </button>
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
                try { return att.dataUrl ?? platform.filePathToUrl(att.path); } catch { return null; }
              })();
              if (att.type === 'image') {
                return src ? (
                  <button
                    key={att.id}
                    type="button"
                    className="user-bubble-attachment is-image"
                    onClick={() => setViewingImage(att.dataUrl ?? att.path)}
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
          <IconButton
            label={editDisabled ? t("editRetry.disabledBusy") : t("action.edit")}
            onClick={beginEdit}
            disabled={editDisabled}
          >
            <PencilIcon />
          </IconButton>
        )}
        {onBranch && (
          <IconButton
            label={editDisabled ? t("editRetry.disabledBusy") : t("action.branch")}
            onClick={() => onBranch(messageId)}
            disabled={editDisabled}
          >
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
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={className ? `msg-action-btn ${className}` : "msg-action-btn"}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
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

function FailureIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <path d="M10 6.5v4.2M10 13.2h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function BudgetIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
      <path
        d="M4 5.5h12v9H4zM7 5.5V4.2a1 1 0 011-1h4a1 1 0 011 1v1.3"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        strokeLinejoin="round"
      />
      <path d="M4 9.5h12" stroke="currentColor" strokeWidth="1.4" />
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
  const [decided, setDecided] = useState<"approve" | "reject" | null>(null);
  const commandPreview = toolApprovalLabel(item);
  const kindLabel = getToolKindLabel(item.name);

  function handleDecide(approved: boolean) {
    setDecided(approved ? "approve" : "reject");
    onDecision(item.id, approved);
  }

  if (decided) {
    return (
      <section className="approval-card approval-card--decided" data-decision={decided}>
        <span className="approval-card-result">
          {decided === "approve" ? "✓ 已批准" : "✕ 已拒绝"} · {commandPreview}
        </span>
      </section>
    );
  }

  const argsPreview =
    item.args && typeof item.args === "object"
      ? (() => {
          try {
            return JSON.stringify(item.args, null, 2);
          } catch {
            return "";
          }
        })()
      : "";

  return (
    <section className="approval-card gate-card" data-status="awaiting" aria-label={t("tool.approvalHint")}>
      <header className="approval-card-head">
        <span className="approval-card-glyph" aria-hidden="true">
          {">_"}
        </span>
        <span className="approval-card-title">{kindLabel}</span>
        <span className="approval-card-meta">{t("tool.approvalPending")}</span>
      </header>
      {commandPreview ? (
        <pre className="approval-card-command">{commandPreview}</pre>
      ) : (
        <p className="approval-card-body">{t("tool.approvalHint")}</p>
      )}
      {argsPreview && argsPreview !== "{}" && argsPreview.length < 280 && (
        <pre className="approval-card-args">{argsPreview}</pre>
      )}
      <div className="approval-card-actions">
        <button
          type="button"
          className="approval-card-btn approval-card-btn--reject"
          onClick={() => handleDecide(false)}
        >
          {t("action.reject")}
        </button>
        <button
          type="button"
          className="approval-card-btn approval-card-btn--allow"
          onClick={() => handleDecide(true)}
        >
          {t("action.approveOnce")}
        </button>
      </div>
    </section>
  );
}

function PlanApprovalInline({
  plan,
  onDecision,
}: {
  plan: PlanStep[];
  onDecision: (approved: boolean) => void;
}) {
  const [decided, setDecided] = useState<"approve" | "reject" | null>(null);

  function handleDecide(approved: boolean) {
    setDecided(approved ? "approve" : "reject");
    onDecision(approved);
  }

  // 决策后直接卸掉，不占输入框上方空间
  if (decided) return null;

  return (
    <section
      className="approval-card gate-card plan-approval-card"
      data-status="awaiting"
      aria-label="计划审批"
    >
      <header className="approval-card-head">
        <span className="approval-card-glyph" aria-hidden="true">
          ▤
        </span>
        <span className="approval-card-title">执行计划</span>
        <span className="approval-card-meta">{plan.length} 个步骤</span>
      </header>
      <ol className="plan-approval-steps">
        {plan.map((step, index) => (
          <li key={step.id}>
            <span>{index + 1}</span>
            <p>{step.description}</p>
          </li>
        ))}
      </ol>
      <p className="approval-card-body">确认后将按该计划继续</p>
      <div className="approval-card-actions">
        <button
          type="button"
          className="approval-card-btn approval-card-btn--reject"
          onClick={() => handleDecide(false)}
        >
          {t("action.reject")}
        </button>
        <button
          type="button"
          className="approval-card-btn approval-card-btn--allow"
          onClick={() => handleDecide(true)}
        >
          {t("action.approveOnce")}
        </button>
      </div>
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

/** 工具/计划审批：固定在输入框上方（composer-dock），不进对话流 */
export function ApprovalsDock({
  liveToolActivity,
  pendingApprovals,
  phase,
  plan,
  onToolDecision,
  onPlanDecision,
}: {
  liveToolActivity: ToolActivity[];
  pendingApprovals?: PendingToolApproval[];
  phase: TaskPhase | null;
  plan: PlanStep[];
  onToolDecision: ToolDecisionHandler;
  onPlanDecision: (approved: boolean) => void;
}) {
  const approvalItems = collectApprovalItems(liveToolActivity, pendingApprovals ?? []);
  const showPlanApproval = phase === "waiting_approval" && approvalItems.length === 0 && plan.length > 0;
  if (approvalItems.length === 0 && !showPlanApproval) return null;

  return (
    <div className="process-gates process-gates--dock" aria-label={t("tool.approvalHint")}>
      {approvalItems.map((item) => (
        <ApprovalInline key={item.id} item={item} onDecision={onToolDecision} />
      ))}
      {showPlanApproval && <PlanApprovalInline plan={plan} onDecision={onPlanDecision} />}
    </div>
  );
}

// Keep references for unused type exports
void toolActivitiesFromAssistant;
