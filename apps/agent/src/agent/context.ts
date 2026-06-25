import type { Citation, MemoryEntry, Message } from '@aurevoy/shared';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getProvider } from '../llm/provider.js';
import { getEmbeddingProvider } from '../embedding/provider.js';
import { searchMemoryVec, isVecLoaded, getMemorySummary, setMemorySummary } from '../store/db.js';
import { skillRegistry } from '../skills/registry.js';

/**
 * 构建可用 skill 的 catalog 消息（Tier 1: name + description + location），
 * 注入到 system prompt 中，让模型知道技能（skill）的存在，可通过 load_skill 工具加载。
 * 当无可用 skill 时返回 null（标准要求不展示空 catalog）。
 */
export function buildSkillCatalogMessage(): Message | null {
  const all = skillRegistry.listAll();
  const descriptors = all.filter((s) => s.enabled);
  if (descriptors.length === 0) return null;

  const catalogLines = descriptors.map((s) => {
    return `- **${s.name}**: ${s.description}`;
  }).join('\n');

  const content =
    '<available_skills>\n' +
    'The following skills provide specialized instructions for specific tasks.\n' +
    'When a task matches a skill\'s description, call the load_skill tool\n' +
    'with the skill\'s name to load its instructions.\n\n' +
    catalogLines +
    '\n</available_skills>';

  return {
    id: randomUUID(),
    role: 'system',
    content,
    createdAt: new Date().toISOString(),
  };
}

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

