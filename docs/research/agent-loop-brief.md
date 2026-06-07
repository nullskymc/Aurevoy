# 调研需求书：Tool-Calling Agent Loop（工具调用智能体循环）

> 状态：待调研 · 创建于 2026-06-07
> 用途：派发给执行方调研最新技术实现，回填结果后据此编码。
> 关联：ROADMAP M1「真正的 Agent 循环」+「工具调用闭环」（拟合并为本环节）。

## 1. 背景与目标

Aurevoy 是 Node 20 + TypeScript 的本地 AI Agent 桌面产品，后端 Fastify，经 SSE 向前端流式推送事件。
现要把后端的「假循环」（写死两步计划 + 单次 LLM 输出）升级为**真正的工具调用智能体循环（ReAct 式）**：
由模型每轮自行决定「调用工具还是给出最终答案」，循环把工具结果回灌，直到产出最终回复。

参考实现：**NousResearch/hermes-agent** 的 `AIAgent.run_conversation`
（`build_prompt → call LLM → tool_calls? → execute → loop → final`）。

**调研目标**：产出一份「在我们这套栈上如何正确、健壮地实现该循环」的最新技术落地方案，供后续直接编码。

## 2. 现状约束（必须适配，不要假设其它栈）

- **LLM 接入**：OpenAI 兼容协议，原生 `fetch` 调 `/chat/completions`，`stream: true`。
  当前生产模型是 **DeepSeek（`deepseek-v4-flash`，OpenAI 兼容端点）**，也要兼顾本地 Ollama / 其它 OpenAI 兼容端点。
- **已有抽象**：
  - `LLMProvider` 接口目前只有 `stream(messages): AsyncIterable<{delta, done}>`（`apps/agent/src/llm/provider.ts`）。
  - `toolRegistry` 有 `register / list(): ToolDescriptor[] / invoke(call): ToolResult`（`apps/agent/src/tools/registry.ts`）。
  - SSE 事件契约已含 `token / tool_call / tool_result / message / plan / step_update / done / error`
    （定义在 `packages/shared/src/index.ts`）。
- **不引入重依赖**：优先原生 fetch + 手写 SSE 解析；是否值得引入官方 `openai` SDK 或
  Vercel `ai` SDK 等，需要在调研里给出明确取舍结论。

## 3. 调研范围与具体问题

### 3.1 OpenAI 兼容的 function calling（流式）
- `tools` / `tool_choice` 请求参数的最新规范（`type: "function"` 结构、JSON Schema 形态）。
- **流式响应里 `tool_calls` 如何分片传输**：`choices[].delta.tool_calls[]` 的
  `index / id / function.name / function.arguments` 如何跨多个 chunk 累积拼接？给出可靠的累积算法/伪代码。
- 同一次响应里 content 与 tool_calls 是否会混合？`finish_reason` 取值
  （`tool_calls` / `stop` / `length`）如何作为循环终止判据。
- **并行工具调用（parallel tool calls）**：一轮返回多个 tool_call 的处理与回填顺序。

### 3.2 消息协议
- assistant 含 `tool_calls` 的消息、`role: "tool"` 结果消息（`tool_call_id` 关联）如何拼接进下一轮 `messages`。
- 我们的 `Message` 类型（`role: 'user'|'assistant'|'system'|'tool'`）需要怎样扩展才能携带
  `tool_calls` / `tool_call_id`？给出对 `packages/shared` 的最小契约改动建议。

### 3.3 循环控制与健壮性
- 最大轮次上限的业界经验值；防死循环（模型反复调同一工具）策略。
- 工具执行报错如何回灌给模型让其自我纠正 vs 直接失败；重试/退避策略。
- 单轮 LLM 调用失败的重试；`max_tokens` / 上下文超限的处理。

### 3.4 提供商差异（关键）
- **DeepSeek**：function calling 支持现状、已知坑（如流式 tool_calls 行为、`deepseek-v4-flash` 是否支持 tools）。
- 本地 **Ollama / LM Studio / vLLM**：OpenAI 兼容端点对 tools 的支持程度与差异。
- 模型**不支持 tools 时的优雅降级**方案（退化为直接问答，不报错）。

### 3.5 取消/中断（为后续 ROADMAP 预留）
- 用 `AbortController` 中断进行中的 fetch 流；循环中途取消的正确清理方式。

### 3.6 安全
- 危险工具（后续的 shell/文件写）调用前的**用户确认/审批**机制在 Agent 循环里如何插入
  （参考 Hermes 的 `approval.py` 思路）。

### 3.7 「计划」的取舍
- tool-calling 循环下是否还需要显式 plan？业界做法（纯涌现 vs 规划前置 vs 把工具轨迹映射为步骤）。
  给出对我们现有 `plan / step_update` UI 的最佳契合方案。

### 3.8 依赖选型结论
- 原生手写 vs `openai` SDK vs Vercel `ai` SDK：在「本地、OpenAI 兼容、要流式 tool_calls、要可中断」
  诉求下的推荐结论与理由。

## 4. 期望交付物（请研究方按此格式回复）

1. **推荐架构**：循环伪代码 + 模块划分（provider 新增方法签名、loop 结构、与 toolRegistry 的交互）。
2. **流式 tool_calls 累积的参考实现**（TypeScript 片段，能直接落地）。
3. **契约改动建议**：`packages/shared` 里 `Message` / 事件需要的最小增改。
4. **提供商兼容矩阵**：DeepSeek / OpenAI / Ollama 对 tools 的支持与坑，降级策略。
5. **依赖选型结论**：用不用 SDK，理由。
6. **风险与边界**：已知坑、最大轮次、错误处理、取消方案。
7. **参考来源链接**（优先 2025–2026 的官方文档/权威实现）。

## 5. 验收标准

- 方案能在 **Node 20 + 原生 fetch + OpenAI 兼容（DeepSeek）** 上落地，
  **复用现有 SSE 事件契约，前端尽量零改动**。
- 给出的流式 tool_calls 累积逻辑经得起「跨 chunk 截断 + 并行调用」的考验。
- 对「模型不支持 tools」有明确降级路径。

## 6. 回填区（调研结果填这里）

> 执行方完成后将结论填入本节，或新建 `docs/research/agent-loop-findings.md` 并在此链接。

调研结果详见 [`agent-loop-findings.md`](./agent-loop-findings.md)（2026-06-07 完成）。
