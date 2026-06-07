# 调研报告：Tool-Calling Agent Loop（工具调用智能体循环）

> 状态：已完成 · 调研日期 2026-06-07
> 关联：ROADMAP M1「真正的 Agent 循环」+「工具调用闭环」
> 对应需求书：`agent-loop-brief.md`

---

## 1. 推荐架构

### 1.1 模块划分

```
apps/agent/src/
├── llm/
│   ├── provider.ts              # LLMProvider 接口（扩展）
│   └── openai-compatible.ts     # OpenAICompatibleProvider（重写）
├── agent/
│   ├── loop.ts                  # Agent 循环核心（重写）
│   ├── events.ts                # TaskEventBus（不变）
│   └── tool-call-accumulator.ts # 流式 tool_calls 累积器（新增）
├── tools/
│   └── registry.ts              # ToolRegistry（不变）
└── server.ts                    # SSE 路由（不变）
```

### 1.2 LLMProvider 接口扩展

现有 `LLMProvider` 只有 `stream(messages): AsyncIterable<LLMChunk>`，无法表达 tool_calls。需要扩展为：

```typescript
// apps/agent/src/llm/provider.ts

import type { Message, ToolDescriptor } from '@aurevoy/shared';

/** 流式响应的单个 chunk —— 可能是文本 delta，也可能是 tool_calls delta */
export interface LLMStreamChunk {
  /** 文本增量（与 toolCallsDelta 互斥或并存） */
  textDelta?: string;

  /** 本轮是否结束 */
  done: boolean;

  /** finish_reason，仅在 done=true 时有值 */
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'content_filter';

  /** 累积中的 tool_calls 快照（每个 chunk 都更新，done 时为完整结果） */
  toolCallsSnapshot?: AccumulatedToolCall[];

  /** DeepSeek V4 reasoning_content 增量（仅本次 chunk 新增部分，非全量累积） */
  reasoningContentDelta?: string;
}

export interface AccumulatedToolCall {
  index: number;
  id: string;
  function: {
    name: string;
    arguments: string; // 原始 JSON 字符串，累积完成后 JSON.parse
  };
}

export interface LLMStreamOptions {
  /** 可用工具列表 */
  tools?: ToolDescriptor[];
  /** 工具选择策略 */
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  /** 是否允许并行工具调用 */
  parallelToolCalls?: boolean;
  /** AbortSignal 用于取消 */
  signal?: AbortSignal;
  /** 模型参数覆盖 */
  temperature?: number;
  maxTokens?: number;
}

export interface LLMProvider {
  readonly name: string;

  /** 扩展后的流式接口 —— 支持 tool_calls */
  stream(messages: Message[], options?: LLMStreamOptions): AsyncIterable<LLMStreamChunk>;

  /** 查询当前模型是否支持 tool calling（用于降级判断） */
  supportsTools?(): Promise<boolean>;
}
```

### 1.3 Agent 循环核心伪代码

