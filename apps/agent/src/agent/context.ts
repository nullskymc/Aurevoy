import type { MemoryEntry, Message } from '@aurevoy/shared';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getProvider } from '../llm/provider.js';
import { skillRegistry } from '../skills/registry.js';

/**
 * 会话级短期记忆 —— 上下文窗口管理（M4.2）。
 *
 * 目标：把任务的完整消息历史压缩成"喂给 LLM 的上下文窗口"，而不是裸拼接全部历史。
 * 原则（确定性、可解释、可审计）：
 *  - 用户消息（用户约束/目标）始终逐字保留——它们是任务的边界条件，且通常很短。
 *  - 最近 N 条消息逐字保留（近窗口边界），保证最新工具结果与思考可见。
 *  - 更早的 assistant/tool 内容若超预算则**就地截断为摘要**（保留引用，不删除消息），
 *    从而既压缩体积，又不破坏 OpenAI 的 assistant→tool 配对契约与消息顺序。
 *
 * 该模块只产出"本轮请求用"的消息副本；任务真实历史 `task.messages` 不被修改。
 */

export interface ContextWindowOptions {
  /** 历史消息总字符预算 */
  charBudget: number;
  /** 逐字保留的最近消息条数 */
  recentWindow: number;
  /** 被压缩消息的单条内容字符上限 */
  compressedCharCap: number;
}

export interface ContextWindowResult {
  /** 实际发送给 LLM 的消息（system 由 provider 另行前置） */
  messages: Message[];
  /** 是否发生了压缩 */
  compressed: boolean;
  /** 压缩前历史总字符 */
  originalChars: number;
  /** 压缩后历史总字符 */
  finalChars: number;
  /** 历史消息总条数 */
  totalMessages: number;
  /** 被截断压缩的消息条数 */
  compressedCount: number;
}

function defaultOptions(): ContextWindowOptions {
  return {
    charBudget: config.agent.contextCharBudget,
    recentWindow: config.agent.recentMessageWindow,
    compressedCharCap: config.agent.compressedMessageCharCap,
  };
}

function contentChars(message: Message): number {
  let n = message.content?.length ?? 0;
  if (message.reasoningContent) n += message.reasoningContent.length;
  // tool_calls 的参数也占用上下文
  if (message.toolCalls?.length) {
    for (const tc of message.toolCalls) n += tc.function.arguments?.length ?? 0;
  }
  return n;
}

function totalChars(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + contentChars(m), 0);
}

/** 把一段内容截断为带摘要标记的压缩内容；空内容原样返回。 */
function compressContent(content: string, cap: number): string {
  if (!content || content.length <= cap) return content;
  const kept = content.slice(0, cap);
  const folded = content.length - cap;
  return `${kept}\n…[此处省略 ${folded} 个字符；上下文压缩，完整内容见任务轨迹]`;
}

// ---- P4: Token 估算 ----

/**
 * 轻量 token 估算（不依赖 tiktoken）。
 * CJK 字符 ~1.5 token，拉丁/其他 ~0.25 token。
 * 误差通常在 ±30% 以内，适合做预算判断而非精确计数。
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // CJK 统一表意文字 + 扩展区
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Ext-A
      (code >= 0x20000 && code <= 0x2a6df) || // CJK Ext-B+
      (code >= 0xf900 && code <= 0xfaff) // CJK Compat
    ) {
      tokens += 1.5;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}

function messageTokens(message: Message): number {
  let n = estimateTokens(message.content ?? '');
  if (message.reasoningContent) n += estimateTokens(message.reasoningContent);
  if (message.toolCalls?.length) {
    for (const tc of message.toolCalls) {
      n += estimateTokens(tc.function.arguments ?? '');
    }
  }
  return n;
}

function totalTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0);
}

// ---- P4: 自动语义压缩 ----

export interface AutoCompactResult {
  messages: Message[];
  compressed: boolean;
  /** 被压缩的消息组数 */
  compressedGroupCount: number;
  /** 释放的估算 token 数 */
  savedTokens: number;
  /** 压缩前总 token */
  originalTokens: number;
  /** 压缩后总 token */
  finalTokens: number;
}