export function totalTokens(messages: Message[]): number {
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

/** M8: buildMemorySystemMessage 的返回值，包含消息本身和结构化引用列表。 */
export interface MemorySystemMessage {
  message: Message | null;
  citations: Citation[];
}

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

// ---- M8: Time-aware 时间上下文 ----

/** 时间上下文类型 */
type TimeContext = 'recent' | 'past' | 'neutral' | 'future';

/**
 * 从 goal 中检测时间上下文。
 * 影响评分中的时间衰减系数。
 */
function detectTimeContext(goal: string): TimeContext {
  const lower = goal.toLowerCase();

  // 近期上下文
  if (/\b(当前|现在|最近|目前|today|current|recent|just now|now)\b/i.test(lower)) {
    return 'recent';
  }

  // 过往上下文
  if (/\b(之前|以前|过去|上周|上个月|昨天|before|past|previous|last|earlier|ago|yesterday)\b/i.test(lower)) {
    return 'past';
  }

  // 未来上下文
  if (/\b(计划|打算|将要|明天|下周|下个月|future|plan|next|tomorrow|upcoming)\b/i.test(lower)) {
    return 'future';
  }

  return 'neutral';
}

/**
 * 根据时间上下文调整时间衰减系数。
 * "recent" → 降低衰减速度（近期内容更重要）
 * "past"   → 降低衰减速度（回忆过往内容）
 * "future" → 正常衰减
 * "neutral" → 正常衰减
 */
function timeDecayMultiplier(context: TimeContext): number {
  switch (context) {
    case 'recent': return 4.0;  // 衰减速度减为 1/4（相当于 120 天半衰期）
    case 'past':   return 3.0;  // 衰减速度减为 1/3
    case 'future': return 1.0;  // 正常衰减
    case 'neutral': return 1.0; // 正常衰减
  }
}

/**
 * 带时间上下文的评分函数。
 * 在 scoreMemories 基础上，通过 timeDecayMultiplier 调整时间衰减速率。
 */
function scoreMemoriesWithTimeContext(
  memories: MemoryEntry[],
  goal: string,
  recentTopics: string[],
  timeContext: TimeContext,
): ScoredMemory[] {
  const baseScores = scoreMemories(memories, goal, recentTopics);
  const multiplier = timeDecayMultiplier(timeContext);

  // 只有非 neutral 时才调整
  if (multiplier === 1.0) return baseScores;

  return baseScores.map((scored) => {
    const ageDays =
      (Date.now() - new Date(scored.entry.updatedAt).getTime()) / (1000 * 86400);
    // 原始 score 中已经包含了一次时间衰减 (Math.pow(0.5, ageDays/30))
    // 我们需要把它还原再重新应用调整后的衰减
    const originalDecay = Math.pow(0.5, ageDays / 30);
    const adjustedDecay = Math.pow(0.5, ageDays / (30 * multiplier));
    // 如果原衰减 > 0，用调整后的衰减替换；否则保持原分
    if (originalDecay > 0 && originalDecay !== 1.0) {
      const scoreWithoutDecay = scored.score / originalDecay;
      return {
        entry: scored.entry,
        score: scoreWithoutDecay * adjustedDecay,
      };
    }
    return scored;
  });
}

// ---- M8: 混合评分（关键词 + 向量） ----

/** 混合评分权重 alpha：0=纯向量，1=纯关键词，默认 0.5 等权。 */
let _hybridAlpha = 0.5;

/** 设置混合评分权重（设置界面可调）。 */
export function setHybridScoringAlpha(alpha: number): void {
  _hybridAlpha = Math.max(0, Math.min(1, alpha));
}

/** 获取当前混合评分权重。 */
export function getHybridScoringAlpha(): number {
  return _hybridAlpha;
}

/**
 * M8: 混合相关性评分（关键词 + 向量语义）。
 *
 * 在现有关键词评分基础上，叠加向量语义相似度。
 * 向量搜索仅在以下条件同时满足时启用：
 * 1. sqlite-vec 已加载
 * 2. embedding provider 已配置
 * 3. memory_vec 表存在数据
 *
 * 无法满足时静默降级为纯关键词评分（保持现有行为）。
 */
export async function scoreMemoriesHybrid(
  memories: MemoryEntry[],
  goal: string,
  recentTopics: string[],
): Promise<ScoredMemory[]> {
  // 1. 检测时间上下文（影响时间衰减系数）
  const timeContext = detectTimeContext(goal);

  // 2. 关键词评分（复用现有逻辑，但传入调整后的时间上下文）
  const keywordScores = scoreMemoriesWithTimeContext(memories, goal, recentTopics, timeContext);

  // 3. 向量评分（如果有 embedding provider + sqlite-vec）

  // 2. 向量评分（如果有 embedding provider + sqlite-vec）
  if (!isVecLoaded()) return keywordScores;

  const embProvider = getEmbeddingProvider();
  if (!embProvider) return keywordScores;

  const queryText = [goal, ...recentTopics]
    .filter(Boolean)
    .join(' ')
    .trim();
  if (!queryText) return keywordScores;

  try {
    const queryVec = await embProvider.embed(queryText);
    const vecResults = searchMemoryVec(queryVec, MAX_INJECTED_MEMORIES * 2);
    const vectorScores = new Map<string, number>();
    for (const r of vecResults) {
      // 距离 0~2，转为相似度 1~0
      vectorScores.set(r.memoryId, Math.max(0, 1 - r.distance));
    }

    // 3. 混合评分
    const alpha = _hybridAlpha;
    return memories.map((m) => {
      const kw = keywordScores.find((s) => s.entry.id === m.id);
      const kwScore = kw?.score ?? 0;
      const vecScore = vectorScores.get(m.id) ?? 0;
      return {
        entry: m,
        score: alpha * kwScore + (1 - alpha) * vecScore,
      };
    });
  } catch (err) {
    console.warn(
      '[context] 向量评分失败，降级为纯关键词:',
      err instanceof Error ? err.message : String(err),
    );
    return keywordScores;
  }
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

// ---- M8: 记忆摘要缓存 ----

/**
 * 刷新记忆摘要缓存。
 * 对给定目标执行完整的 score + expand + format，写入 memory_summary 表。
 * 不阻塞调用方（void fire-and-forget）。
 */
export async function refreshMemorySummary(memories: MemoryEntry[], goal?: string): Promise<void> {
  try {
    const recentTopics: string[] = [];
    const result = await buildMemorySystemMessageInner(memories, goal, recentTopics);
    if (result.message) {
      setMemorySummary(
        goal,
        result.message.content,
        JSON.stringify(result.citations),
        JSON.stringify(result.citations.map((c) => c.sourceId)),
        memories.filter((m) => m.enabled).length,
      );
    }
  } catch {
    // 缓存刷新失败不影响主流程
  }
}

/** buildMemorySystemMessage 的内部实现，供 refreshMemorySummary 共享。 */
async function buildMemorySystemMessageInner(
  memories: MemoryEntry[],
  goal?: string,
  recentTopics?: string[],
): Promise<MemorySystemMessage> {
  // (内部实现与 public 函数相同，见下方)
  const enabled = memories.filter((m) => m.enabled);
  if (enabled.length === 0) return { message: null, citations: [] };

  let selected: ScoredMemory[];
  let truncated = 0;

  if (goal) {
    const scored = (await scoreMemoriesHybrid(enabled, goal, recentTopics ?? []))
      .filter((s) => s.score > 0.05)
      .sort((a, b) => b.score - a.score);
    const expanded = expandLinkedMemories(scored, enabled);
    selected = expanded.slice(0, MAX_INJECTED_MEMORIES);
    truncated = expanded.length - selected.length;
  } else {
    const sorted = enabled
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_INJECTED_MEMORIES);
    selected = sorted.map((m) => ({ entry: m, score: 1 }));
    truncated = enabled.length - sorted.length;
  }

  if (selected.length === 0) return { message: null, citations: [] };

  const citations: Citation[] = selected.map((s) => ({
    sourceId: s.entry.id,
    sourceType: 'memory' as const,
    content: s.entry.content.slice(0, 200),
    score: Math.round(s.score * 100) / 100,
    category: s.entry.category,
    nameSlug: s.entry.nameSlug,
  }));

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
    message: { id: randomUUID(), role: 'system', content, createdAt: new Date().toISOString() },
    citations,
  };
}

