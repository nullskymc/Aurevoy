import type { Citation, MemoryEntry, Message } from '@aurevoy/shared';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getEmbeddingProvider } from '../embedding/provider.js';
import { searchMemoryVec, isVecLoaded, getMemorySummary, setMemorySummary } from '../store/db.js';
import { skillRegistry } from '../skills/registry.js';
import { formatSubagentRoleCatalogForTool } from './subagent-profiles.js';

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
 * Cache-aware 上下文压缩管线（参考 Claude Code 四层压缩设计）。
 *
 * 三层递进压缩（由轻到重）：
 *   1. Snip（零成本） → 2. Microcompact（零成本） → 3. Context Collapse（LLM 摘要）
 *
 * Cache-aware（前缀稳定）：
 *   - Snip / Microcompact 是确定性纯函数，每一轮对整表重放。
 *     会话里始终存原文；重放后已发送前缀字节与上一轮一致，不会“解压”回原文。
 *   - 切勿用“消息条数边界”跳过已发送区：边界按条数记、会话回灌原文时会把
 *     已 microcompact 的 tool 结果重新展开，破坏 prompt cache 前缀。
 *   - Context Collapse 会改写旧消息 → 返回 collapsed=true，调用方重置缓存边界
 *   - 写入/确认类工具结果不压缩
 */

// ---- 工具类型分类 ----

/** 输出较大的工具（内容会被 Microcompact 结构化压缩） */
export const TOOLS_WITH_LARGE_OUTPUT = new Set([
  'read', 'grep', 'glob', 'list_directory', 'web_fetch', 'web_search',
  'bash', 'execute_command',
  // 历史别名（压缩旧轨迹时仍可能出现）
  'open_file', 'scroll', 'search_grep', 'edit_lines', 'replace_lines',
]);

/** 写入/确认/交付类工具（输出简短，不压缩） */
export const TOOLS_KEEP_VERBATIM = new Set([
  'write', 'edit', 'copy_file', 'move_file', 'rename_file', 'delete_file',
  'apply_artifact', 'create_artifact', 'attach_content',
  'bundle_report', 'delegate', 'remember', 'recall', 'ask_user', 'load_skill',
  // 历史别名
  'write_file', 'create_file', 'append_file',
  'session_open', 'session_write', 'session_close', 'session_abort',
  'index_files',
]);

// ---- 公共类型 ----

export interface CompactContextResult {
  /** 压缩后的消息列表 */
  messages: Message[];
  /** Context Collapse 是否执行了（true → 调用方应重置缓存边界） */
  collapsed: boolean;
  stats: {
    snipped: number;
    microcompacted: number;
    cachedPrefixPreserved: boolean;
    savedTokens: number;
    originalTokens: number;
    finalTokens: number;
  };
}

// ---- 1. Snip: 移除空/无意义的 tool_result ----

/**
 * 移除空的 tool_result 消息及其配对的 assistant（如果该 assistant 的所有工具结果都被移除）。
 * 对整表确定性重放，保证多轮 append 时前缀字节稳定。
 */
export function snipToolResults(messages: Message[]): Message[] {
  // 构建 toolCallId → toolName 映射
  const toolCallToName = buildToolNameMap(messages);

  // 找出可以 snip 的 tool_result index
  const snipToolResultIndices = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'tool' || !m.toolCallId) continue;

    // 检查内容是否为空或仅含基本信息
    const toolName = toolCallToName.get(m.toolCallId);
    if (toolName && TOOLS_KEEP_VERBATIM.has(toolName)) continue; // 保留确认类结果

    const content = m.content?.trim();
    if (!content || content === '{}' || content === '{"ok":true}' || content === 'null' || content === 'undefined') {
      snipToolResultIndices.add(i);
    }
  }

  if (snipToolResultIndices.size === 0) return messages;

  // 同时检查配对的 assistant：如果它的所有 tool_results 都被 snip 了，也移除该 assistant
  const snipAssistantIndices = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.toolCalls?.length) continue;

    const callIds = new Set(m.toolCalls.map(tc => tc.id));
    let allSnipped = true;
    let anyFound = false;
    // 向后扫描配对的 tool 结果
    for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j++) {
      const tm = messages[j];
      if (tm.toolCallId && callIds.has(tm.toolCallId)) {
        anyFound = true;
        if (!snipToolResultIndices.has(j)) {
          allSnipped = false;
          break;
        }
      }
    }
    if (anyFound && allSnipped) {
      snipAssistantIndices.add(i);
    }
  }

  const remove = new Set([...snipToolResultIndices, ...snipAssistantIndices]);
  return messages.filter((_, i) => !remove.has(i));
}

