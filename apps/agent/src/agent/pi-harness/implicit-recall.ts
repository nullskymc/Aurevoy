import type { Task } from '@aurevoy/shared';
import type { RecallKbResponse } from '../../knowledge-base/index.js';
import type { MemorySystemMessage } from '../context.js';

/** 隐式召回只读取任务目标与用户消息，不把工具输出误当成用户意图。 */
export type ImplicitRecallTask = Pick<Task, 'goal' | 'messages'>;

export type ImplicitRecallSource = 'memory' | 'knowledge_base';

export interface ImplicitRecallSourceEvent {
  source: ImplicitRecallSource;
  count: number;
  citationCount: number;
}

export interface ImplicitRecallErrorEvent {
  source: ImplicitRecallSource;
  error: unknown;
}

export interface ImplicitRecallOptions {
  memoryEnabled: boolean;
  kbEnabled: boolean;
  /** 依赖通过参数注入，避免召回编排与 SQLite/网络实现耦合。 */
  memoryRecall: (query: string) => Promise<MemorySystemMessage>;
  kbRecall: (query: string, topK: number) => Promise<RecallKbResponse>;
  onSource?: (event: ImplicitRecallSourceEvent) => void;
  onError?: (event: ImplicitRecallErrorEvent) => void;
  maxChars?: number;
}

export const DEFAULT_IMPLICIT_RECALL_MAX_CHARS = 8_000;
const DEFAULT_KB_TOP_K = 4;
const MAX_KB_CHUNK_CHARS = 1_200;

/** 选择最接近当前用户意图的查询；新建任务没有用户消息时回退到 goal。 */
export function selectImplicitRecallQuery(task: ImplicitRecallTask): string {
  return (
    [...task.messages].reverse().find((message) => message.role === 'user')?.content.trim()
    || task.goal.trim()
  );
}

/**
 * 并行执行两个独立召回源，并把单来源错误隔离在本次 system prompt 之外。
 * 这条边界保证 embedding/KB 故障不会阻断正常对话或另一种召回。
 */
export async function buildImplicitRecallPrompt(
  task: ImplicitRecallTask,
  options: ImplicitRecallOptions,
): Promise<string> {
  if (!options.memoryEnabled && !options.kbEnabled) return '';

  const query = selectImplicitRecallQuery(task);
  if (!query) return '';

  const jobs: Array<{
    source: ImplicitRecallSource;
    run: () => Promise<MemorySystemMessage | RecallKbResponse>;
  }> = [];
  if (options.memoryEnabled) {
    jobs.push({ source: 'memory', run: () => options.memoryRecall(query) });
  }
  if (options.kbEnabled) {
    jobs.push({ source: 'knowledge_base', run: () => options.kbRecall(query, DEFAULT_KB_TOP_K) });
  }

  const settled = await Promise.allSettled(
    jobs.map((job) => Promise.resolve().then(job.run)),
  );
  const sections: string[] = [];

  settled.forEach((result, index) => {
    const source = jobs[index].source;
    if (result.status === 'rejected') {
      options.onError?.({ source, error: result.reason });
      return;
    }

    if (source === 'memory') {
      const recalled = result.value as MemorySystemMessage;
      const content = recalled.message?.content.trim();
      if (!content) return;
      sections.push(content);
      options.onSource?.({
        source,
        count: recalled.citations.length,
        citationCount: recalled.citations.length,
      });
      return;
    }

    const recalled = result.value as RecallKbResponse;
    if (recalled.results.length === 0) return;
    sections.push(formatKnowledgeSection(recalled));
    options.onSource?.({
      source,
      count: recalled.results.length,
      citationCount: recalled.citations.length,
    });
  });

  return formatImplicitRecallSections(sections, options.maxChars ?? DEFAULT_IMPLICIT_RECALL_MAX_CHARS);
}

/** 知识库召回使用固定提示语，明确其是参考资料而不是高优先级系统指令。 */
function formatKnowledgeSection(recalled: RecallKbResponse): string {
  return [
    '[相关知识库片段]',
    '以下内容由本地知识库自动召回；若与当前用户输入冲突，以当前输入为准：',
    ...recalled.results.map((item) =>
      `- ${item.filePath}#${item.chunkIndex}: ${item.content.slice(0, MAX_KB_CHUNK_CHARS)}`),
  ].join('\n');
}

/** 对所有召回源施加一个总字符上限，避免记忆和 KB 各自截断后叠加挤占上下文。 */
export function formatImplicitRecallSections(
  sections: readonly string[],
  maxChars: number = DEFAULT_IMPLICIT_RECALL_MAX_CHARS,
): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return '';

  let output = '';
  for (const section of sections) {
    const content = section.trim();
    if (!content) continue;
    const separator = output ? '\n\n' : '';
    const remaining = Math.floor(maxChars) - output.length - separator.length;
    if (remaining <= 0) break;
    output += separator + content.slice(0, remaining);
    if (content.length > remaining) break;
  }
  return output;
}