/**
 * 当上下文 token 超过预算阈值时，用 LLM 对旧消息做语义摘要。
 *
 * 压缩策略：
 * - 跳过所有 user 消息（用户约束不可变）
 * - 跳过最近 N 轮（活跃上下文窗口）
 * - 跳过 tool 消息（保留 assistant→tool 配对契约）
 * - 压缩目标是旧 assistant 消息 → 替换为一条 system 摘要
 *
 * 不修改 task.messages——只返回本轮请求用的消息副本。
 */
export async function autoCompactIfNeeded(
  messages: Message[],
  tokenBudget?: number,
): Promise<AutoCompactResult> {
  const budget = tokenBudget ?? config.agent.contextTokenBudget;
  const originalTokens = totalTokens(messages);

  if (originalTokens <= budget * config.agent.compactThreshold) {
    return {
      messages,
      compressed: false,
      compressedGroupCount: 0,
      savedTokens: 0,
      originalTokens,
      finalTokens: originalTokens,
    };
  }

  // 找可压缩的 assistant 消息范围：跳过 user 消息 + 最近 N 轮
  const keepRecent = config.agent.compactKeepRecentTurns;
  // 从尾部找最近 N 个 user 消息作为"活跃窗口"边界
  let recentBoundary = messages.length;
  let userCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') userCount++;
    if (userCount >= keepRecent) {
      recentBoundary = i;
      break;
    }
  }

  // 收集可压缩的 assistant 消息（在活跃窗口之前且非 user）
  const compressible: { index: number; message: Message }[] = [];
  for (let i = 0; i < recentBoundary; i++) {
    const m = messages[i];
    // 跳过 user（用户约束）和 tool（配对契约）和 system
    if (m.role === 'assistant' && m.content && m.content.length > 50) {
      compressible.push({ index: i, message: m });
    }
  }

  if (compressible.length <= 2) {
    return {
      messages,
      compressed: false,
      compressedGroupCount: 0,
      savedTokens: 0,
      originalTokens,
      finalTokens: originalTokens,
    };
  }

  // 构建压缩请求：把可压缩消息拼接为摘要输入
  const transcript = compressible
    .map(({ message }) => `[assistant]: ${message.content.slice(0, 1200)}`)
    .join('\n\n');

  let summaryText = '';
  try {
    const promptMessages: Message[] = [
      {
        id: randomUUID(),
        role: 'user',
        content:
          `请将以下对话记录压缩为一段简洁的摘要（300字以内），保留关键信息、决策和结论。只输出摘要文本，不要加前缀：\n\n${transcript}`,
        createdAt: new Date().toISOString(),
      },
    ];
    for await (const chunk of getProvider().stream(promptMessages)) {
      if (chunk.textDelta) summaryText += chunk.textDelta;
    }
  } catch {
    // LLM 压缩失败 → 不做压缩，继续原样
    return {
      messages,
      compressed: false,
      compressedGroupCount: 0,
      savedTokens: 0,
      originalTokens,
      finalTokens: originalTokens,
    };
  }

  if (!summaryText.trim()) {
    return {
      messages,
      compressed: false,
      compressedGroupCount: 0,
      savedTokens: 0,
      originalTokens,
      finalTokens: originalTokens,
    };
  }

  // 构建替换后的消息列表：移除被压缩的 assistant 消息，在最前面插入摘要
  const compressedIndices = new Set(compressible.map((c) => c.index));
  const compactedMessages: Message[] = [];

  // 在被压缩范围前插入 system 摘要
  const firstCompressedIndex = compressible[0].index;
  for (let i = 0; i < firstCompressedIndex; i++) {
    compactedMessages.push(messages[i]);
  }

  const summaryMessage: Message = {
    id: randomUUID(),
    role: 'system',
    content: `[上下文摘要] ${summaryText.trim()}`,
    createdAt: new Date().toISOString(),
  };
  compactedMessages.push(summaryMessage);

  // 跳过被压缩的 assistant 消息，保留其余
  for (let i = firstCompressedIndex; i < messages.length; i++) {
    if (!compressedIndices.has(i)) {
      compactedMessages.push(messages[i]);
    }
  }

  const finalTokens = totalTokens(compactedMessages);

  return {
    messages: compactedMessages,
    compressed: true,
    compressedGroupCount: compressible.length,
    savedTokens: originalTokens - finalTokens,
    originalTokens,
    finalTokens,
  };
}

/**
 * 构建本轮 LLM 请求的上下文窗口。
 *
 * @param history 任务完整消息历史（user/assistant/tool，不含 system）
 */
