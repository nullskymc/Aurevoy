import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ClarificationRequest,
  Message,
  PlanStep,
  Task,
  TaskArtifact,
  TaskPhase,
  TaskStatus,
  ToolRiskLevel,
} from "@aurevoy/shared";
import { StatusPill } from "./StatusPill";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { getPhaseLabel, getStatusLabel } from "./status";

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
  /** 工具审批决策回调（批准/拒绝） */
  onToolDecision: (callId: string, approved: boolean) => void;
  onClarificationAnswer: (clarificationId: string, answer: string) => void;
  onArtifactDecision: (artifactId: string, status: "confirmed" | "rejected") => void;
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
  onToolDecision,
  onClarificationAnswer,
  onArtifactDecision,
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
  const stillWorking = busy && (hasOutput || liveToolActivity.length > 0);

  return (
    <div className="conversation">
      <div ref={topRef} />
      <div className="conversation-thread">
        {!busy && plan.length > 0 && (
          <RunSummaryPanel task={task} plan={plan} status={status} phase={phase} />
        )}

        {historyMessages.map((message) => {
          if (message.role === "user") {
            return (
              <article className="doc-block doc-block-user" key={message.id}>
                <DocumentMeta icon={<TargetIcon />} label="目标" />
                <div className="doc-user-text">{message.content}</div>
              </article>
            );
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
              </article>
            );
          }
          return null;
        })}

        {/* 当前运行轮次的实时尾巴 */}
        {busy && (
          <article className="doc-block doc-block-agent">
            <DocumentMeta
              icon={<AgentIcon />}
              label={getPhaseLabel(phase) || getStatusLabel(status)}
            />
            <div className="doc-body">
              {plan.length > 0 && <PlanCard plan={plan} />}
              <BudgetBar task={task} />

              {liveToolActivity.length > 0 && (
                <ToolActivityList items={liveToolActivity} onDecision={onToolDecision} />
              )}

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

              {thinking ? (
                <div className="agent-thinking">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                  <span className="thinking-label">
                    {getPhaseLabel(phase) || getStatusLabel(status)}…
                  </span>
                </div>
              ) : (
                hasOutput && (
                  <div className="agent-text markdown-stream">
                    <MarkdownRenderer content={output} />
                    <span className="stream-caret" aria-hidden="true" />
                  </div>
                )
              )}

              {stillWorking && hasOutput && (
                <div className="agent-thinking agent-thinking-inline">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                  <span className="thinking-label">继续推进…</span>
                </div>
              )}
            </div>
          </article>
        )}

        {!busy && (
          <div className="msg-status">
            <StatusPill status={status} phase={phase} />
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
    <section className="clarification-card" aria-label="Agent 追问">
      <div className="clarification-head">
        <strong>需要你补充信息</strong>
        <span>等待回复</span>
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
            placeholder="输入补充信息"
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
          <button type="button" disabled={submitted || !answer.trim()} onClick={() => submit()}>
            回复
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
                拒绝
              </button>
              <button type="button" onClick={() => onDecision(artifact.id, "confirmed")}>
                确认
              </button>
            </div>
          )}
          {artifact.appliedPath && <small>已写入：{artifact.appliedPath}</small>}
        </div>
      )}
    </section>
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

function TargetIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <circle cx="10" cy="10" r="6.5" stroke="currentColor" strokeWidth="1.35" fill="none" />
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.35" fill="none" />
    </svg>
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

function RunSummaryPanel({
  task,
  plan,
  status,
  phase,
}: {
  task: Task;
  plan: PlanStep[];
  status: TaskStatus | null;
  phase: TaskPhase | null;
}) {
  const done = plan.filter((step) => step.status === "completed").length;

  return (
    <section className="run-summary" aria-label="Agent 执行摘要">
      <div className="run-summary-head">
        <div>
          <p className="run-summary-eyebrow">Agent 工作流</p>
          <h2>执行轨迹</h2>
        </div>
        <StatusPill status={status} phase={phase} />
      </div>
      <div className="run-summary-progress" aria-label={`已完成 ${done} / ${plan.length}`}>
        <span style={{ width: `${plan.length ? (done / plan.length) * 100 : 0}%` }} />
      </div>
      <BudgetBar task={task} />
      <PlanCard plan={plan} defaultOpen={false} />
    </section>
  );
}

