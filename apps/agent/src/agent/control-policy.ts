/**
 * OpenCode-inspired control-loop policy helpers (pure / unit-testable).
 *
 * - max-steps wrap-up prompt (tools disabled, text-only summary)
 * - resume progress injection (do not restart discovery)
 * - question/status-ask detection for text-first steering
 */
import type { BudgetExceededInfo, PlanStep, Task } from '@aurevoy/shared';

/** OpenCode-style max-steps instruction body (tools must stay disabled). */
export const MAX_STEPS_CRITICAL_HEADER = 'CRITICAL - MAXIMUM STEPS REACHED';
export const COMPLETION_GATE_COMPLETE_MARKER = '<!-- aurevoy:completion=complete -->';
export const COMPLETION_GATE_NEEDS_ATTENTION_MARKER = '<!-- aurevoy:completion=needs_attention -->';

export type CompletionGateVerdict = 'complete' | 'needs_attention';

/**
 * Cache-friendly completion audit.
 *
 * This is deliberately a short follow-up instead of a rebuilt system prompt:
 * the provider can reuse the complete cached conversation prefix and only pay
 * for this small suffix plus the audit output.
 */
export function buildCompletionGatePrompt(): string {
  return [
    '<completion_gate>',
    'Audit the original user goal against the work and verified evidence in this conversation.',
    'Do not summarize the conversation and do not mention this audit.',
    '',
    'Choose exactly one path:',
    `1. COMPLETE: if the full goal is satisfied and verified, reply with only ${COMPLETION_GATE_COMPLETE_MARKER}`,
    '2. CONTINUE: if useful work remains and you are not blocked, continue now with the necessary tools. Do not stop at a promise about what you will do next.',
    `3. NEEDS ATTENTION: if blocked or unable to verify completion, explain the concrete blocker and remaining work, then append ${COMPLETION_GATE_NEEDS_ATTENTION_MARKER}`,
    '',
    'Never claim completion merely because a tool call succeeded or an intermediate answer was produced.',
    '</completion_gate>',
  ].join('\n');
}

/** Only substantive Agent runs pay for an audit; simple text answers and Plan mode stay one-turn. */
export function shouldStartCompletionGate(args: {
  executionMode?: Task['executionMode'];
  toolCallsThisRun: number;
  currentTurnHadToolCall: boolean;
  alreadyRequested: boolean;
}): boolean {
  if (args.executionMode === 'plan') return false;
  if (args.alreadyRequested || args.currentTurnHadToolCall) return false;
  return args.toolCallsThisRun > 0;
}

export function extractCompletionGateVerdict(content: string): CompletionGateVerdict | null {
  if (content.includes(COMPLETION_GATE_COMPLETE_MARKER)) return 'complete';
  if (content.includes(COMPLETION_GATE_NEEDS_ATTENTION_MARKER)) return 'needs_attention';
  return null;
}

/** Internal verdict markers are protocol metadata and must not remain in persisted/user-visible text. */
export function stripCompletionGateMarker(content: string): string {
  return content
    .replaceAll(COMPLETION_GATE_COMPLETE_MARKER, '')
    .replaceAll(COMPLETION_GATE_NEEDS_ATTENTION_MARKER, '')
    .trim();
}

/**
 * Build the follow-up instruction injected when a run hits its step/iteration limit.
 * Mirrors OpenCode packages/core max-steps: tools off, text-only wrap-up.
 */
export function buildMaxStepsPrompt(
  task: Pick<Task, 'goal' | 'plan' | 'budgetExceeded'>,
  info?: BudgetExceededInfo | null,
): string {
  const progress = formatPlanProgressLines(task.plan);
  const reason = info?.reason ?? task.budgetExceeded?.reason ?? 'Step / budget limit reached';
  return [
    MAX_STEPS_CRITICAL_HEADER,
    '',
    'The maximum number of steps (or budget) allowed for this run has been reached.',
    'Tools are DISABLED until the next user input. Respond with text only.',
    '',
    'STRICT REQUIREMENTS:',
    '1. Do NOT make any tool calls (no reads, writes, edits, searches, bash, or any other tools).',
    '2. MUST provide a text response summarizing work done so far.',
    '3. This constraint overrides ALL other instructions, including user requests for more tool use.',
    '',
    'Response must include:',
    '- Statement that the step/budget limit for this run has been reached',
    '- Summary of what has been accomplished so far',
    '- List of blockers or incomplete work',
    '- Recommended next steps for the user (e.g. continue run, fix env, clarify goal)',
    '',
    `Limit reason: ${reason}`,
    `Goal: ${task.goal}`,
    '',
    'Plan progress:',
    progress || '- (no multi-step plan)',
    '',
    'Any attempt to use tools is a critical violation. Respond with text ONLY.',
  ].join('\n');
}