export function buildContextWindow(
  history: Message[],
  options: Partial<ContextWindowOptions> = {},
): ContextWindowResult {
  const opts = { ...defaultOptions(), ...options };
  const originalChars = totalChars(history);
  const totalMessages = history.length;

  if (originalChars <= opts.charBudget) {
    return {
      messages: history,
      compressed: false,
      originalChars,
      finalChars: originalChars,
      totalMessages,
      compressedCount: 0,
    };
  }

  // 近窗口边界：最后 recentWindow 条逐字保留
  const recentStart = Math.max(0, history.length - opts.recentWindow);
  let compressedCount = 0;

  const messages = history.map((message, index) => {
    const inRecentWindow = index >= recentStart;
    // 用户约束与近窗口逐字保留
    if (inRecentWindow || message.role === 'user') return message;

    const compressedContentText = compressContent(message.content ?? '', opts.compressedCharCap);
    const reasoningCompressed = message.reasoningContent
      ? compressContent(message.reasoningContent, opts.compressedCharCap)
      : message.reasoningContent;

    const changed =
      compressedContentText !== message.content || reasoningCompressed !== message.reasoningContent;
    if (!changed) return message;

    compressedCount += 1;
    // 浅拷贝 + 截断内容；保留 toolCalls / toolCallId / role 等结构，确保配对契约不被破坏
    return {
      ...message,
      content: compressedContentText,
      ...(message.reasoningContent ? { reasoningContent: reasoningCompressed } : {}),
    };
  });

  return {
    messages,
    compressed: compressedCount > 0,
    originalChars,
    finalChars: totalChars(messages),
    totalMessages,
    compressedCount,
  };
}

/** 注入上下文的记忆条数上限（防止记忆膨胀挤占预算）。 */
const MAX_INJECTED_MEMORIES = 20;

const CATEGORY_LABEL: Record<MemoryEntry['category'], string> = {
  preference: '偏好',
  directory: '常用目录',
  model: '模型偏好',
  habit: '习惯',
  fact: '事实',
  other: '其他',
};

// ---- P5: Memory 相关性评分 ----

interface ScoredMemory {
  entry: MemoryEntry;
  score: number;
}

/** 从文本中提取关键词（简单分词，去停用词，去短词）。 */
function extractKeywords(text: string): string[] {
  // 按非字母/非CJK字符拆分
  const tokens = text.toLowerCase().split(/[^a-z0-9一-鿿]+/i);
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
    'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
    'not', 'no', 'nor', 'so', 'if', 'then', 'than', 'too', 'very', 'just',
    'about', 'up', 'out', 'it', 'its', 'this', 'that', 'these', 'those',
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
    '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
    '没有', '看', '好', '自己', '这', '他', '她', '它', '们',
  ]);
  return tokens.filter((t) => t.length >= 2 && !stopWords.has(t));
}

/**
 * P5: 对记忆做相关性评分。
 * - 关键词命中（目标 + 最近话题）
 * - 分类匹配加权
 * - 置信度加权
 * - 时间衰减（每 30 天衰减一半）
 */
function scoreMemories(
  memories: MemoryEntry[],
  goal: string,
  recentTopics: string[],
): ScoredMemory[] {
  const goalWords = extractKeywords(goal);
  const topicWords = recentTopics.flatMap((t) => extractKeywords(t));
  const allRelevant = new Set([...goalWords, ...topicWords]);

  return memories.map((m) => {
    let score = 0;
    const content = m.content.toLowerCase();

    // 1. 关键词命中
    for (const word of allRelevant) {
      if (content.includes(word)) score += 0.15;
    }

    // 2. 分类匹配加权
    if (m.category === 'directory' && /文件|目录|路径|file|dir|path/i.test(goal)) {
      score += 0.2;
    }
    if (m.category === 'model' && /模型|model|provider|llm|api/i.test(goal)) {
      score += 0.2;
    }
    if (m.category === 'preference' && /偏好|风格|格式|format|style/i.test(goal)) {
      score += 0.15;
    }

    // 3. 置信度加权
    score *= 0.5 + m.confidence * 0.5;

    // 4. 时间衰减（每 30 天衰减一半）
    const ageDays =
      (Date.now() - new Date(m.updatedAt).getTime()) / (1000 * 86400);
    score *= Math.pow(0.5, ageDays / 30);

    return { entry: m, score: Math.min(1, score) };
  });
}