// ---- 2. Microcompact: 结构化工具结果压缩 ----

/** 构建 toolCallId → toolName 映射 */
function buildToolNameMap(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        map.set(tc.id, tc.function.name);
      }
    }
  }
  return map;
}

const TEXT_COMPACT_HEAD = 800;
const TEXT_COMPACT_TAIL = 400;
const TEXT_COMPACT_MIN = TEXT_COMPACT_HEAD + TEXT_COMPACT_TAIL + 80;

/** 超长纯文本：保留头尾，确定性结构，避免二次漂移。 */
function compactPlainTextPayload(raw: string, label = 'output'): string | null {
  if (raw.length < TEXT_COMPACT_MIN) return null;
  return JSON.stringify({
    [label]: `${raw.slice(0, TEXT_COMPACT_HEAD)}\n…\n${raw.slice(-TEXT_COMPACT_TAIL)}`,
    char_count: raw.length,
    _compacted: true,
    _note: `全文 ${raw.length} 字符，保留头 ${TEXT_COMPACT_HEAD} + 尾 ${TEXT_COMPACT_TAIL}`,
  });
}

function tryParseToolJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 按工具类型对单个 tool_result 的 content 做结构化压缩。返回 null = 不需要压缩。 */
export function compactToolResult(toolName: string, rawContent: string): string | null {
  const parsed = tryParseToolJson(rawContent);

  switch (toolName) {
    case 'open_file':
    case 'scroll': {
      if (!parsed) return compactPlainTextPayload(rawContent, 'content');
      const path = parsed.path as string | undefined;
      const totalLines = parsed.total_lines as number | undefined;
      const winStart = parsed.window_start as number | undefined;
      const winEnd = parsed.window_end as number | undefined;
      const center = parsed.center_line as number | undefined;
      return JSON.stringify({
        path,
        total_lines: totalLines,
        window_start: winStart,
        window_end: winEnd,
        center_line: center,
        _compacted: true,
        _note: `视口 ${winStart}-${winEnd}/${totalLines}，中心行 ${center}`,
      });
    }

    case 'search_grep':
    case 'grep': {
      if (!parsed) {
        // Effect grep 常以纯文本 path:line:text 多行输出
        const lines = rawContent.split('\n').filter(Boolean);
        if (lines.length <= 8 && rawContent.length < TEXT_COMPACT_MIN) return null;
        return JSON.stringify({
          match_count: lines.length,
          matches: lines.slice(0, 8).map((line) => line.slice(0, 240)),
          _compacted: true,
          _note: lines.length > 8 ? `前 8/${lines.length} 条匹配` : `已截断匹配预览`,
        });
      }
      const pattern = parsed.pattern as string | undefined;
      const count = parsed.match_count as number | undefined;
      const matches = Array.isArray(parsed.matches) ? parsed.matches as Record<string, unknown>[] : [];
      return JSON.stringify({
        pattern,
        match_count: count,
        truncated: parsed.truncated,
        matches: matches.slice(0, 3).map(m => ({
          file: m.file,
          line: m.line,
          content: String(m.content ?? m.text ?? '').slice(0, 200),
        })),
        _compacted: true,
        _note: count && count > 3
          ? `前 3/${count} 条匹配。用更精确的 pattern 缩小范围。`
          : undefined,
      });
    }

    case 'web_fetch': {
      if (!parsed) return compactPlainTextPayload(rawContent, 'content');
      const url = parsed.url as string | undefined;
      const status = parsed.status as number | undefined;
      const text = (parsed.content as string | undefined) ?? '';
      const links = Array.isArray(parsed.links) ? parsed.links as Record<string, unknown>[] : [];
      return JSON.stringify({
        url,
        status,
        contentType: parsed.contentType,
        text_preview: text.slice(0, 300),
        link_count: links.length,
        _compacted: true,
        _note: text.length > 300
          ? `全文 ${text.length} 字符，已截取前 300 字符。`
          : undefined,
      });
    }

    case 'web_search': {
      if (!parsed) return compactPlainTextPayload(rawContent, 'results');
      const query = parsed.query as string | undefined;
      const error = parsed.error as string | undefined;
      const results = Array.isArray(parsed.results)
        ? (parsed.results as Array<Record<string, unknown>>)
        : [];
      const compacted = results.slice(0, 8).map(r => ({
        title: r.title ?? '',
        snippet: String(r.snippet ?? '').slice(0, 200),
        url: r.url ?? '',
      }));
      return JSON.stringify({
        query,
        error,
        result_count: parsed.resultCount ?? results.length,
        results: compacted,
        _compacted: true,
        _note: results.length > 8
          ? `共 ${results.length} 条结果，保留前 8 条。`
          : undefined,
      });
    }

    case 'bash':
    case 'execute_command': {
      if (!parsed) return compactPlainTextPayload(rawContent, 'output');
      // bash Effect 工具：{ exit, output, truncated }；旧 execute_command：stdout/stderr
      const output = String(parsed.output ?? parsed.stdout ?? '');
      const stderr = String(parsed.stderr ?? '');
      const exitCode = parsed.exit ?? parsed.exitCode ?? parsed.exit_code;
      const command = parsed.command as string | undefined;
      const args = parsed.args as string[] | undefined;
      const cmdStr = command
        ? `${command}${args?.length ? ` ${args.join(' ')}` : ''}`
        : undefined;
      if (output.length + stderr.length < TEXT_COMPACT_MIN) {
        // 已经较短的 JSON 结果无需再压
        return null;
      }
      return JSON.stringify({
        command: cmdStr,
        exit_code: exitCode,
        output_tail: output.slice(-500),
        stderr_tail: stderr.slice(-500),
        truncated: parsed.truncated === true,
        timeout: parsed.timeout === true,
        char_count: output.length + stderr.length,
        _compacted: true,
        _note: `output ${output.length} 字符，stderr ${stderr.length} 字符，保留末尾 500 字符。`,
      });
    }

    case 'read': {
      if (!parsed) return compactPlainTextPayload(rawContent, 'content');
      // Effect read 可能是 full-text / text-page 结构，或 formatUnknown 后的包装
      const content = String(
        parsed.content
        ?? (typeof parsed.text === 'string' ? parsed.text : '')
        ?? '',
      );
      if (!content && typeof parsed.type === 'string') {
        // directory listing 等：压成条目预览
        const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
        if (entries.length <= 40 && rawContent.length < TEXT_COMPACT_MIN) return null;
        return JSON.stringify({
          type: parsed.type,
          entry_count: entries.length,
          entries_preview: entries.slice(0, 40).map((e) =>
            typeof e === 'string' ? e : String((e as { path?: string }).path ?? e).slice(0, 200),
          ),
          truncated: parsed.truncated === true,
          _compacted: true,
          _note: entries.length > 40 ? `目录条目 ${entries.length}，保留前 40` : undefined,
        });
      }
      if (content.length < TEXT_COMPACT_MIN) return null;
      return JSON.stringify({
        type: parsed.type,
        offset: parsed.offset,
        truncated: parsed.truncated === true,
        next: parsed.next,
        content_preview: content.slice(0, TEXT_COMPACT_HEAD),
        content_tail: content.slice(-TEXT_COMPACT_TAIL),
        char_count: content.length,
        _compacted: true,
        _note: `全文 ${content.length} 字符，保留头 ${TEXT_COMPACT_HEAD} + 尾 ${TEXT_COMPACT_TAIL}`,
      });
    }

    case 'glob':
    case 'list_directory': {
      if (!parsed) {
        const lines = rawContent.split('\n').filter(Boolean);
        if (lines.length <= 40 && rawContent.length < TEXT_COMPACT_MIN) return null;
        return JSON.stringify({
          entry_count: lines.length,
          entries_preview: lines.slice(0, 40),
          _compacted: true,
          _note: lines.length > 40 ? `共 ${lines.length} 条路径，保留前 40` : undefined,
        });
      }
      return compactPlainTextPayload(rawContent, 'entries');
    }

    case 'edit_lines':
    case 'replace_lines': {
      if (!parsed) return null;
      const path = parsed.path as string | undefined;
      const replaced = parsed.replaced_lines as number | undefined;
      const newCount = parsed.new_lines_count as number | undefined;
      const bytes = parsed.bytes_written as number | undefined;
      return JSON.stringify({
        path,
        replaced_lines: replaced,
        new_lines_count: newCount,
        bytes_written: bytes,
        _compacted: true,
        _note: replaced
          ? `替换 ${replaced} 行 → ${newCount} 行${bytes ? ` (${bytes} 字节)` : ''}`
          : undefined,
      });
    }

    default:
      return compactPlainTextPayload(rawContent);
  }
}