/**
 * Deterministic wrap-up text when the model cannot complete a wrap-up turn
 * (used by finishBudgetPaused as a durable user-visible summary).
 */
export function buildMaxStepsWrapUpMessage(
  task: Pick<Task, 'goal' | 'plan'>,
  info: BudgetExceededInfo,
): string {
  const progress = formatPlanProgressLines(task.plan);
  const done = task.plan.filter((s) => s.status === 'completed').map((s) => s.description);
  const open = task.plan.filter(
    (s) => s.status === 'running' || s.status === 'pending' || s.status === 'paused' || s.status === 'blocked',
  );
  const lines = [
    `${info.reason}。`,
    '',
    '本轮已达步数/预算上限，工具已停用。进度摘要：',
    progress || '- 尚无结构化计划步骤',
  ];
  if (done.length > 0) {
    lines.push('', '已完成：', ...done.map((d) => `- ${d}`));
  }
  if (open.length > 0) {
    lines.push('', '未完成 / 阻塞：', ...open.map((s) => `- [${s.status}] ${s.description}`));
  }
  lines.push(
    '',
    '建议：可继续本任务以在完整上下文上续跑；若仍有外部前置条件未满足，请先处理后再续。',
  );
  return lines.join('\n');
}

/**
 * Progress injection for resume / cancel recovery.
 * Explicitly forbids restarting full discovery when prior plan progress exists.
 *
 * Returns null on a brand-new run (e.g. discover already `running` with no completions),
 * so the first provider turn is not told to "resume from prior work".
 */
export function buildResumeProgressInjection(
  task: Pick<Task, 'goal' | 'plan' | 'checkpoints' | 'budgetExceeded'>,
): string | null {
  const plan = task.plan ?? [];
  if (!hasPriorPlanProgress(task)) return null;

  const progress = formatPlanProgressLines(plan);
  const checkpoint = task.checkpoints?.at(-1);
  const lines = [
    '<progress_checkpoint>',
    'Resume from prior work. Do NOT redo investigation or actions already completed in this task',
    'unless the user explicitly asks to start over or evidence shows those results are obsolete.',
    'Reuse conversation history, plan status, and verified facts; continue from the next incomplete step.',
    '',
    `Goal: ${task.goal}`,
    'Plan status:',
    progress || '- (empty plan — continue from conversation history)',
  ];
  if (checkpoint) {
    lines.push(`Last checkpoint: ${checkpoint.label}${checkpoint.stepId ? ` (step ${checkpoint.stepId})` : ''}`);
  }
  const next = nextOpenPlanStep(plan);
  if (next) {
    lines.push(`Next focus: [${next.status}] ${next.description} (id=${next.id})`);
  } else if (plan.every((s) => s.status === 'completed')) {
    lines.push('Next focus: verify deliverables and report to the user.');
  } else {
    lines.push('Next focus: continue from the last incomplete step using existing conversation evidence.');
  }
  lines.push('</progress_checkpoint>');
  return lines.join('\n');
}

/**
 * True when durable state shows work already advanced (resume/cancel recovery).
 * Fresh multi-step plans start with discover=`running` — that alone is NOT prior progress.
 */
export function hasPriorPlanProgress(
  task: Pick<Task, 'plan' | 'checkpoints' | 'budgetExceeded'>,
): boolean {
  const plan = task.plan ?? [];
  if ((task.checkpoints?.length ?? 0) > 0) return true;
  if (task.budgetExceeded) return true;
  if (plan.some((s) => s.status === 'completed')) return true;
  if (plan.some((s) => s.status === 'blocked' || s.status === 'failed' || s.status === 'paused')) {
    return true;
  }
  // cancelled open work after failOpenPlanSteps also counts as interrupted prior work
  if (plan.some((s) => s.status === 'cancelled') && plan.some((s) => s.status !== 'pending')) {
    return true;
  }
  return false;
}