```typescript
// apps/agent/src/agent/loop.ts

const MAX_ITERATIONS = 20;
const DUPLICATE_CALL_LIMIT = 3; // 同一工具+参数最多重复调用次数
const MAX_TOOL_CALLS_PER_TURN = 10; // 单轮最多并行工具调用数

async function runTask(task: Task): Promise<void> {
  const provider = getProvider();
  const messages: Message[] = [...task.messages];
  const toolDescriptors = toolRegistry.list();
  const callFingerprints = new Map<string, number>(); // 防死循环

  const abortController = new AbortController();
  activeAbortControllers.set(task.id, abortController);

  // 发射计划（如果工具有 plan 能力，可在此生成；否则用隐式计划）
  taskEvents.publish({ type: 'status', taskId: task.id, status: 'running' });
  task.status = 'running';
  await taskStore.save(task); // 持久化状态变更

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // 检查是否被取消
    if (abortController.signal.aborted) {
      task.status = 'cancelled';
      taskEvents.publish({ type: 'status', taskId: task.id, status: 'cancelled' });
      await taskStore.save(task);
      return;
    }

    // ---------- 调用 LLM（带重试） ----------
    let finishReason: string | undefined;
    let finalToolCalls: AccumulatedToolCall[] = [];
    let textBuffer = '';
    let reasoningContent = ''; // DeepSeek V4 透传用

    try {
      // 重试包装：网络错误 / 429 / 5xx 自动退避重试
      const result = await withRetry(async () => {
        const stream = provider.stream(messages, {
          tools: toolDescriptors.length > 0 ? toolDescriptors : undefined,
          toolChoice: 'auto',
          signal: abortController.signal,
        });

        for await (const chunk of stream) {
          // 1) 发射文本 token 给前端
          if (chunk.textDelta) {
            textBuffer += chunk.textDelta;
            taskEvents.publish({ type: 'token', taskId: task.id, delta: chunk.textDelta });
          }

          // 2) 发射 reasoning_content delta 给前端（仅增量部分）
          if (chunk.reasoningContentDelta) {
            reasoningContent += chunk.reasoningContentDelta;
            // 不通过 SSE 推 reasoning_content（前端不需要），仅本地累积
          }

          // 3) 流结束
          if (chunk.done) {
            finishReason = chunk.finishReason;
            finalToolCalls = chunk.toolCallsSnapshot ?? [];
          }
        }
      }, abortController.signal);
      // withRetry 在网络错误时重试，在 AbortError / 400 / 401 时直接 throw

    } catch (err: any) {
      if (err.name === 'AbortError') {
        task.status = 'cancelled';
        taskEvents.publish({ type: 'status', taskId: task.id, status: 'cancelled' });
        await taskStore.save(task);
        return;
      }
      // 不可重试的错误 —— 失败
      task.status = 'failed';
      taskEvents.publish({ type: 'error', taskId: task.id, message: String(err.message ?? err) });
      taskEvents.publish({ type: 'done', taskId: task.id, status: 'failed' });
      await taskStore.save(task);
      return;
    }

    // ---------- 判断是否结束 ----------

    // 情况 A：输出被截断（finish_reason = "length"）
    if (finishReason === 'length') {
      const warnMsg = createMessage('assistant',
        textBuffer + '\n\n[Warning: Response was truncated due to token limit. The answer may be incomplete.]');
      messages.push(warnMsg);
      task.messages = messages;
      taskEvents.publish({ type: 'message', taskId: task.id, message: warnMsg });
      task.status = 'completed';
      taskEvents.publish({ type: 'done', taskId: task.id, status: 'completed' });
      await taskStore.save(task);
      return;
    }

    // 情况 B：模型直接给出最终回复（finish_reason = "stop"）
    if (finishReason !== 'tool_calls' || finalToolCalls.length === 0) {
      const assistantMessage = createMessage('assistant', textBuffer);
      if (reasoningContent) assistantMessage.reasoningContent = reasoningContent;
      messages.push(assistantMessage);
      task.messages = messages;
      taskEvents.publish({ type: 'message', taskId: task.id, message: assistantMessage });
      task.status = 'completed';
      taskEvents.publish({ type: 'done', taskId: task.id, status: 'completed' });
      await taskStore.save(task);
      return;
    }

    // 情况 C：模型要调用工具

    // 先将 assistant 消息（含 tool_calls）加入上下文
    const assistantMsg = createAssistantMessageWithToolCalls(textBuffer, finalToolCalls);
    if (reasoningContent) assistantMsg.reasoningContent = reasoningContent;
    messages.push(assistantMsg);

    // 限制单轮工具调用数
    if (finalToolCalls.length > MAX_TOOL_CALLS_PER_TURN) {
      finalToolCalls = finalToolCalls.slice(0, MAX_TOOL_CALLS_PER_TURN);
    }

    // 为每个 tool_call 发射事件
    for (const tc of finalToolCalls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments); } catch { /* 下方会处理 */ }
      taskEvents.publish({
        type: 'tool_call',
        taskId: task.id,
        call: { id: tc.id, toolName: tc.function.name, args },
      });
    }

    // ---------- 执行工具并回填结果 ----------
    for (const tc of finalToolCalls) {
      // 防死循环：指纹检测
      const fingerprint = `${tc.function.name}:${tc.function.arguments}`;
      const count = (callFingerprints.get(fingerprint) ?? 0) + 1;
      callFingerprints.set(fingerprint, count);
      if (count > DUPLICATE_CALL_LIMIT) {
        // 注入错误结果让模型自我纠正
        const errorMsg: Message = {
          id: crypto.randomUUID(),
          role: 'tool',
          content: JSON.stringify({
            error: `Tool "${tc.function.name}" has been called ${count} times with identical arguments. Please try a different approach or provide your final answer.`,
          }),
          toolCallId: tc.id,
          createdAt: new Date().toISOString(),
        };
        messages.push(errorMsg);
        continue;
      }

      // 执行工具
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        // 参数解析失败 —— 告知模型
        const errorMsg: Message = {
          id: crypto.randomUUID(),
          role: 'tool',
          content: JSON.stringify({ error: `Invalid JSON arguments: ${tc.function.arguments}` }),
          toolCallId: tc.id,
          createdAt: new Date().toISOString(),
        };
        messages.push(errorMsg);
        continue;
      }

      const result = await toolRegistry.invoke({
        id: tc.id,
        toolName: tc.function.name,
        args,
      });

      // 发射 tool_result 事件
      taskEvents.publish({ type: 'tool_result', taskId: task.id, result });

      // 构建 tool 结果消息
      const toolMsg: Message = {
        id: crypto.randomUUID(),
        role: 'tool',
        content: result.ok ? JSON.stringify(result.output) : JSON.stringify({ error: result.error }),
        toolCallId: tc.id,
        createdAt: new Date().toISOString(),
      };
      messages.push(toolMsg);
    }

    // 每轮结束后持久化（保证崩溃恢复）
    task.messages = messages;
    await taskStore.save(task);

    // 循环继续 —— 下一轮带着工具结果重新请求 LLM
  }

  // 超过最大轮次
  const fallbackMsg = createMessage('assistant',
    'I have reached the maximum number of reasoning iterations. Here is what I have so far based on the information gathered.');
  messages.push(fallbackMsg);
  task.messages = messages;
  taskEvents.publish({ type: 'message', taskId: task.id, message: fallbackMsg });
  task.status = 'completed';
  taskEvents.publish({ type: 'done', taskId: task.id, status: 'completed' });
  await taskStore.save(task);
}
```