/**
 * 对 tool_result 做结构化压缩（确定性，整表重放）。
 * 保留 toolCallId 和 role，只压缩 content 字段。
 */
export function microcompactToolResults(messages: Message[]): Message[] {
  const toolCallToName = buildToolNameMap(messages);

  return messages.map((msg) => {
    if (msg.role !== 'tool' || !msg.toolCallId) return msg;

    const toolName = toolCallToName.get(msg.toolCallId);
    if (!toolName || !TOOLS_WITH_LARGE_OUTPUT.has(toolName)) return msg;

    // 已压缩过的结果保持原样，避免二次结构漂移
    if (msg.content?.includes('"_compacted":true') || msg.content?.includes('"_compacted": true')) {
      return msg;
    }

    const compacted = compactToolResult(toolName, msg.content);
    if (compacted === null) return msg;

    return { ...msg, content: compacted };
  });
}

/**
 * 零成本 cache-aware 变换：Snip + Microcompact。
 * 纯函数、对整表确定性重放；多轮仅追加新消息时，已发送前缀字节保持不变。
 */
export function applyZeroCostCompaction(messages: Message[]): Message[] {
  return microcompactToolResults(snipToolResults(messages));
}

// ---- 3. Context Collapse: LLM 消息范围摘要 ----

/**
 * 当 token 超过预算阈值时，用 LLM 对最旧的一批消息范围做语义摘要。
 * 替换为一个 system 摘要消息，保留最近 N 轮不变。
 *
 * 这会修改缓存前缀 → 返回 collapsed=true。
 */
