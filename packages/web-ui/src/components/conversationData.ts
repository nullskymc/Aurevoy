import type {
  Message,
  PendingToolApproval,
  SubagentRun,
  ToolRiskLevel,
} from "@aurevoy/shared";

/** 一次工具调用在 UI 中的活动状态（由事件流或历史消息派生）。 */
export interface ToolActivity {
  id: string;
  name: string;
  args: unknown;
  /** 后端生成的状态无关动作摘要，例如“调用 zotero · search items · 关键词”。 */
  summary?: string;
  status: "awaiting" | "running" | "ok" | "error" | "cancelled";
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

export interface ToolResultInfo {
  ok: boolean;
  output?: unknown;
  error?: string;
  errorCode?: string;
}

/** 解析历史 tool 消息；非 JSON 结果保留原文，避免丢失调试信息。 */
export function parseToolResultContent(content: string): ToolResultInfo {
  let parsed: unknown = content;
  try {
    parsed = JSON.parse(content);
  } catch {
    // 工具可以返回纯文本，不把它误判成失败。
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

/** 扫描消息，建立 toolCallId → 工具结果 的映射。 */
export function buildToolResultMap(messages: Message[]): Map<string, ToolResultInfo> {
  const map = new Map<string, ToolResultInfo>();
  for (const message of messages) {
    if (message.role !== "tool" || !message.toolCallId) continue;
    map.set(message.toolCallId, parseToolResultContent(message.content));
  }
  return map;
}

/** live 正文去重只需要当前用户轮次，避免每批 token 扫描整段历史。 */
export function currentTurnMessages(messages: Message[]): Message[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messages.slice(index);
  }
  return messages;
}

/** 只把当前用户轮次创建的子代理保留在实时过程层，避免续跑时重放旧轮次。 */
export function currentTurnSubagentRuns(messages: Message[], subagentRuns: SubagentRun[]): SubagentRun[] {
  const delegateCallIds = new Set(
    messages.flatMap((message) => (message.toolCalls ?? [])
      .filter((call) => call.function.name === "delegate")
      .map((call) => call.id)),
  );
  return subagentRuns.filter((run) => delegateCallIds.has(run.parentCallId));
}

export function standaloneToolActivityFromMessage(message: Message): ToolActivity {
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

/** 把一条 assistant 消息携带的 toolCalls 派生为工具活动卡片数据。 */
export function toolActivitiesFromAssistant(
  message: Message,
  resultMap: Map<string, ToolResultInfo>,
): ToolActivity[] {
  if (!message.toolCalls?.length) return [];
  return message.toolCalls.map((toolCall) => {
    let args: unknown = {};
    try {
      args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
    } catch {
      args = toolCall.function.arguments;
    }
    const result = resultMap.get(toolCall.id);
    return {
      id: toolCall.id,
      name: toolCall.function.name,
      args,
      summary: toolCall.function.summary,
      status: result ? (result.ok ? "ok" : "error") : "running",
      planStepId: toolCall.function.planStepId,
      output: result?.output,
      error: result?.error,
      errorCode: result?.errorCode,
    };
  });
}

export function collectApprovalItems(
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
      summary: approval.call.summary,
      status: "awaiting",
      riskLevel: approval.riskLevel,
      planStepId: approval.call.planStepId,
      ...existing,
    });
  }
  return [...byId.values()];
}

/** 组装本 turn 对用户可见的交付消息（正文 / 文件），保持消息时序。 */
export function buildDeliveryMessages(
  assistantMessages: Message[],
  finalMessage: Message | null,
  options?: { excludeProcessNarration?: boolean },
): Message[] {
  const excludeProcess = options?.excludeProcessNarration !== false;
  const primary = assistantMessages.filter((message) => {
    if (excludeProcess && isProcessToolNarration(message)) return false;
    if (getFailureInfo(message)) return true;
    if (message.content.trim().length > 0) return true;
    if ((message.contentBlocks?.length ?? 0) > 0) return true;
    return false;
  });

  if (!finalMessage || (excludeProcess && isProcessToolNarration(finalMessage))) {
    return primary;
  }

  const primaryIds = new Set(primary.map((message) => message.id));
  if (!primaryIds.has(finalMessage.id) && isRenderableAssistantMessage(finalMessage)) {
    return [...primary, finalMessage];
  }
  return primary;
}

export function findFinalAssistantMessage(messages: Message[]): Message | null {
  const presentationToolCallIds = collectPresentationToolCallIds(messages);
  // 从后往前跳过纯 attach_content 轮次，优先取带正文、无过程工具的 final 回复。
  let presentationOnlyFallback: Message | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "tool") {
      if (message.toolCallId && presentationToolCallIds.has(message.toolCallId)) continue;
      // 普通 tool 结果打断“尾部 final”搜索。
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
      if (!presentationOnlyFallback) presentationOnlyFallback = message;
      continue;
    }
    // 含非 presentation 工具的 assistant 不是用户可读 final。
    break;
  }
  return presentationOnlyFallback;
}

export function getFailureInfo(message: Message): { message: string; category?: string } | null {
  if (message.failure) return message.failure;
  const legacyMatch = message.content.match(/^任务失败，原因：([\s\S]*?)(?:\n\n错误分类：([a-z_]+))?$/);
  if (!legacyMatch) return null;
  return {
    message: legacyMatch[1]?.trim() || message.content,
    category: legacyMatch[2],
  };
}

/** 仅用于向用户交付附件的工具，不参与工作流过程。 */
const PRESENTATION_TOOL_NAMES = new Set(["attach_content", "present_ui"]);

export function isPresentationToolName(name: string): boolean {
  return PRESENTATION_TOOL_NAMES.has(name);
}

export function isPresentationOnlyAssistantMessage(message: Message): boolean {
  const toolCalls = message.toolCalls ?? [];
  return toolCalls.length > 0 && toolCalls.every((toolCall) => isPresentationToolName(toolCall.function.name));
}

/** 含非 presentation 工具的 assistant：过程旁白/工具轮，正文不进交付区。 */
export function isProcessToolNarration(message: Message): boolean {
  const toolCalls = message.toolCalls ?? [];
  if (toolCalls.length === 0) return false;
  return toolCalls.some((toolCall) => !isPresentationToolName(toolCall.function.name));
}

export function hasProcessNarration(message: Message): boolean {
  return isProcessToolNarration(message) && message.content.trim().length > 0;
}

export function isRenderableAssistantMessage(message: Message): boolean {
  return !!message.failure || message.content.trim().length > 0 || (message.contentBlocks?.length ?? 0) > 0;
}

export function collectPresentationToolCallIds(messages: Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const toolCall of message.toolCalls ?? []) {
      if (isPresentationToolName(toolCall.function.name)) ids.add(toolCall.id);
    }
  }
  return ids;
}

export function stripPresentationBlocksForWorkflow(
  message: Message,
  presentationMessageIds: Set<string>,
): Message {
  // 交付面已单独渲染 contentBlocks；workflow 抽屉只保留工具过程，避免文件卡出现两次。
  if (presentationMessageIds.has(message.id) || (message.contentBlocks?.length ?? 0) > 0) {
    return { ...message, contentBlocks: undefined };
  }
  return message;
}

/** live 计时：过旧的 createdAt（恢复会话）退回 Date.now()，避免“已处理 8000m”。 */
export function resolveProcessStartMs(iso?: string, now = Date.now()): number {
  if (!iso) return now;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return now;
  if (now - timestamp > 6 * 60 * 60 * 1000 || timestamp > now + 60_000) return now;
  return timestamp;
}