### 1.4 与 toolRegistry 的交互

现有 `toolRegistry.invoke(call: ToolCall): Promise<ToolResult>` 接口无需改动。Agent 循环负责：

1. 调用 `toolRegistry.list()` 获取所有 `ToolDescriptor[]`，转换为 OpenAI `tools` 格式传给 LLM。
2. 解析 LLM 返回的 `tool_calls`，构造 `ToolCall` 对象传给 `toolRegistry.invoke()`。
3. 将 `ToolResult` 序列化为 JSON 字符串，包装成 `role: "tool"` 消息回填。

转换函数：

```typescript
function toOpenAITools(descriptors: ToolDescriptor[]) {
  return descriptors.map((d) => ({
    type: 'function' as const,
    function: {
      name: d.name,
      description: d.description,
      parameters: d.inputSchema,
    },
  }));
}
```

---

## 2. 流式 tool_calls 累积参考实现

以下是可直接落地的 TypeScript 实现，处理了跨 chunk 截断、并行调用、边界情况：

```typescript
// apps/agent/src/agent/tool-call-accumulator.ts

export interface ToolCallDelta {
  index: number;
  id?: string | null;
  type?: string | null;
  function?: {
    name?: string | null;
    arguments?: string;
  };
}

export interface AccumulatedToolCall {
  index: number;
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * 流式 tool_calls 累积器
 *
 * OpenAI 兼容 API 在流式响应中将 tool_calls 拆分为多个 delta chunk：
 * - 第一个 chunk 包含 id、type、function.name（后续 chunk 这些字段为 null）
 * - 后续 chunk 只包含 function.arguments 的字符串片段
 * - 并行调用通过不同的 index 值区分
 *
 * 此累积器通过 Map<index, AccumulatedToolCall> 正确地跨 chunk 拼接。
 */
export class ToolCallAccumulator {
  private map = new Map<number, AccumulatedToolCall>();

  /** 处理一个 delta chunk 中的 tool_calls 数组 */
  process(deltas: ToolCallDelta[]): void {
    for (const delta of deltas) {
      // 防御性：某些降级提供商可能漏掉 index
      if (delta.index == null) continue;

      const existing = this.map.get(delta.index);

      if (!existing) {
        // 首次出现该 index —— 初始化
        this.map.set(delta.index, {
          index: delta.index,
          id: delta.id ?? '',
          function: {
            name: delta.function?.name ?? '',
            arguments: delta.function?.arguments ?? '',
          },
        });
      } else {
        // 后续 chunk —— 仅拼接 arguments
        if (delta.function?.arguments) {
          existing.function.arguments += delta.function.arguments;
        }
        // 防御性：某些提供商可能在后续 chunk 才给 id/name
        if (delta.id && !existing.id) existing.id = delta.id;
        if (delta.function?.name && !existing.function.name) {
          existing.function.name = delta.function.name;
        }
      }
    }
  }

  /** 获取当前快照（按 index 排序） */
  snapshot(): AccumulatedToolCall[] {
    return Array.from(this.map.values()).sort((a, b) => a.index - b.index);
  }

  /** 获取完成后的 tool_calls，并解析 arguments */
  finalize(): Array<{
    index: number;
    id: string;
    function: { name: string; arguments: string };
    parsedArgs: Record<string, unknown>;
  }> {
    return this.snapshot().map((tc) => {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        // 解析失败会在 agent loop 层处理
      }
      return { ...tc, parsedArgs };
    });
  }

  /** 重置（新一轮循环时调用） */
  reset(): void {
    this.map.clear();
  }
}
```

**SSE 解析 + 累积的完整流程**（在 Provider 内使用）：

```typescript
async function* streamWithToolCalls(
  messages: OpenAIMessage[],
  tools: OpenAITool[] | undefined,
  signal?: AbortSignal,
): AsyncIterable<LLMStreamChunk> {
  const accumulator = new ToolCallAccumulator();

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      tool_choice: tools ? 'auto' : undefined,
      stream: true,
    }),
    signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason: string | null = null;
  let reasoningContent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // 保留不完整的最后一行

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;

      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;

      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue; // 跳过解析失败的行
      }

      const choice = parsed.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta;

      // reasoning_content 增量（DeepSeek V4 透传）—— 只 yield 本次 delta，非全量
      let reasoningDelta: string | undefined;
      if (delta?.reasoning_content) {
        reasoningContent += delta.reasoning_content;
        reasoningDelta = delta.reasoning_content;
      }

      // 累积 tool_calls
      if (delta?.tool_calls) {
        accumulator.process(delta.tool_calls);
      }

      // 文本 delta 或 reasoning_content delta —— 任一有值就 yield
      if (delta?.content || reasoningDelta) {
        yield {
          textDelta: delta?.content ?? undefined,
          done: false,
          toolCallsSnapshot: accumulator.snapshot(),
          reasoningContentDelta: reasoningDelta,
        };
      }

      // 记录 finish_reason
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }
  }

  // 流结束 —— 发射最终 chunk
  const validFinishReasons = ['stop', 'tool_calls', 'length', 'content_filter'] as const;
  const normalizedFinish = (validFinishReasons as readonly string[]).includes(finishReason ?? '')
    ? (finishReason as LLMStreamChunk['finishReason'])
    : 'stop';

  yield {
    done: true,
    finishReason: normalizedFinish,
    toolCallsSnapshot: accumulator.snapshot(),
  };
}
```