async function contextCollapse(
  messages: Message[],
  tokenBudget: number,
): Promise<{ messages: Message[]; finalTokens: number }> {
  const originalTokens = totalTokens(messages);

  if (originalTokens <= tokenBudget * config.agent.compactThreshold) {
    return { messages, finalTokens: originalTokens };
  }

  // 找到活跃窗口边界（保留最近 compactKeepRecentTurns 轮次的 user 消息及其后全部消息）
  const keepRecent = config.agent.compactKeepRecentTurns;
  let recentBoundary = messages.length;
  let userCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') userCount++;
    if (userCount >= keepRecent) {
      recentBoundary = i;
      break;
    }
  }

  // 收集可压缩的旧消息范围 [0..recentBoundary)
  // 跳过最前面的 system 消息（它们是环境/记忆/技能上下文，不应被压缩）
  let firstCompressible = 0;
  while (firstCompressible < recentBoundary && messages[firstCompressible]?.role === 'system') {
    firstCompressible++;
  }

  const compressible = messages.slice(firstCompressible, recentBoundary);
  if (compressible.length <= 3) {
    return { messages, finalTokens: originalTokens };
  }

  // 构建摘要请求：包含 user、assistant、tool 的完整轮次上下文
  const transcript = compressible
    .map(m => {
      const role = m.role === 'tool' ? 'tool_result' : m.role;
      const preview = m.content?.slice(0, 800) ?? '';
      const hasToolCalls = m.toolCalls?.length ? ` [调用了 ${m.toolCalls.length} 个工具]` : '';
      return `[${role}]${hasToolCalls}: ${preview}`;
    })
    .join('\n\n');

  if (transcript.length < 50) {
    return { messages, finalTokens: originalTokens };
  }

  const summaryText = deterministicContextSummary(transcript);

  if (!summaryText.trim() || summaryText.length < 20) {
    return { messages, finalTokens: originalTokens };
  }

  // 构建新的消息列表：system 前文 + 摘要 + 保留的活跃窗口
  const keptBefore = messages.slice(0, firstCompressible);
  const keptAfter = messages.slice(recentBoundary);

  const summaryMessage: Message = {
    id: randomUUID(),
    role: 'system',
    content: `[上下文摘要] ${summaryText.trim()}`,
    createdAt: new Date().toISOString(),
  };

  const compactedMessages = [...keptBefore, summaryMessage, ...keptAfter];
  const finalTokens = totalTokens(compactedMessages);

  return { messages: compactedMessages, finalTokens };
}