/**
 * P5: 把启用的长期记忆构建为一条 system 消息，注入到 LLM 上下文最前面。
 *
 * M8: 优先使用缓存。记忆变更后调用方应触发 invalidateMemorySummary。
 * 缓存命中时直接返回，避免重复的 LLM 调用和 embedding 请求。
 */
export async function buildMemorySystemMessage(
  memories: MemoryEntry[],
  goal?: string,
  recentTopics?: string[],
): Promise<MemorySystemMessage> {
  // M8: 尝试命中缓存
  try {
    const cached = getMemorySummary(goal);
    if (cached) {
      const citations: Citation[] = cached.citations
        ? (JSON.parse(cached.citations) as Citation[])
        : [];
      return {
        message: cached.content
          ? { id: randomUUID(), role: 'system', content: cached.content, createdAt: new Date().toISOString() }
          : null,
        citations,
      };
    }
  } catch {
    // 缓存读取失败，继续实时计算
  }

  // 未命中缓存，实时计算
  return buildMemorySystemMessageInner(memories, goal, recentTopics);
}

/**
 * 构建环境上下文系统消息（始终注入）。
 *
 * 提供模型感知世界所必需的基础信息：
 * - 当前日期/时间
 * - 操作系统与平台
 * - 工作区目录（文件沙箱边界）
 * - Aurevoy 配置目录（skills / DB / 设置所在）
 * - 项目名称/路径
 */
export function buildSystemContextMessage(
  workspaceDir: string,
  configDir?: string,
  projectInfo?: { name: string; path: string },
): Message {
  const now = new Date();
  const timeStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const lines: string[] = [];
  lines.push('<system_context>');
  lines.push(`Current time: ${now.toISOString()}`);
  lines.push(`Today: ${timeStr}`);
  lines.push(`Platform: ${process.platform} ${process.arch}`);
  lines.push(`Shell: ${process.env.SHELL ?? 'unknown'}`);
  lines.push('');
  lines.push(`Workspace: ${workspaceDir}`);
  if (configDir) lines.push(`Config dir: ${configDir}`);
  if (projectInfo) {
    lines.push(`Project: ${projectInfo.name}`);
    lines.push(`Project path: ${projectInfo.path}`);
  }
  lines.push('</system_context>');

  return {
    id: randomUUID(),
    role: 'system',
    content: lines.join('\n'),
    createdAt: now.toISOString(),
  };
}