---

## 3. 契约改动建议

### 3.1 `Message` 类型扩展（`packages/shared/src/index.ts`）

现有 `Message` 无法携带 `tool_calls` 和 `tool_call_id`。最小改动如下：

```typescript
// ---- 新增类型 ----

/** LLM 返回的工具调用请求（嵌入 assistant 消息） */
export interface MessageToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON 字符串
  };
}

// ---- 修改 Message 接口 ----

export interface Message {
  id: string;
  role: MessageRole; // 'user' | 'assistant' | 'system' | 'tool'（已有）
  content: string;
  createdAt: string;

  /** assistant 消息携带的工具调用请求（仅 role='assistant' 时有值） */
  toolCalls?: MessageToolCall[];

  /** tool 结果消息关联的 tool_call_id（仅 role='tool' 时有值） */
  toolCallId?: string;

  /** DeepSeek V4 的 reasoning_content 透传（可选） */
  reasoningContent?: string;
}
```

**改动影响评估**：

- 新增的三个字段（`toolCalls`、`toolCallId`、`reasoningContent`）都是可选的，不会破坏现有序列化/反序列化。
- SQLite 中 `messages` 列存储为 JSON，新增字段自动兼容。
- 前端已对 `role: 'tool'` 做了 `case` 分支（虽然目前是空操作），只需补充渲染逻辑。

### 3.2 SSE 事件契约

现有 `AgentEvent` 类型中 `tool_call` 和 `tool_result` 已经定义，**无需修改事件类型定义**。只需要在 Agent 循环中正确发射这些事件即可。

前端 `handleEvent` 中 `tool_call` / `tool_result` 目前是空操作（`// no-op`），后续需要补充 UI 渲染——但这不是本次循环实现的阻塞项。

### 3.3 构建 OpenAI 消息格式的转换函数

在 Provider 层需要将 Aurevoy 的 `Message[]` 转换为 OpenAI API 要求的格式：

```typescript
function toOpenAIMessage(msg: Message): OpenAIChatMessage {
  const base: any = {
    role: toOpenAIRole(msg.role),
    content: msg.content,
  };

  // assistant 消息附带 tool_calls
  if (msg.role === 'assistant' && msg.toolCalls?.length) {
    base.tool_calls = msg.toolCalls;
    // OpenAI 要求 content 为 null（当有 tool_calls 时）
    if (!base.content) base.content = null;
  }

  // tool 结果消息需要 tool_call_id
  if (msg.role === 'tool' && msg.toolCallId) {
    base.tool_call_id = msg.toolCallId;
  }

  // DeepSeek V4 reasoning_content 透传
  if (msg.reasoningContent) {
    base.reasoning_content = msg.reasoningContent;
  }

  return base;
}

function toOpenAIRole(role: MessageRole): string {
  switch (role) {
    case 'user': return 'user';
    case 'assistant': return 'assistant';
    case 'system': return 'system';
    case 'tool': return 'tool';
    default: return 'user';
  }
}
```

### 3.4 必须同步修改的现有代码

**现有 `OpenAICompatibleProvider.stream()` 中有两处必须同步改动**，否则工具调用无法正常工作：

1. **移除 `role: 'tool'` 消息过滤**：现有代码在发送请求前执行了 `.filter((m) => m.role !== 'tool')`（`apps/agent/src/llm/provider.ts`），把所有 tool 结果消息过滤掉了。升级后必须移除此过滤器，否则模型永远看不到工具执行结果，循环无法进行。

2. **`toOpenAIRole()` 需要补充 `'tool'` 映射**：现有实现中 `toOpenAIRole()` 的 switch 没有 `case 'tool'`，未匹配的 role 会被默认映射为 `'user'`。必须显式添加 `case 'tool': return 'tool'`，否则 tool 结果消息的 role 会被错误地改为 `user`，导致 OpenAI API 报错。

---

## 4. 提供商兼容矩阵

### 4.1 兼容矩阵