function deterministicContextSummary(transcript: string): string {
  const normalized = transcript
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
  return normalized.length > 1800 ? `${normalized.slice(0, 1800)}\n[摘要已截断]` : normalized;
}

// ---- 公共入口 ----

/**
 * 三层上下文压缩管线：
 *   Snip → Microcompact → Collapse（仅在超预算时）
 *
 * cache-aware：
 *   - Snip/Microcompact 整表确定性重放（见 applyZeroCostCompaction）
 *   - `cachedUpTo` 仅保留 API 兼容；零成本层不再用它跳过前缀（跳过会导致原文回灌）
 *   - Context Collapse 执行时返回 collapsed=true，调用方应重置缓存边界为 0
 */
export async function compactContext(
  messages: Message[],
  cachedUpTo: number,
  tokenBudget?: number,
): Promise<CompactContextResult> {
  void cachedUpTo; // 兼容旧调用方；零成本层改为整表重放
  const budget = tokenBudget ?? config.agent.contextTokenBudget;
  const originalTokens = totalTokens(messages);

  // Step 1–2: Snip + Microcompact — 整表确定性重放
  const afterSnip = snipToolResults(messages);
  const snippedCount = messages.length - afterSnip.length;
  const afterMc = microcompactToolResults(afterSnip);

  // 计算被 microcompact 的条数（按 toolCallId 对齐原文）
  let microCount = 0;
  const originalByToolId = new Map(
    messages.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => [m.toolCallId!, m.content]),
  );
  for (const msg of afterMc) {
    if (msg.role !== 'tool' || !msg.toolCallId) continue;
    const original = originalByToolId.get(msg.toolCallId);
    if (original !== undefined && original !== msg.content) microCount++;
  }

  // Step 3: 检查是否需要 LLM Collapse
  const afterTokens = totalTokens(afterMc);

  if (afterTokens <= budget * config.agent.compactThreshold) {
    return {
      messages: afterMc,
      collapsed: false,
      stats: {
        snipped: snippedCount,
        microcompacted: microCount,
        cachedPrefixPreserved: true,
        savedTokens: originalTokens - afterTokens,
        originalTokens,
        finalTokens: afterTokens,
      },
    };
  }

  // Step 4: Context Collapse — LLM 语义摘要旧消息
  const collapsed = await contextCollapse(afterMc, budget);

  return {
    messages: collapsed.messages,
    collapsed: true,
    stats: {
      snipped: snippedCount,
      microcompacted: microCount,
      cachedPrefixPreserved: false,
      savedTokens: originalTokens - collapsed.finalTokens,
      originalTokens,
      finalTokens: collapsed.finalTokens,
    },
  };
}

// ---- Token 估算（保留，供 loop 使用）----

/**
 * 轻量 token 估算（不依赖 tiktoken）。
 * CJK 字符 ~1.5 token，拉丁/其他 ~0.25 token。
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x20000 && code <= 0x2a6df) ||
      (code >= 0xf900 && code <= 0xfaff)
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
 * 稳定环境上下文（无墙钟）：平台、工作区、项目。
 * 属于 system prompt 的 cacheable 前缀，单次任务 run 内应字节不变。
 */
export function buildStableWorkspaceContextMessage(
  workspaceDir: string,
  configDir?: string,
  projectInfo?: { name: string; path: string },
): Message {
  const lines: string[] = [];
  lines.push('<system_context>');
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
    createdAt: new Date().toISOString(),
  };
}