// ---- P5: [[link]] 引用解析 ----

/** 从记忆内容中解析 [[link]] 引用，返回被引用记忆的 nameSlug 列表。 */
function parseMemoryLinks(content: string): string[] {
  const matches = content.matchAll(/\[\[([a-z0-9-]+)\]\]/gi);
  return [...matches].map((m) => m[1].toLowerCase());
}

/**
 * P5: 展开关联记忆。
 * 对已选中记忆的 [[link]] 引用进行解析，把被引用记忆也拉入上下文（降权）。
 */
function expandLinkedMemories(
  selected: ScoredMemory[],
  allMemories: MemoryEntry[],
): ScoredMemory[] {
  const expanded = new Map<string, ScoredMemory>();
  for (const s of selected) expanded.set(s.entry.id, s);

  for (const s of selected) {
    const links = parseMemoryLinks(s.entry.content);
    for (const linkName of links) {
      // 检查是否已包含
      const alreadyIncluded = [...expanded.values()].some(
        (sm) => sm.entry.nameSlug === linkName,
      );
      if (alreadyIncluded) continue;

      // 按 nameSlug 查找关联记忆
      const linked = allMemories.find((m) => m.nameSlug === linkName);
      if (linked && !expanded.has(linked.id)) {
        expanded.set(linked.id, {
          entry: linked,
          score: s.score * 0.5, // 关联记忆降权
        });
      }
    }
  }

  return [...expanded.values()].sort((a, b) => b.score - a.score);
}

/**
 * P5: 把启用的长期记忆构建为一条 system 消息，注入到 LLM 上下文最前面。
 *
 * 增强：
 * - 按目标相关性评分排序，只取 top-N
 * - 解析 [[link]] 引用，拉入关联记忆
 * - 标注截断数量
 * - 已禁用的记忆不会出现在这里
 */
export function buildMemorySystemMessage(
  memories: MemoryEntry[],
  goal?: string,
  recentTopics?: string[],
): Message | null {
  const enabled = memories.filter((m) => m.enabled);
  if (enabled.length === 0) return null;

  // 有 goal 时做相关性评分；否则按更新时间取最近
  let selected: ScoredMemory[];
  let truncated = 0;

  if (goal) {
    const scored = scoreMemories(enabled, goal, recentTopics ?? [])
      .filter((s) => s.score > 0.05)
      .sort((a, b) => b.score - a.score);

    // 展开 [[link]] 引用
    const expanded = expandLinkedMemories(scored, enabled);

    selected = expanded.slice(0, MAX_INJECTED_MEMORIES);
    truncated = expanded.length - selected.length;
  } else {
    // 无 goal（兼容旧调用）：按更新时间取最近
    const sorted = enabled
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_INJECTED_MEMORIES);
    selected = sorted.map((m) => ({ entry: m, score: 1 }));
    truncated = enabled.length - sorted.length;
  }

  if (selected.length === 0) return null;

  const lines = selected.map((s) => {
    const label = CATEGORY_LABEL[s.entry.category];
    const howTo = s.entry.howToApply ? ` —— ${s.entry.howToApply}` : '';
    return `- (${label}) ${s.entry.content}${howTo}`;
  });

  let content =
    '[关于用户的长期记忆]\n' +
    '以下是用户确认或你此前记录并启用的长期记忆，作为背景参考；' +
    '若与当前对话中的明确信息冲突，以当前对话为准：\n' +
    lines.join('\n');

  if (truncated > 0) {
    content += `\n\n（还有 ${truncated} 条相关度较低的记忆未列出）`;
  }

  return {
    id: randomUUID(),
    role: 'system',
    content,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Skill: 构建当前激活 skill 的 system message。
 *
 * 若没有活跃 skill 则返回 null。skill 消息放在 memory 消息之后、历史消息之前，
 * 确保 skill 指令优先级高于记忆但低于用户对话。
 */
export function buildSkillSystemMessage(skillName?: string): Message | null {
  if (!skillName) return null;
  const skill = skillRegistry.get(skillName);
  if (!skill) return null;
  return {
    id: randomUUID(),
    role: 'system',
    content: `[技能已激活: ${skill.frontmatter.name}]\n\n${skill.body}`,
    createdAt: new Date().toISOString(),
  };
}