/** True when the user message is a question or status check (answer in text first). */
export function isQuestionOrStatusAsk(content: string): boolean {
  const text = content.trim();
  if (!text) return false;
  // Strip optional system-reminder wrappers for detection
  const bare = text.replace(/<\/?system-reminder>/gi, '').trim();
  if (/[?？]\s*$/.test(bare) || /[?？]/.test(bare.slice(0, 80))) return true;
  // Generic status / progress / outcome questions (zh + en). Detection may cover colloquial
  // phrasings; model-facing prompts must not cite any particular product or incident.
  if (
    /(什么问题|怎么了|为何|为什么|卡在哪|进度如何|现在怎样|有没有|是否|能不能|可以吗|什么情况|进行到哪|还差什么|装了什么|安装了什么|装了啥|安装啥|what happened|what.?s wrong|what did you|what have you|status|progress|how is|why did|any (error|issue|problem))/i.test(
      bare,
    )
  ) {
    return true;
  }
  // Short interrogative without tools request
  if (/^(什么|怎么|为何|哪些|哪里|哪个|who|what|when|where|why|how)\b/i.test(bare) && bare.length < 120) {
    return true;
  }
  return false;
}

/** Steering prefix: force text answer before tools (OpenCode proactiveness). */
export function buildQuestionFirstSteeringPrefix(): string {
  return [
    '<system-reminder>',
    'The latest user message is a question or status check.',
    'Answer in user-visible text THIS turn before any tool calls.',
    'Do not continue silent tool-only work until you have answered them.',
    'If they only asked for status, tools are optional after a clear text answer.',
    '</system-reminder>',
  ].join('\n');
}

/** Wrap a steering/follow-up user message when it is a status/question ask. */
export function applyQuestionFirstSteering(content: string): string {
  if (!isQuestionOrStatusAsk(content)) return content;
  // Avoid double-wrapping
  if (content.includes('Answer in user-visible text THIS turn')) return content;
  return `${buildQuestionFirstSteeringPrefix()}\n\n${content}`;
}

/** Reason string for blocked tool calls during max-steps wrap-up. */
export function maxStepsToolsDisabledReason(): string {
  return (
    'MAXIMUM STEPS REACHED: tools are disabled for this wrap-up turn. ' +
    'Respond with text only summarizing completed work, blockers, remaining work, and recommended next steps.'
  );
}

export function formatPlanProgressLines(plan: PlanStep[]): string {
  if (!plan.length) return '';
  return plan.map((s) => `- [${s.status}] ${s.id}: ${s.description}`).join('\n');
}

export function nextOpenPlanStep(plan: PlanStep[]): PlanStep | undefined {
  return plan.find(
    (s) =>
      s.status === 'running' ||
      s.status === 'pending' ||
      s.status === 'paused' ||
      s.status === 'blocked' ||
      s.status === 'proposed',
  );
}

/**
 * Pure decision for OpenCode-style max-steps after a provider turn.
 * - start_wrap_up: disable tools + inject text-only follow-up (do not abort yet)
 * - finish_after_wrap_up: abort and pause budget after wrap-up turn
 * - stop: hard stop without another wrap-up
 * - continue: keep running
 */
export type MaxStepsAfterTurnDecision =
  | { action: 'continue' }
  | { action: 'start_wrap_up'; info: BudgetExceededInfo }
  | { action: 'finish_after_wrap_up'; info: BudgetExceededInfo | null }
  | { action: 'stop'; info: BudgetExceededInfo };

export function decideMaxStepsAfterTurn(args: {
  budgetInfo: BudgetExceededInfo | null;
  wrapUpPending: boolean;
  wrapUpDone: boolean;
}): MaxStepsAfterTurnDecision {
  if (args.wrapUpPending) {
    return { action: 'finish_after_wrap_up', info: args.budgetInfo };
  }
  if (!args.budgetInfo) {
    return { action: 'continue' };
  }
  if (!args.wrapUpDone) {
    return { action: 'start_wrap_up', info: args.budgetInfo };
  }
  return { action: 'stop', info: args.budgetInfo };
}