/**
 * 墙钟时间上下文（分钟精度）。
 * 主循环在 **run 开始时写入 system 一次并 pin**，本 run 内不再更新；
 * 切勿每轮重建，否则会从时间字段起冲掉整段对话 prompt cache。
 */
export function buildVolatileTimeContextMessage(now: Date = new Date()): Message {
  const timeStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  // 分钟精度：秒级时间戳会让 volatile 后缀每秒都变
  const stableTimestamp = now.toISOString().replace(/:\d{2}\.\d{3}Z$/, ':00Z');

  return {
    id: randomUUID(),
    role: 'system',
    content: [
      '<system_time>',
      `Current time: ${stableTimestamp}`,
      `Today: ${timeStr}`,
      '</system_time>',
    ].join('\n'),
    createdAt: now.toISOString(),
  };
}

/**
 * 构建环境上下文系统消息（兼容入口）。
 *
 * 顺序：稳定环境事实在前，墙钟时间在后——即使合在一条消息里，时间变化也只影响尾部。
 */
export function buildSystemContextMessage(
  workspaceDir: string,
  configDir?: string,
  projectInfo?: { name: string; path: string },
  now: Date = new Date(),
): Message {
  const stable = buildStableWorkspaceContextMessage(workspaceDir, configDir, projectInfo);
  const time = buildVolatileTimeContextMessage(now);
  // 拆掉各自的外层标签，合成一条 <system_context>…</system_context>
  const stableBody = stable.content
    .replace(/^<system_context>\n?/, '')
    .replace(/\n?<\/system_context>$/, '');
  const timeBody = time.content
    .replace(/^<system_time>\n?/, '')
    .replace(/\n?<\/system_time>$/, '');

  return {
    id: randomUUID(),
    role: 'system',
    content: ['<system_context>', stableBody, '', timeBody, '</system_context>'].join('\n'),
    createdAt: now.toISOString(),
  };
}

/**
 * 单次任务 run 内应冻结的 system 前缀部件（无时间、无附件）。
 * 顺序：identity → protocol → skills → workspace，最大化可缓存公共前缀。
 */
export function buildStableSystemPromptParts(options: {
  workspaceDir: string;
  configDir?: string;
  projectInfo?: { name: string; path: string };
}): string[] {
  return [
    buildAgentIdentityMessage().content,
    buildToolGuidanceMessage().content,
    buildSkillCatalogMessage()?.content,
    buildStableWorkspaceContextMessage(
      options.workspaceDir,
      options.configDir,
      options.projectInfo,
    ).content,
  ].filter((part): part is string => typeof part === 'string' && part.length > 0);
}

/**
 * 仅用于测试/兼容：时间（与可选附件）作为 system 后缀。
 * 生产路径应 pin 完整 system（见 pi-harness buildPiSystemPrompt），附件挂在 user 消息。
 */
export function buildVolatileSystemPromptParts(options: {
  now?: Date;
  attachmentContent?: string | null;
}): string[] {
  const parts: string[] = [buildVolatileTimeContextMessage(options.now).content];
  if (options.attachmentContent?.trim()) {
    parts.push(options.attachmentContent);
  }
  return parts;
}

/** 拼接 system prompt：稳定前缀 + 易变后缀。 */
export function joinSystemPromptParts(stableParts: string[], volatileParts: string[] = []): string {
  return [...stableParts, ...volatileParts].filter(Boolean).join('\n\n');
}

/**
 * 主 Agent 身份与产品契约（system prompt 前缀，尽量稳定以利 prompt cache）。
 */