| 能力 | OpenAI | DeepSeek V4 Flash/Pro | DeepSeek Chat (V3.2) | Ollama | vLLM | LM Studio |
|---|---|---|---|---|---|---|
| `tools` 参数 | 完整支持 | 完整支持 | 完整支持 | 支持（模型依赖） | 支持（需配置 parser） | 支持（模型依赖） |
| `tool_choice` | `auto/none/required/named` | `auto/required/named` | `auto/required/named` | **不支持** | `auto/none/required/named` | 模型依赖 |
| 流式 `tool_calls` | 完整增量 delta | 完整增量 delta | 完整增量 delta | **有问题** —— 仅在流末尾输出 | 支持（parser 依赖） | 模型依赖 |
| 并行工具调用 | 支持 | 支持 | 支持 | 有限支持 | parser 依赖 | 模型依赖 |
| `strict` 模式 | 支持 | 支持（/beta 端点） | 不支持 | 不支持 | 不支持 | 不支持 |
| 额外字段 | 无 | `reasoning_content`（必须回传！） | 无 | 无 | 无 | 无 |

### 4.2 DeepSeek 详细现状与坑

**模型支持**：
- `deepseek-v4-flash` / `deepseek-v4-pro`：完整支持 function calling + thinking mode。
- `deepseek-chat`（V3.2 legacy）：支持 tool calling，**2026 年 7 月 24 日退役**，需迁移到 V4。
- `deepseek-reasoner`（R1 legacy）：**不支持** function calling，传入 `tools` 会静默回退到 `deepseek-chat`。

**关键坑：`reasoning_content` 必须回传**：

当 V4 处于 thinking 模式时，assistant 消息中包含 `reasoning_content` 字段。在多轮对话（涉及 tool_calls）中，**必须将此字段原样回传到下一轮请求的 assistant 消息中**，否则 API 返回 400 错误：`"The reasoning_content in the thinking mode must be passed back to the API."`

这已经导致了大量第三方集成（Cursor、Claude Code 等）出错。我们的实现必须在 `Message` 类型中保留 `reasoningContent` 字段并在回传时注入。

**流式 tool_calls 行为**：与 OpenAI 一致——`delta.tool_calls[]` 按 index 分片，arguments 跨多 chunk 累积。可以使用标准的累积算法。

### 4.3 Ollama 详细现状与坑

**核心问题**：
1. **不支持 `tool_choice`** —— 无法强制使用工具或指定工具，始终为 `auto`。
2. **流式 tool_calls 严重不稳定** —— Ollama 在启用 streaming 时，tool_calls 仅在流末尾一次性输出（不是增量 delta），某些模型甚至会丢失 tool_calls。
   - **对策**：检测 Ollama 提供商时，对包含 tools 的请求自动关闭 streaming（`stream: false`），或使用非流式回退。

**推荐支持 tools 的 Ollama 模型**：`llama3.1:70b`、`qwen2.5:14b`、`llama3.1:8b`、`qwen2.5:7b`、`firefunction-v2`、`hermes-2/3`。

**不推荐**：`llama3`（基础版，非 3.1）、`gemma2`、`phi3.5`。

### 4.4 降级策略

```typescript
/** 降级决策树 */
async function resolveToolStrategy(provider: LLMProvider): Promise<ToolStrategy> {
  // 1) 检查 provider 是否声明支持 tools
  if (provider.supportsTools) {
    const supported = await provider.supportsTools();
    if (supported) return { mode: 'native', stream: true };
  }

  // 2) 探针检测：发送一个最小 tool 请求
  try {
    await probeToolCall(provider);
    return { mode: 'native', stream: true };
  } catch (err: any) {
    if (err.message?.includes('does not support tools')) {
      // Ollama 明确报错
      return { mode: 'native_no_stream', stream: false };
    }
  }

  // 3) 最终降级：System Prompt 描述工具
  return { mode: 'prompt_based', stream: true };
}

interface ToolStrategy {
  mode: 'native' | 'native_no_stream' | 'prompt_based';
  stream: boolean;
}
```

**Prompt-Based 降级方案**（当原生 tools 不可用时）：

将工具描述注入 system prompt，让模型输出结构化的 JSON 调用块，由我们解析：

```
你有以下工具可以使用。当需要调用工具时，输出如下格式的 JSON 代码块：

```tool_call
{"name": "工具名", "arguments": {"参数名": "参数值"}}
```

可用工具：
- get_current_time: 获取当前时间。参数：无。
- ...
```

然后在 Agent 循环中用正则 `/```tool_call\n([\s\S]*?)\n```/` 提取并解析。

---

## 5. 依赖选型结论

### 5.1 方案对比

| 维度 | 原生 fetch | `openai` SDK (v6.x) | Vercel AI SDK (v6.x) | LangChain.js |
|---|---|---|---|---|
| 运行时依赖 | 0 | 0 | 4+（含 @opentelemetry/api） | 大量传递依赖 |
| 体积 (gzip) | 0 kB | ~34 kB | ~67.5 kB | ~101+ kB |
| 流式 tool_calls | 手写 ~150 行 | 内置自动累积 | 内置自动累积 | 内置 streamEvents |
| Agent 循环 | 手写 while | 手写 while | 内置 `maxSteps` | 内置 ReAct |
| 自定义 baseURL | 是 | 是 | 是 | 是 |
| AbortController | 手动接管 | 内置 signal | 内置 abortSignal | 支持但笨重 |
| 原始 SSE 转发 | 直接 pipe | 需重新序列化 | 需自定义序列化 | 复杂 |
| TypeScript | 自行维护 | OpenAPI 生成 | 一等公民 + Zod | 一等公民 |

