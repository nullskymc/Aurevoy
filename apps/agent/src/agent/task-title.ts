import { completeSimple } from '@earendil-works/pi-ai/compat';
import {
  formatTaskTitle,
  TASK_TITLE_MAX_LENGTH,
  type Task,
  type TaskTitleSource,
} from '@aurevoy/shared';
import { config } from '../config.js';
import { createPiModel, isPiLLMConfigured } from '../llm/pi-provider.js';
import { taskStore } from '../store/db.js';
import { taskEvents } from './events.js';

const TITLE_REFINE_TIMEOUT_MS = 12_000;
const inFlight = new Set<string>();

export function initialTaskTitle(goal: string): string {
  return formatTaskTitle(goal);
}

export function isTitleStillAuto(task: Task): boolean {
  if (task.titleSource === 'llm') return false;
  const current = (task.title ?? '').trim();
  if (!current) return true;
  return current === formatTaskTitle(task.goal);
}

function assistantSnippet(task: Task, maxChars = 600): string {
  for (let i = task.messages.length - 1; i >= 0; i -= 1) {
    const msg = task.messages[i];
    if (msg.role !== 'assistant') continue;
    const text = msg.content.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  }
  return '';
}

function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (block && typeof block === 'object' && 'type' in block && (block as { type: string }).type === 'text') {
        return typeof (block as { text?: string }).text === 'string' ? (block as { text: string }).text : '';
      }
      return '';
    })
    .join('')
    .trim();
}

function applyTitle(task: Task, title: string, source: TaskTitleSource): void {
  const next = formatTaskTitle(title);
  if (!next || next === task.title) {
    if (source === 'llm' && task.titleSource !== 'llm' && next === task.title) {
      task.titleSource = 'llm';
      task.updatedAt = new Date().toISOString();
      taskStore.save(task);
    }
    return;
  }
  task.title = next;
  task.titleSource = source;
  task.updatedAt = new Date().toISOString();
  taskStore.save(task);
  taskEvents.publish({ type: 'task_title', taskId: task.id, title: next, source });
}

/**
 * 首轮 agent 成功结束后，fire-and-forget 用轻量 LLM 精炼侧栏标题。
 * 语义对齐 Pi #2090：不阻塞主循环；已 LLM/手动标题则跳过。
 */
export function scheduleTaskTitleRefine(task: Task): void {
  if (inFlight.has(task.id)) return;
  if (!isTitleStillAuto(task)) return;
  if (!isPiLLMConfigured()) return;
  const reply = assistantSnippet(task);
  if (!reply) return;

  inFlight.add(task.id);
  void refineTaskTitle(task.id, task.goal, reply)
    .catch(() => {
      /* 精炼失败保留 truncated 标题 */
    })
    .finally(() => {
      inFlight.delete(task.id);
    });
}

async function refineTaskTitle(taskId: string, goal: string, assistantText: string): Promise<void> {
  const latest = taskStore.get(taskId);
  if (!latest || !isTitleStillAuto(latest)) return;

  const model = createPiModel();
  const prompt =
    `Generate a short session title for this chat (max ${TASK_TITLE_MAX_LENGTH} characters).\n` +
    `Rules: same language as the user; concise noun phrase or action; no quotes; no trailing punctuation; no markdown.\n\n` +
    `User:\n${goal.slice(0, 800)}\n\n` +
    `Assistant (excerpt):\n${assistantText}\n\n` +
    `Title:`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TITLE_REFINE_TIMEOUT_MS);
  try {
    const result = await completeSimple(
      model,
      {
        messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      },
      {
        apiKey: config.llm.apiKey,
        maxTokens: 48,
        temperature: 0.2,
        signal: controller.signal,
      },
    );
    if (result.stopReason === 'error' || result.stopReason === 'aborted') return;
    const raw = extractAssistantText(result.content);
    if (!raw) return;

    const fresh = taskStore.get(taskId);
    if (!fresh || !isTitleStillAuto(fresh)) return;
    applyTitle(fresh, raw, 'llm');
  } finally {
    clearTimeout(timer);
  }
}