export function buildAgentIdentityMessage(): Message {
  const content = [
    'You are Aurevoy, a personal AI agent desktop runtime.',
    'You plan, call tools, and keep working until the user goal is done or blocked.',
    '',
    'Hard rules:',
    '- Prefer real tool results over speculation. Never claim work is done without evidence from tools or prior verified context.',
    '- Stay inside the workspace sandbox unless the user explicitly granted external paths.',
    '- When something fails, report the concrete error and what you already verified; do not invent success.',
    '- Keep final answers concise. Deliver large outputs via files + attach_content, not wall-of-text dumps.',
  ].join('\n');

  return {
    id: randomUUID(),
    role: 'system',
    content,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 主 Agent 操作协议：对齐真实工具面，覆盖读写、交付、多代理与 skill。
 *
 * 始终注入，放在环境上下文之后。
 */
export function buildToolGuidanceMessage(): Message {
  const roleCatalog = formatSubagentRoleCatalogForTool();
  const content = [
    '<operating_protocol>',
    '',
    '## Core loop',
    '1. Understand the goal; inspect the workspace before changing it.',
    '2. Use the smallest sufficient tool path; verify results.',
    '3. Deliver to the user with the right channel (text / attach_content).',
    '4. Stop when done or clearly blocked; ask_user only when a decision is truly missing.',
    '',
    '## Workspace tools',
    '- Discover: `glob`, `grep`, `list_directory`, then `read` the few files that matter.',
    '- Create new files: `write` (omit mode, or mode=create). Existing paths require explicit mode=overwrite (full replace) or mode=append.',
    '- Local edit (preferred for revisions): `edit` with unique exact oldString → newString. Do not full-rewrite a report with write just to change a section.',
    '- Shell / checks: `bash` for builds, tests, diagnostics. Avoid destructive commands (rm -rf, force push, wiping data).',
    '- File ops: `copy_file`, `move_file` / `rename_file`. `delete_file` may be disabled; do not assume it works.',
    '- Do not invent obsolete tools (`open_file`, `write_file`, `edit_lines`, `session_*`, `scroll`). Use the names above.',
    '',
    '## Delivery (use these — do not only paste long content in chat)',
    '- `attach_content`: deliver a workspace file, image, or link. Use for HTML / Markdown / reports / images so the chat card + workbench preview open.',
    '  Prefer type=file_reference with a real path after writing the file.',
    '- Inline conversation UI is temporarily unavailable. For previews, dashboards, forms, or other rich content, write an HTML or Markdown file and deliver it with `attach_content`.',
    '- Research or file reports (调研/简报/评估/计划/纪要等): load `research`. Prefer quick report; use deep mode only for multi-item structured research. Default file delivery is Markdown; HTML + `bundle_report` only when the user wants a single-page/component layout. Then `attach_content`.',
    '  Final chat reply = path + one-line summary (+ warnings). Do not restate the whole report.',
    '- `create_artifact` / `apply_artifact`: durable draft or file artifact when the user needs an inspectable intermediate, not as a substitute for attach_content delivery.',
    '',
    '## Multi-agent (`delegate`)',
    'Spawn specialized sub-agents for independent sub-tasks. You keep the user conversation and final answer.',
    'When to delegate:',
    '- Parallel scouting of unrelated dirs/modules, parallel research angles, or a focused coding/docs sub-task that would bloat your own context.',
    '- Independent work only: issue multiple `delegate` calls in one turn for true parallelism.',
    'When NOT to delegate:',
    '- Trivial single-file edits, one quick read, or tightly sequential steps that need your intermediate judgment each time.',
    'How:',
    '- Set `goal` (and optional detailed `prompt`), pick a `role`, optionally `tools` allowlist.',
    '- Sub-agents cannot nest further delegates; they run until done or the parent task is cancelled.',
    '- After results return, synthesize for the user; do not dump raw tool logs.',
    'Roles:',
    roleCatalog,
    '',
    '## Web, memory, skills, user input',
    '- External facts: `web_search` then `web_fetch`; cite URLs; do not invent sources.',
    '- Long-term notes: `remember` / `recall` when useful across turns.',
    '- Skills: load a catalog skill only when the task explicitly needs that skill. `research` is for research and file reports (quick or deep; Markdown default, HTML optional).',
    '- Ambiguity that blocks progress: `ask_user` with few concrete questions; otherwise decide and proceed.',
    '',
    '## Honesty & safety',
    '- Tool failure is not success. Retry once with a corrected call when appropriate, then report.',
    '- Prefer minimal diffs: use `edit` on existing files. Full `write` overwrite only when the whole document must change and you pass mode=overwrite.',
    '- Never claim HTML/UI was shown unless you actually called attach_content (or the user already sees the file via other verified means).',
    '</operating_protocol>',
  ].join('\n');

  return {
    id: randomUUID(),
    role: 'system',
    content,
    createdAt: new Date().toISOString(),
  };
}