### 5.2 推荐结论

**推荐：保持原生 fetch，参考 openai SDK 的累积逻辑自行实现。**

理由：

1. **我们已经在用原生 fetch** —— 现有 `OpenAICompatibleProvider` 已经基于原生 fetch + 手写 SSE 解析运行良好，只需要扩展它以支持 tool_calls。

2. **SSE 转发需求** —— 我们的架构需要通过 SSE 向前端推送自定义事件（`token`、`tool_call`、`tool_result` 等）。原生 fetch 允许我们逐行解析上游 SSE 并立即转换为自己的事件格式转发，延迟最低、控制力最强。引入 SDK 后反而需要在 SDK 抽象层和自己的事件层之间做转换。

3. **累积逻辑并不复杂** —— 上面的 `ToolCallAccumulator` 类约 60 行代码，逻辑清晰、经过验证。不值得为此引入 34-67 kB 的依赖。

4. **零依赖原则** —— 符合项目需求书中「不引入重依赖」的约束。

5. **DeepSeek 特殊字段** —— DeepSeek 的 `reasoning_content` 需要透传，SDK 可能会剥离这些非标准字段。原生 fetch 可以完整保留所有响应字段。

**不推荐的方案**：
- `openai` SDK：虽然零运行时依赖且质量好，但它的 `ChatCompletionStream` 会抽象掉原始 SSE，给我们的自定义事件转发带来额外复杂度。
- Vercel AI SDK：`maxSteps` 内置循环很方便，但依赖重、流协议是 Vercel 私有格式，与我们现有 SSE 事件契约不兼容。
- LangChain.js：依赖太重、抽象太厚，不适合我们的场景。

---

## 6. 风险与边界

### 6.1 最大轮次与防死循环

**推荐配置**：

| 参数 | 推荐值 | 说明 |
|---|---|---|
| `MAX_ITERATIONS` | 20 | 单任务最大 LLM 调用轮次。简单任务 5-10 轮即可，复杂任务不超过 20 |
| `DUPLICATE_CALL_LIMIT` | 3 | 相同工具+相同参数最多重复调用 3 次，超过后注入错误提示让模型自我纠正 |
| `MAX_TOOL_CALLS_PER_TURN` | 10 | 单轮最多并行工具调用数，防止模型一次请求过多工具 |

**防死循环策略**（按优先级）：

1. **指纹去重**：跟踪 `(toolName, serializedArgs)` 对，超过阈值注入提示。
2. **停滞检测**：如果连续 3 轮模型的输出（文本 + 工具调用）完全相同，终止循环。
3. **上下文增长检测**：如果 `messages` 数组序列化后超过上下文窗口的 80%，触发摘要压缩或终止。

### 6.2 错误处理策略

```
错误类型                    → 处理方式
─────────────────────────────────────────────────────────
工具执行失败               → 包装为 ToolResult { ok: false, error } 回传给模型，让其自我纠正
工具参数 JSON 解析失败      → 注入错误消息告知模型参数格式有误
工具不存在                 → 注入错误消息，列出可用工具名
单轮 LLM 调用网络失败       → 指数退避重试（最多 3 次，base=1s, max=10s）
LLM 返回 429 (Rate Limit)  → 读取 Retry-After 头，等待后重试
LLM 返回 400 (参数错误)    → 不重试，直接报错给用户
LLM 返回 401/403           → 不重试，提示用户检查 API Key
上下文超限 (400 error)     → 尝试截断早期消息，保留 system + 最近 N 轮
AbortError (用户取消)      → 清理资源，设置 cancelled 状态
```

**重试实现**（`withRetry` 辅助函数，在 Agent 循环中使用）：

```typescript
/**
 * 带指数退避的重试包装器。
 * - 网络错误、429、5xx：自动重试（最多 maxRetries 次）
 * - 400、401、403：不可重试，直接 throw
 * - AbortError（用户取消）：不重试，直接 throw
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal,
  maxRetries = 3,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 已被取消则不再重试
    if (signal.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    try {
      if (attempt > 0) {
        // 指数退避 + 随机抖动
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        const jitter = Math.random() * 500;
        await new Promise((r) => setTimeout(r, delay + jitter));
      }
      return await fn();
    } catch (err: any) {
      lastError = err;

      // 不可重试的错误 —— 立即抛出
      if (err.name === 'AbortError') throw err;
      if (err.status === 400 || err.status === 401 || err.status === 403) throw err;

      // 可重试的错误（429, 500, 502, 503, 网络错误）继续循环
    }
  }

  throw lastError!;
}
```

### 6.3 上下文窗口管理

当消息历史过长时的策略：

