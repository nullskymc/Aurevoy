# Agent 重构设计 —— 以 Claude Code 为蓝本 ✅ 全部完成

> 本文档是 [上一轮分析结论](./AGENT_REFACTOR_DESIGN.md#) 的落地设计方案。
> 目标：把 Aurevoy 的 Agent 从"单层 ReAct 循环 + 正则计划 + 串行工具 + 字符截断"
> 重构为"LLM 驱动规划 → 分层执行 → 工具并行 → 语义压缩 → 相关性检索"的现代 Agent。
>
> **实施状态：7/7 Phase 全部完成，5/5 回归测试通过。**

---

## 设计原则

1. **先侦查，再动手** — Agent 必须先理解任务全貌（扫描工作区、读取相关文件），再制定执行计划。不做"看到第一个工具调用就直接执行"的盲动。
2. **并行优于串行** — 无依赖的操作（读多个文件、搜索多处）必须并行。串行的浪费就是用户的等待。
3. **出错换策略** — 工具失败不意味着任务失败。Agent 循环层必须提供替代路径（回退到另一个工具、降低要求、追问用户）。
4. **可恢复的失败** — 任务崩溃后用户能一眼看到原因，一键恢复，不需要理解内部状态。
5. **类型化思考** — 提示、计划、检查点都应该是结构化的，不是裸字符串拼接。

---

## Phase 1: LLM 驱动的任务规划 + 侦查阶段

### 现状问题

[`loop.ts:1015-1038`](../apps/agent/src/agent/loop.ts#L1015) 用正则匹配关键词生成计划：

```typescript
if (/(整理|总结|summary|report|材料|资料|文件|docs?|markdown|md|todo|搜索|search)/i.test(goal)) {
  steps.push('扫描工作区材料');
}
```

缺陷：
- "搜索功能的 bug" 匹配到 `search` → 生成"扫描工作区材料"——完全错误的计划
- 正则无法理解任务语义、无法区分目标之间的细微差异
- 计划质量和目标长度无关，永远返回固定模板

### 设计方案

**用 LLM 生成结构化计划，同时增加一个"侦查阶段"。**

```
用户输入 → 侦查阶段(scout) → 计划生成(plan) → 执行阶段(execute) → 汇总(summarize)
```

#### 1.1 侦查阶段（Scout Phase）

在计划生成前，Agent 先做一次快速的"侦查"——读工作区结构、定位关键文件，但不做任何写入：

```
[system] 你正在侦查工作区以制定计划。
         可用工具：list_directory, read_file(search only), search_files。
         不要修改任何文件，只收集信息。

[user] 目标：{goal}
       工作区概览：{quick_list_directory_output}
       请列出你需要先查看哪些文件/目录来理解任务全貌。
```

侦查阶段限制：
- 最多 3 轮 LLM 调用（防止无限侦查）
- 只能使用 `safe` 工具（list_directory、read_file、search_files）
- 不经过审批门（全是只读安全工具）
- 产出 `ScoutReport`：关键文件列表、技术栈判断、潜在边界条件

#### 1.2 LLM 生成计划

```
[system] 你是一个任务规划器。基于侦查报告，将用户目标分解为 2-8 个有序执行步骤。
         每个步骤描述一个独立、可验证的里程碑。输出 JSON。

[user] 目标：{goal}
       侦查报告：{scoutReport}
```

LLM 输出结构化计划：

```typescript
interface GeneratedPlan {
  steps: Array<{
    description: string;        // 人类可读的步骤描述
    toolsExpected: string[];    // 该步骤预期使用的工具
    verifiable: boolean;        // 是否有可验证的产出物
    dependsOn: string[];        // 依赖的前置步骤 ID
  }>;
  estimatedIterations: number;  // 预估需要的 LLM 轮次
  riskLevel: 'low' | 'medium' | 'high';
}
```

#### 1.3 回退策略

LLM 规划失败（网络错误、输出非法 JSON）时，回退到当前的正则计划作为兜底——不 block 用户。

### 类型变更

```typescript
// packages/shared/src/types.ts 新增

interface ScoutReport {
  keyFiles: Array<{ path: string; reason: string }>;
  techStack?: string[];
  constraints: string[];
  summary: string;
}

interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  toolsExpected?: string[];
  dependsOn?: string[];     // 前置步骤 ID
  verifiable?: boolean;
}
```

### 验证标准

- 用"找搜索功能的 bug"（应优先搜索代码而非扫描材料）和"总结项目文档"（应优先找 Markdown 文件）两组对照目标验证 LLM 规划质量。
- LLM 规划失败时回退到正则计划。
- 侦查阶段正确被限制在 3 轮 + safe 工具 + 不审批。

---

## Phase 2: 并行工具执行

### 现状问题

[`loop.ts:846`](../apps/agent/src/agent/loop.ts#L846) 的 for 循环逐个执行 tool_calls，即使 LLM 一次返回了 3 个独立的只读操作：

```typescript
for (const tc of toolCalls) {
  // A 执行 → 等结果 → B 执行 → 等结果 → C 执行
}
```

读 3 个文件 = A 时间 + B 时间 + C 时间，而不是 max(A, B, C)。

### 设计方案

**将一次 LLM 返回的所有 tool_calls 按依赖分组并行执行。**

#### 2.1 核心逻辑

```typescript
async function executeToolCalls(
  calls: ToolCall[],
  context: ExecutionContext
): Promise<ToolResult[]> {
  // 第一遍：找出所有 safe 工具 → 并行执行
  // 第二遍：找出所有 caution/dangerous 工具 → 按审批状态处理
  
  const [safeOnes, riskyOnes] = partition(calls, c => 
    toolRegistry.riskLevelOf(c.toolName) === 'safe'
  );
  
  // safe 工具全并行，每个有独立超时
  const safeResults = await Promise.all(
    safeOnes.map(call => executeWithTimeout(call, context, TOOL_TIMEOUT_MS))
  );
  
  // risky 工具：需审批的排队、不需审批的并行
  const riskyResults = await executeRiskyTools(riskyOnes, context);
  
  return interleave(safeResults, riskyResults, calls);
}
```

#### 2.2 超时单杀

每个工具调用包装独立超时，一个 hung 掉不影响其他：

```typescript
async function executeWithTimeout(
  call: ToolCall,
  context: ExecutionContext,
  timeoutMs: number
): Promise<ToolResult> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = context.abortSignal 
    ? AbortSignal.any([context.abortSignal, timeout])
    : timeout;
    
  try {
    return await toolRegistry.invoke(call, { ...context, abortSignal: signal });
  } catch (err) {
    if ((err as Error).name === 'TimeoutError') {
      return {
        callId: call.id,
        ok: false,
        error: `工具 ${call.toolName} 执行超时 (${timeoutMs}ms)，请改用其他方式。`,
      };
    }
    throw err;
  }
}
```

#### 2.3 依赖声明（为 Phase 4 做准备）

工具可以在 descriptor 中声明依赖：

```typescript
interface ToolDescriptor {
  // ... 现有字段
  /** 并行执行策略 */
  executionPolicy?: {
    /** 是否可以和其他 safe 工具并行（默认 true） */
    parallelizable: boolean;
    /** 工具调用之间的依赖（同一轮内该工具必须等哪些其他工具完成） */
    waitsFor?: string[];
  };
}
```

当前 Phase 只实现 `parallelizable: false` 的情况（如 write_file 必须在所有 read_file 之后）。

### 审批流适配

并行执行时审批仍然一对一：
- risky tools 的审批请求同时发出，各自独立等待
- 审批通过的立即执行，拒绝的标记为 skipped
- 审批超时的逐一降级为拒绝

### 验证标准

- 3 个 safe 工具同时调用 → 总耗时接近 max(各自耗时)，不是 sum。
- 1 个工具超时 → 其余工具正常完成，超时的返回可解释错误。
- risky 工具审批拒绝 → 该工具返回拒绝结果，其余正常执行。

---

## Phase 3: 工具结果流式 + 大小截断

### 现状问题

1. 工具结果只有两种状态：pending（等待中）或 done（完成）。执行一个大文件读取时，前端只能干等。
2. [`loop.ts:964`](../apps/agent/src/agent/loop.ts#L964) 工具结果原封不动塞进下一个 LLM 请求，大文件直接撑爆上下文。

### 设计方案

#### 3.1 工具结果大小截断（在 registry.invoke 层做）

```typescript
const MAX_TOOL_OUTPUT_CHARS = 50000;  // ~12K tokens，给上下文留足空间

function truncateToolOutput(output: unknown): { result: unknown; truncated: boolean } {
  const text = typeof output === 'string' 
    ? output 
    : JSON.stringify(output ?? null);
  
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) {
    return { result: output, truncated: false };
  }
  
  return {
    result: {
      _truncated: true,
      _originalChars: text.length,
      _preview: text.slice(0, MAX_TOOL_OUTPUT_CHARS),
      _note: `输出被截断（${text.length} → ${MAX_TOOL_OUTPUT_CHARS} 字符）。如需完整内容，请用 offset/limit 分片重读。`,
    },
    truncated: true,
  };
}
```

#### 3.2 流式工具结果（可选，长命令执行时用）

对于 `execute_command`，可以通过 SSE 推送 stdout 流式增量到前端：

```typescript
// events.ts 新增事件
interface ToolOutputChunkEvent {
  type: 'tool_output_chunk';
  taskId: string;
  callId: string;
  delta: string;  // 增量文本
}
```

当前 Phase 先不做流式（复杂度高），只做截断。

### 验证标准

- 读一个 2MB 文件 → 工具结果被截断到 50000 字符以内，带 `_truncated: true` 标记。
- LLM 收到的 tool result 不超过截断大小，上下文不会爆。

---

## Phase 4: 上下文管理 —— Token 感知 + 自动压缩

### 现状问题

[`context.ts:64-70`](../apps/agent/src/agent/context.ts#L64) 的压缩是纯字符截断：

```typescript
function compressContent(content: string, cap: number): string {
  if (!content || content.length <= cap) return content;
  const kept = content.slice(0, cap);
  return `${kept}\n…[此处省略 ${folded} 个字符]`;
}
```

问题：
- **字符预算 ≠ token 预算。** 中文一个字符 = 1-2 token，英文一个字符 ≈ 0.25 token。用字符做预算，对中文任务不公平。
- **截断不是语义压缩。** 丢失的是尾部信息，不一定是"不重要"的信息。
- **自动压缩不会自动触发。** [`loop.ts:326`](../apps/agent/src/agent/loop.ts#L326) 的 `compactTask` 是手动 API，Agent 循环内从不自动调用。

### 设计方案

#### 4.1 Token 计数替代字符计数

不依赖 tiktoken（太重），用轻量估算：

```typescript
function estimateTokens(text: string): number {
  // 粗略估算：英文 ~4char/token，中文 ~1.5char/token
  // 取平均：~3char/token，略保守
  let tokens = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // CJK 统一表意文字（粗略范围）
    if ((code >= 0x4E00 && code <= 0x9FFF) ||
        (code >= 0x3400 && code <= 0x4DBF) ||
        (code >= 0x20000 && code <= 0x2A6DF) ||
        (code >= 0xF900 && code <= 0xFAFF)) {
      tokens += 1.5;  // CJK 字符 ~1.5 tokens
    } else {
      tokens += 0.25; // 拉丁/其他 ~0.25 tokens
    }
  }
  return Math.ceil(tokens);
}
```

配置开关从 `AUREVOY_CONTEXT_CHAR_BUDGET` 改为 `AUREVOY_CONTEXT_TOKEN_BUDGET`（默认 128000），兼容旧配置。

#### 4.2 自动语义压缩

当上下文 token 预算超过阈值时，不截断——调用 LLM 做语义摘要：

```typescript
// context.ts
async function autoCompactIfNeeded(
  messages: Message[],
  tokenBudget: number
): Promise<ContextWindowResult> {
  const estimatedTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content ?? ''), 0);
  
  if (estimatedTokens <= tokenBudget * 0.85) {
    // 没超过 85% 阈值，不做压缩
    return { messages, compressed: false, ... };
  }
  
  // 找最早的可压缩段：跳过所有 user 消息和最近 N 轮
  const compressTargets = findCompressible(messages);
  if (compressTargets.length <= 2) return { messages, compressed: false, ... };
  
  const summary = await generateSummary(compressTargets);
  const compacted = replaceWithSummary(messages, compressTargets, summary);
  
  return { messages: compacted, compressed: true, ... };
}
```

关键逻辑：
- 压缩目标：跳过 user 消息（用户约束不可变），跳过最近 5 轮（活跃上下文），跳过 tool 消息（保留配对契约）
- 压缩结果是一条 `role: 'system'` 摘要消息，替换被压缩段
- 轨迹中记录压缩决策（哪些消息被压缩、摘要内容、压缩前后 token 数）

#### 4.3 Agent 循环内自动触发

在 `runTask()` 的每轮开始前、`buildContextWindow` 之后：

```typescript
// loop.ts: runTask 主循环内
const ctx = await autoCompactIfNeeded(messages, config.agent.contextTokenBudget);
if (ctx.compressed) {
  writeTrace(task.id, 'compact', 'thinking', {
    ok: true,
    summary: `自动压缩 ${ctx.compressedGroupCount} 组消息，释放 ~${ctx.savedTokens} tokens`,
  });
}
```

### 验证标准

- 对话超过 token 预算 85% → 自动触发 LLM 压缩，不丢失用户约束。
- 中英文混合消息的 token 估算误差不超过实际值的 ±30%。
- 压缩后 LLM 仍能正确回答基于早期对话的问题。

---

## Phase 5: Memory 重构 —— 相关性检索 + 关联引用 + 自动去重

### 现状问题

1. [`db.ts:458`](../apps/agent/src/store/db.ts#L458) 按 `updated_at ASC` 排序——最旧最无关的记忆排最前。
2. [`context.ts:149`](../apps/agent/src/agent/context.ts#L149) 所有启用记忆一视同仁，无相关性过滤。
3. 50 条硬上限，超出静默丢弃。
4. 无关联引用：记忆是扁平列表，无法形成知识图谱。
5. 无去重：Agent 可能对同一事实重复 remember。

### 设计方案

#### 5.1 相关性评分（轻量，不引入向量）

在注入记忆前，用目标文本对所有启用记忆做简单的相关性评分：

```typescript
interface ScoredMemory {
  entry: MemoryEntry;
  score: number;  // 0-1
}

function scoreMemories(
  memories: MemoryEntry[],
  goal: string,
  recentTopics: string[]  // 最近 N 轮对话中提取的关键词
): ScoredMemory[] {
  return memories.map(m => {
    let score = 0;
    const content = m.content.toLowerCase();
    const goalLower = goal.toLowerCase();
    
    // 1. 关键词命中（目标 + 最近话题）
    const goalWords = extractKeywords(goalLower);
    const topicWords = recentTopics.flatMap(t => extractKeywords(t));
    const allRelevant = new Set([...goalWords, ...topicWords]);
    
    for (const word of allRelevant) {
      if (word.length < 2) continue;
      if (content.includes(word)) score += 0.15;
    }
    
    // 2. Category 匹配（directory 类记忆在涉及文件操作时加权）
    if (m.category === 'directory' && /文件|目录|路径|file|dir|path/i.test(goalLower)) {
      score += 0.2;
    }
    if (m.category === 'model' && /模型|model|provider|llm/i.test(goalLower)) {
      score += 0.2;
    }
    
    // 3. 置信度加权
    score *= (0.5 + m.confidence * 0.5);
    
    // 4. 时间衰减（每 30 天衰减一半）
    const ageDays = (Date.now() - new Date(m.updatedAt).getTime()) / (1000 * 86400);
    score *= Math.pow(0.5, ageDays / 30);
    
    return { entry: m, score: Math.min(1, score) };
  });
}
```

注入时按 score 降序排列，只取前 N 条并标注截断：

```typescript
export function buildMemorySystemMessage(
  memories: MemoryEntry[],
  goal: string,
  recentTopics: string[],
  maxMemories: number = 20
): { message: Message | null; truncated: number } {
  const scored = scoreMemories(memories.filter(m => m.enabled), goal, recentTopics)
    .filter(s => s.score > 0.05)  // 最低相关性阈值
    .sort((a, b) => b.score - a.score);
  
  const selected = scored.slice(0, maxMemories);
  const truncated = scored.length - selected.length;
  
  if (selected.length === 0) return { message: null, truncated: 0 };
  
  const lines = selected.map(s =>
    `- (${CATEGORY_LABEL[s.entry.category]}) ${s.entry.content}`
  );
  
  let content = '[关于用户的长期记忆]\n' + lines.join('\n');
  if (truncated > 0) {
    content += `\n\n（还有 ${truncated} 条相关度较低的记忆未列出）`;
  }
  
  return { message: { id: randomUUID(), role: 'system', content, createdAt: ... }, truncated };
}
```

#### 5.2 记忆关联引用（`[[link]]`）

允许记忆之间通过 `[[link]]` 互相引用：

```typescript
// 存储格式：content 中可以包含 [[memory-name]] 引用
// 例如："用户偏好使用 Python [[prefer-fastapi]] ，项目使用 FastAPI 框架"

function parseMemoryLinks(content: string): string[] {
  const matches = content.matchAll(/\[\[([a-z0-9-]+)\]\]/gi);
  return [...matches].map(m => m[1].toLowerCase());
}

// 注入时解析引用，把关联记忆也拉入上下文（但放在 "相关" 区）
function expandLinkedMemories(
  selected: ScoredMemory[],
  allMemories: Map<string, MemoryEntry>
): ScoredMemory[] {
  const expanded = new Map<string, ScoredMemory>();
  for (const s of selected) expanded.set(s.entry.id, s);
  
  for (const s of selected) {
    const links = parseMemoryLinks(s.entry.content);
    for (const linkName of links) {
      // 按 name slug 查找关联记忆
      const linked = findMemoryByNameSlug(allMemories, linkName);
      if (linked && !expanded.has(linked.id)) {
        expanded.set(linked.id, { entry: linked, score: s.score * 0.5 });
      }
    }
  }
  
  return [...expanded.values()].sort((a, b) => b.score - a.score);
}
```

#### 5.3 自动去重

`remember` 工具写入前检查相似内容：

```typescript
function findDuplicate(
  newContent: string,
  existingMemories: MemoryEntry[]
): MemoryEntry | null {
  for (const existing of existingMemories) {
    const similarity = jaccardSimilarity(
      extractKeywords(newContent.toLowerCase()),
      extractKeywords(existing.content.toLowerCase())
    );
    if (similarity > 0.7) return existing;
  }
  return null;
}

// 在 remember 工具的 execute 中：
const dup = findDuplicate(content, memoryStore.listAll());
if (dup) {
  // 更新已有记忆而非创建新的
  memoryStore.update({ ...dup, content, confidence, updatedAt: now });
  return { stored: true, id: dup.id, updated: true, note: '已更新已有记忆' };
}
```

#### 5.4 记忆元信息增强

每条记忆新增字段：

```typescript
interface MemoryEntry {
  // ... 现有字段
  /** URL slug，用于 [[link]] 引用 */
  nameSlug?: string;
  /** 为什么记录这条记忆 */
  why?: string;
  /** 什么情况下应该使用这条记忆 */
  howToApply?: string;
  /** 关联的记忆 ID 列表 */
  linkedMemoryIds?: string[];
  /** 更新历史 */
  revisionHistory?: Array<{
    content: string;
    updatedAt: string;
    reason: string;
  }>;
}
```

### 验证标准

- 与目标无关的记忆不注入上下文。"帮我写 Python 脚本"时不会注入"用户喜欢深色主题"。
- `[[link]]` 引用的记忆在注入时被拉入。
- 重复写入相似内容 → 更新已有记忆而非创建重复。
- 记忆面板显示"Why"和"How to apply"字段（可选但可见）。

---

## Phase 6: 工具系统增强 —— 多策略回退 + Diff 编辑 + 文件快照

### 6.1 错误时自动换策略

当前工具失败 → 错误信息回灌给 LLM → LLM 自己想替代方案。但 Loop 层不提供任何帮助。

增强：registry 层增加"回退建议"：

```typescript
interface ToolDescriptor {
  // ... 现有字段
  /** 失败时给 LLM 的回退建议（替代工具或替代参数） */
  fallback?: {
    tools?: string[];       // 推荐的替代工具
    message?: string;       // 给 LLM 的具体建议
  };
}
```

例如 `grep` 匹配为空时：
```typescript
fallback: {
  tools: ['list_directory', 'search_files'],
  message: 'grep 未找到匹配。尝试扩大搜索范围（用 search_files 不带 glob），或列出目录手动寻找。'
}
```

Loop 层在工具失败时，把 `fallback` 信息附加到 tool result 中：

```typescript
const result = await toolRegistry.invoke(call, context);
const enrichedResult = {
  ...result,
  fallback: !result.ok ? toolRegistry.fallbackFor(call.toolName) : undefined,
};
messages.push(makeToolResult(tc.id, enrichedResult));
```

### 6.2 Diff 编辑（`edit_file` 替代全量 `write_file`）

> 这是 Claude Code 编辑模式的核心：不是写整个文件，而是精确替换。

```typescript
toolRegistry.register({
  descriptor: {
    name: 'edit_file',
    description: '在工作区内精确替换文件中的一段文本。匹配必须唯一，否则报错。' +
      '这是推荐的编辑方式——比 write_file 更精确，且不丢失文件其他部分。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldString: { type: 'string', description: '要替换的文本（在文件中必须唯一）' },
        newString: { type: 'string', description: '替换后的文本' },
        replaceAll: { type: 'boolean', description: '是否替换所有匹配（默认 false）' },
      },
      required: ['path', 'oldString', 'newString'],
    },
    riskLevel: 'dangerous',
  },
  async execute(args, context) {
    const root = rootFromContext(context);
    const file = resolveInWorkspace(args.path, root);
    await assertRealPathInside(file, root);
    
    const content = await fs.readFile(file, 'utf8');
    const oldStr = String(args.oldString);
    const newStr = String(args.newString);
    
    if (oldStr === newStr) throw new Error('oldString 和 newString 相同');
    
    const occurrences = countOccurrences(content, oldStr);
    if (occurrences === 0) {
      throw new Error(`未找到要替换的文本。oldString 必须与文件内容完全匹配（含缩进）。`);
    }
    if (occurrences > 1 && !args.replaceAll) {
      throw new Error(
        `找到 ${occurrences} 处匹配，但 replaceAll 为 false。` +
        `请扩展 oldString 使其唯一，或设置 replaceAll=true。`
      );
    }
    
    const newContent = args.replaceAll
      ? content.replaceAll(oldStr, newStr)
      : content.replace(oldStr, newStr);
    
    await fs.writeFile(file, newContent, 'utf8');
    
    return {
      path: relative(root, file),
      replaced: occurrences,
      bytesBefore: Buffer.byteLength(content),
      bytesAfter: Buffer.byteLength(newContent),
    };
  },
});
```

### 6.3 Checkpoint 文件快照（为 Rewind 提供文件回滚能力）

当前的 Rewind 只截断对话，不回滚文件。"revert 但不回滚文件"在语义上是不完整的。

```typescript
// 在 runTask 中，写文件工具执行前自动创建快照
async function captureFileSnapshot(filePath: string, taskId: string): Promise<string> {
  const snapshotDir = join(config.dataDir, 'snapshots', taskId);
  await fs.mkdir(snapshotDir, { recursive: true });
  
  const snapshotId = randomUUID();
  const snapshotPath = join(snapshotDir, snapshotId);
  
  try {
    await fs.copyFile(filePath, snapshotPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // 文件不存在（即将创建），记录空快照
      await fs.writeFile(snapshotPath, '', 'utf8');
    } else {
      throw err;
    }
  }
  
  return snapshotId;
}

// 在 handleToolSideEffects 中拦截写入类工具，执行前快照
function handleToolSideEffects(task: Task, call: ToolCall, result: ToolResult): ToolResult {
  // ... 现有逻辑
  
  // 写入类工具：记录快照
  if (WRITE_TOOLS.has(call.toolName) && result.ok) {
    const path = resolveInWorkspace(call.args.path, taskWorkspace);
    captureFileSnapshot(path, task.id).then(snapshotId => {
      task.fileSnapshots = [...(task.fileSnapshots ?? []), {
        id: snapshotId,
        path: relative(taskWorkspace, path),
        callId: call.id,
        createdAt: new Date().toISOString(),
      }];
    });
  }
  
  return result;
}
```

Revert 时使用快照回滚文件：

```typescript
export async function revertTaskWithFiles(
  task: Task,
  messageId: string,
  mode: RevertMode = 'code_and_conv',
): Promise<RevertResult> {
  const result = revertTask(task, messageId, mode);
  
  if (mode === 'code_and_conv') {
    // 回滚文件：找到截断点之后的写入快照，恢复文件
    const removedCallIds = new Set(
      result.archivedMessages
        .flatMap(m => m.toolCalls ?? [])
        .map(tc => tc.id)
    );
    
    const snapshotsToRestore = (task.fileSnapshots ?? [])
      .filter(s => removedCallIds.has(s.callId));
    
    for (const snapshot of snapshotsToRestore) {
      const snapshotPath = join(config.dataDir, 'snapshots', task.id, snapshot.id);
      try {
        await fs.copyFile(snapshotPath, resolve(taskWorkspace, snapshot.path));
      } catch { /* snapshot 可能已被清理 */ }
    }
  }
  
  return result;
}
```

### 验证标准

- `edit_file` 可精确替换文件中的一段代码，不丢失文件其余部分。
- 重复 oldString → 报错提示需要 `replaceAll`。
- Rewind + `code_and_conv` 模式时，文件恢复到截断前的状态。

---

## Phase 7: 子代理 / 分包执行

### 现状问题

当前 Agent 是单线程执行——一次只能做一个 task。无法做到：
- "同时查 A、B、C 三个目录下的错误日志"
- "先搜索所有引用，再并发修改 5 个文件"
- "一个代理读代码，另一个查文档，结果汇总"

### 设计方案

#### 7.1 Agent Tool（子代理）

新增内置工具 `delegate_task`，允许 Agent 主循环派生子代理执行独立子任务：

```typescript
toolRegistry.register({
  descriptor: {
    name: 'delegate_task',
    description: '将独立子任务委托给另一个 Agent 执行。适用于：' +
      '同时搜索多个目录、并发读取多个文件、独立子分析。' +
      '子代理无权写入文件，只有只读权限。',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '子任务的简要目标' },
        prompt: { type: 'string', description: '给子代理的详细指令' },
        tools: { type: 'array', items: { type: 'string' }, description: '允许子代理使用的工具（默认只有 safe 只读工具）' },
      },
      required: ['goal', 'prompt'],
    },
    riskLevel: 'safe',  // 子代理默认只读
  },
  async execute(args, context) {
    // 创建一个子任务，使用简化的 Agent 循环
    const subTask = createSubTask({
      goal: String(args.goal),
      prompt: String(args.prompt),
      allowedTools: Array.isArray(args.tools) ? args.tools : DEFAULT_READONLY_TOOLS,
      parentTaskId: context?.taskId,
      workspaceDir: context?.workspaceDir,
    });
    
    const result = await runSubTask(subTask);
    
    return {
      subTaskId: subTask.id,
      content: result.summary,
      toolCalls: result.toolCallCount,
      iterations: result.iterations,
    };
  },
});
```

#### 7.2 子代理约束

- 只能使用 `safe` 工具（默认），除非 Agent 显式授权
- 最大轮次：5（防止子代理失控）
- 不写 memory（子代理的上下文是临时的）
- 结果大小截断到 20KB
- 超时：60 秒总超时
- 进程内执行，不创建新进程

#### 7.3 并行子代理

Agent 主循环一次可以发起多个 `delegate_task` 调用——因为 Phase 2 已经支持并行工具执行，子代理自然并行。

```
主 Agent: "同时查 api/、frontend/、desktop/ 三个目录下的错误处理模式"
  → delegate_task("查 api/ 目录") ─┐
  → delegate_task("查 frontend/") ─┼─ 并行执行
  → delegate_task("查 desktop/") ─┘
  → 汇总结果 → 继续推理
```

### 验证标准

- 3 个子代理并行执行 → 总耗时接近 max(各自耗时)。
- 子代理无法写入文件（安全约束）。
- 子代理结果正确截断并注入主对话。

---

## 实施路线图

| Phase | 内容 | 改动量 | 优先级 | 依赖 | 状态 |
|-------|------|--------|--------|------|------|
| **P1** | LLM 规划 + 侦查阶段 | loop.ts, context.ts, shared types | P0 | 无 | ✅ |
| **P2** | 并行工具执行 + 超时单杀 | loop.ts, registry.ts | P0 | 无 | ✅ |
| **P3** | 工具结果截断 | registry.ts, config.ts | P1 | 无 | ✅ |
| **P4** | Token 感知 + 自动语义压缩 | context.ts, loop.ts, config.ts | P1 | P1 | ✅ |
| **P5** | Memory 相关性 + 关联引用 + 去重 | context.ts, db.ts, builtins.ts, shared types | P1 | 无 | ✅ |
| **P6** | 工具回退策略 + Diff 编辑 + 文件快照 | builtins.ts, registry.ts, loop.ts, shared types | P2 | P2 | ✅ |
| **P7** | 子代理 delegate_task | subagent.ts, builtins.ts | P2 | P2, P6 | ✅ |

### 每 Phase 的完成标准

- [x] `npm run typecheck` 通过
- [x] `npm run build` 通过
- [x] 相关回归测试通过（`regression:m3` ~ `regression:m7`）
- [x] 轨迹日志记录 Phase 新增的诊断信息
- [x] `docs/API.md` 和 `docs/ARCHITECTURE.md` 同步更新

---

## 不做的

以下是有意搁置的功能，不在本次重构范围内：

1. **向量检索 / RAG** — 当前记忆规模尚小，相关性的评分 + 关键词匹配足够。触发条件见 `docs/TECH_STACK.md`。
2. **多 Agent 协作** — Phase 7 的子代理是"委托-汇总"模式。真正的多 Agent 协作（peer-to-peer 协商）不是近期目标。
3. **Prompt Caching** — 依赖 Provider（Anthropic 支持，OpenAI 不支持），当前只做 Provider 无关的能力。
4. **Structured Output / JSON Mode** — 依赖 Provider 能力。当前通过 System Prompt 约束输出格式已能满足需求。
5. **模型 Fallback 链** — 主模型失败自动切换备用模型。Provider 生态成熟后再做。

---

## 相关文档

- [架构文档](./ARCHITECTURE.md)
- [API 文档](./API.md)
- [路线图](./ROADMAP.md)
- [Agent 交付路线图](./ROADMAP_AGENT_DELIVERY.md)
- [工程治理](./ENGINEERING_GOVERNANCE.md)