function BudgetBar({ task }: { task: Task }) {
  const usage = task.budgetUsage;
  const budget = task.budget;
  if (!usage && !budget) return null;
  const toolLimit = budget?.maxToolCalls ?? 80;
  const outputLimit = budget?.maxOutputBytes ?? 1024 * 1024;
  const toolRatio = Math.min(100, ((usage?.toolCalls ?? 0) / toolLimit) * 100);
  const outputRatio = Math.min(100, ((usage?.outputBytes ?? 0) / outputLimit) * 100);

  return (
    <section className="budget-bar" aria-label="预算使用">
      <div>
        <span>工具</span>
        <strong>{usage?.toolCalls ?? 0}/{toolLimit}</strong>
      </div>
      <div className="budget-track"><span style={{ width: `${toolRatio}%` }} /></div>
      <div>
        <span>输出</span>
        <strong>{formatBytes(usage?.outputBytes ?? 0)}/{formatBytes(outputLimit)}</strong>
      </div>
      <div className="budget-track"><span style={{ width: `${outputRatio}%` }} /></div>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function ToolActivityList({
  items,
  onDecision,
}: {
  items: ToolActivity[];
  onDecision: (callId: string, approved: boolean) => void;
}) {
  return (
    <div className="tool-activity">
      {items.map((item) => (
        <ToolActivityCard key={item.id} item={item} onDecision={onDecision} />
      ))}
    </div>
  );
}

function toolStatusIcon(status: ToolActivity["status"]): string {
  switch (status) {
    case "ok":
      return "✓";
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
  return /cmd|command|exec|shell|terminal/i.test(name) ? "命令" : "工具";
}

function ToolActivityCard({
  item,
  onDecision,
}: {
  item: ToolActivity;
  onDecision: (callId: string, approved: boolean) => void;
}) {
  const [open, setOpen] = useState(item.status === "awaiting");
  const [decided, setDecided] = useState(false);

  // 状态变为待确认时自动展开（useState 初始值不随 props 更新，需 effect 补齐）
  useEffect(() => {
    if (item.status === "awaiting") setOpen(true);
  }, [item.status]);

  const statusText =
    item.status === "awaiting"
      ? "待确认"
      : item.status === "running"
        ? "执行中"
        : item.status === "ok"
          ? "完成"
          : "失败";
  const icon = toolStatusIcon(item.status);
  const kindLabel = getToolKindLabel(item.name);
  const detail =
    item.status === "error"
      ? item.error ?? "未知错误"
      : item.output !== undefined
        ? safeStringify(item.output)
        : null;
  const argsText = safeStringify(item.args);

  function decide(approved: boolean) {
    setDecided(true);
    onDecision(item.id, approved);
  }

  return (
    <section className="tool-card" data-open={open} data-status={item.status} aria-label={`${kindLabel}调用 ${item.name}`}>
      <button type="button" className="tool-card-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-card-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="tool-card-kind">{kindLabel}</span>
        <span className="tool-card-name">{item.name}</span>
        {item.riskLevel && item.riskLevel !== "safe" && (
          <span className="tool-card-risk" data-risk={item.riskLevel}>
            {item.riskLevel === "dangerous" ? "高风险" : "需确认"}
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
              <span className="tool-card-field-label">参数</span>
              <pre>{argsText}</pre>
            </div>
          )}
          {detail !== null && (
            <div className="tool-card-field">
              <span className="tool-card-field-label">{item.status === "error" ? "错误" : "结果"}</span>
              <pre>{detail}</pre>
            </div>
          )}
        </div>
      )}
      {item.status === "awaiting" && (
        <div className="tool-approval">
          <span className="tool-approval-hint">该工具需要你的确认才能执行</span>
          <div className="tool-approval-actions">
            <button
              type="button"
              className="tool-approval-btn reject"
              disabled={decided}
              onClick={() => decide(false)}
            >
              拒绝
            </button>
            <button
              type="button"
              className="tool-approval-btn approve"
              disabled={decided}
              onClick={() => decide(true)}
            >
              批准
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
    <section className="plan-card" aria-label="执行计划">
      <button type="button" className="plan-card-head" onClick={() => setOpen((value) => !value)}>
        <span className="plan-card-title">执行计划</span>
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
                {step.status === "completed" ? "✓" : String(index + 1).padStart(2, "0")}
              </span>
              <span className="plan-step-text">{step.description}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