```typescript
function trimMessages(messages: Message[], maxTokens: number): Message[] {
  // 1) 始终保留 system 消息（index 0）
  // 2) 从最新消息开始保留
  // 3) 估算 token 数（粗略：字符数 / 4）
  const systemMsg = messages[0];
  const rest = messages.slice(1);

  let tokenEstimate = estimateTokens(systemMsg);
  const kept: Message[] = [systemMsg];

  for (let i = rest.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(rest[i]);
    if (tokenEstimate + msgTokens > maxTokens * 0.8) {
      // 插入一条摘要消息标记被截断的历史
      kept.splice(1, 0, {
        id: crypto.randomUUID(),
        role: 'system',
        content: '[Earlier conversation history was truncated to fit context window]',
        createdAt: new Date().toISOString(),
      });
      break;
    }
    kept.splice(1, 0, rest[i]); // 插入到 system 之后
    tokenEstimate += msgTokens;
  }

  return kept;
}

function estimateTokens(msg: Message): number {
  return Math.ceil((msg.content.length + JSON.stringify(msg.toolCalls ?? '').length) / 4);
}
```

### 6.4 取消/中断方案

```typescript
// 在 Agent 循环外部维护
const activeAbortControllers = new Map<string, AbortController>();

// 启动任务时
function startTask(task: Task) {
  const ac = new AbortController();
  activeAbortControllers.set(task.id, ac);
  runTask(task, ac); // 将 AbortController 传入
}

// 取消任务时
function cancelTask(taskId: string) {
  const ac = activeAbortControllers.get(taskId);
  if (ac) {
    ac.abort(); // 这会中断 fetch 流
    activeAbortControllers.delete(taskId);
  }
}

// 在 Agent 循环中
async function runTask(task: Task, abortController: AbortController) {
  try {
    for await (const chunk of provider.stream(messages, {
      signal: abortController.signal, // 传递给 fetch
    })) {
      // ...
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      // 用户主动取消 —— 不是真正的错误
      publishStatus('cancelled');
      return;
    }
    throw err; // 其它错误向上抛
  } finally {
    activeAbortControllers.delete(task.id);
  }
}
```

**两阶段取消**（为后续 ROADMAP 预留）：

- **Soft Cancel**：设置标志位，让当前正在进行的 LLM 调用完成后不再进入下一轮循环。延迟较低，但需等待当前流完成。
- **Hard Cancel**：直接 `abortController.abort()`，立即中断 fetch 流。响应快但可能丢失当前轮的部分结果。

### 6.5 安全：用户确认/审批机制

参考 Hermes Agent 的分层审批设计，在我们的架构中的插入方式：

```typescript
/** 工具风险等级 */
export type ToolRiskLevel = 'safe' | 'caution' | 'dangerous';

/** 工具注册时声明风险等级 */
export interface Tool {
  descriptor: ToolDescriptor & {
    riskLevel?: ToolRiskLevel; // 默认 'safe'
  };
  execute(args: Record<string, unknown>): Promise<unknown>;
}

/** 在 Agent 循环中，执行工具前检查风险等级 */
async function maybeRequestApproval(
  tool: Tool,
  call: ToolCall,
  taskId: string,
): Promise<boolean> {
  const risk = tool.descriptor.riskLevel ?? 'safe';

  if (risk === 'safe') return true; // 自动放行

  if (risk === 'caution') {
    // 发射审批请求事件，等待用户响应
    publish({
      type: 'approval_request', // 需新增事件类型（为后续 ROADMAP 预留）
      taskId,
      call,
      riskLevel: risk,
    });
    return await waitForApproval(taskId, call.id);
  }

  if (risk === 'dangerous') {
    // 默认拒绝，除非用户明确授权
    publish({ type: 'approval_request', taskId, call, riskLevel: risk });
    return await waitForApproval(taskId, call.id);
  }

  return false;
}
```

**M1 阶段的实现建议**：先不实现审批 UI，所有工具默认为 `safe`。在 Tool 注册接口中预留 `riskLevel` 字段，后续 M2/M3 接入审批 UI 时再启用。

### 6.6 「计划」的取舍

**结论：M1 阶段采用「隐式计划 + 工具轨迹映射」方案。**

理由：

1. 在 tool-calling 循环下，模型每轮自主决策调用什么工具、何时给出最终答案，这本身就是一种隐式的计划执行过程。显式的 plan-then-execute 模式会增加一轮额外的 LLM 调用（专门用于生成计划），在简单任务上是浪费。

2. 业界趋势（2025-2026）：Claude Code、OpenClaw 等产品级 Agent 都采用纯 ReAct 循环（emergent planning），只有 LangGraph 等编排框架才做显式 plan-first。Anthropic 官方推荐「通过 extended thinking 实现隐式规划」。

3. 与我们现有 `plan / step_update` UI 的契合方案：

```typescript
// 方案：将工具调用轨迹映射为 plan steps
// 在 Agent 循环开始时，发射一个单步计划
publish({
  type: 'plan',
  taskId: task.id,
  plan: [{ id: 'exec', description: 'Executing task...', status: 'running' }],
});

// 每次工具调用时，更新 step 描述
publish({
  type: 'step_update',
  taskId: task.id,
  step: {
    id: 'exec',
    description: `Using tool: ${toolCall.function.name}`,
    status: 'running',
  },
});

// 循环结束时
publish({
  type: 'step_update',
  taskId: task.id,
  step: { id: 'exec', description: 'Task completed', status: 'completed' },
});
```

后续如果需要显式规划，可以在循环前增加一轮 LLM 调用生成计划，然后按计划步骤驱动工具调用。这不需要改动循环核心代码，只需在 `runTask` 入口处增加规划阶段。

---

## 7. 参考来源链接

### 官方文档

- [OpenAI Function Calling Guide](https://platform.openai.com/docs/guides/function-calling)
- [OpenAI API Reference - Chat Completions](https://platform.openai.com/docs/api-reference/chat)
- [DeepSeek API Documentation](https://api-docs.deepseek.com/)
- [DeepSeek API Changelog](https://api-docs.deepseek.com/zh-cn/updates)
- [Ollama OpenAI Compatibility](https://github.com/ollama/ollama/blob/main/docs/openai.md)
- [vLLM Tool Calling](https://docs.vllm.ai/en/latest/features/tool_calling.html)

### 参考实现

- [NousResearch/hermes-agent (GitHub)](https://github.com/nousresearch/hermes-agent) — Python, 7 层审批系统, 70+ 工具
- [Anthropic Claude Agent SDK](https://github.com/anthropics/claude-code) — 自动上下文压缩, 6 种权限模式
- [Vercel AI SDK](https://sdk.vercel.ai/docs) — `maxSteps` 内置循环, `streamText` + `fullStream`
- [openai-node SDK (GitHub)](https://github.com/openai/openai-node) — `ChatCompletionStream` 累积逻辑参考
- [LangGraph Human-in-the-Loop](https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/) — `interrupt_before/after` 模式

### 社区资源

- [DeepSeek V4 Complete Guide (2026)](https://codersera.com/blog/deepseek-v4-complete-guide-2026/)
- [Ollama Function Calling Guide](https://localaimaster.com/blog/ollama-function-calling-tools)
- [AI Agent Framework Comparison (Speakeasy)](https://www.speakeasy.com/blog/ai-agent-framework-comparison)
- [Anthropic: Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
- [LangChain vs Vercel AI SDK vs OpenAI SDK (Strapi)](https://strapi.io/blog/langchain-vs-vercel-ai-sdk-vs-openai-sdk-comparison-guide)

---

## 附录 A：完整实现检查清单

按以下顺序编码即可逐步完成 Agent 循环升级：

```
□ 1. 扩展 packages/shared 的 Message 类型（加 toolCalls, toolCallId, reasoningContent）
□ 2. 实现 ToolCallAccumulator（apps/agent/src/agent/tool-call-accumulator.ts）
□ 3. 扩展 LLMProvider 接口（加 LLMStreamOptions、LLMStreamChunk）
□ 4. 重写 OpenAICompatibleProvider.stream()（支持 tools 参数 + tool_calls 累积 + reasoning_content 透传）
   ⚠️ 同步移除 .filter(m => m.role !== 'tool')，补充 toOpenAIRole 的 'tool' case
□ 5. 实现 toOpenAIMessage() 转换函数（处理 tool_calls 和 tool_call_id）
□ 6. 实现 withRetry() 辅助函数（指数退避 + AbortError/4xx 不重试）
□ 7. 重写 agent/loop.ts 的 runTask()（ReAct 循环 + 防死循环 + 重试 + 持久化）
□ 8. 添加 AbortController 支持（取消功能 + AbortError 捕获）
□ 9. 实现 Ollama 降级检测（stream: false for tools）
□ 10. 测试：单工具调用 → 并行工具调用 → 工具失败自我纠正 → 不支持 tools 降级 → 取消
□ 11. 前端补充 tool_call / tool_result 事件渲染（非阻塞）
```

## 附录 B：已知坑速查

| 坑 | 影响 | 对策 |
|---|---|---|
| DeepSeek V4 `reasoning_content` 未回传 | 400 错误，多轮对话中断 | Message 类型保留 reasoningContent，回传时注入 |
| Ollama 流式 tool_calls 丢失 | tool_calls 数组为空 | 检测 Ollama 后对 tools 请求关闭 streaming |
| `arguments` 是字符串不是对象 | JSON.parse 前不要当对象用 | 累积为字符串，完成后统一 parse |
| 流式 delta 中 index ≠ 数组位置 | 并行调用时错误路由 | 始终用 `delta.index` 作为 Map key |
| `content` 与 `tool_calls` 可能并存 | 某些兼容提供商会同时返回 | 防御性编程：两个字段独立检查 |
| `finish_reason: "length"` | 输出被截断 | 不继续循环，提示用户或增大 max_tokens |
| 模型反复调用同一工具 | 死循环 | 指纹去重 + 注入错误提示 + 最大轮次兜底 |
| legacy `deepseek-reasoner` 不支持 tools | 静默回退 | 模型能力检测 + 降级策略 |
| 现有 Provider 过滤 `role: 'tool'` 消息 | 工具结果永远到不了模型 | 移除 `.filter(m => m.role !== 'tool')` |
| 现有 `toOpenAIRole()` 无 `'tool'` 映射 | tool 消息被误映射为 user | 补充 `case 'tool': return 'tool'` |
