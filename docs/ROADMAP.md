# 路线图 — ROADMAP

> 分阶段规划与任务清单。决定"接下来做什么"时读本文。每完成一项请勾选并更新状态。

## 阶段总览

| 阶段 | 主题 | 状态 |
|---|---|---|
| M0 | 骨架与全链路打通 | ✅ 完成 |
| M1 | 接入真实 LLM 与真正的 Agent 循环 | ⏳ 进行中/下一步 |
| M2 | 工具能力（MCP）与本地操作 | ⏳ 待启动 |
| M3 | 记忆与个性化 | ⏳ 待启动 |
| M4 | 产品化：多轮对话、任务历史、设置 | ⏳ 待启动 |
| M5 | 打包分发与 Windows 扩展 | ⏳ 待启动 |

---

## M0 — 骨架（✅ 已完成）

- [x] npm workspaces monorepo（desktop / agent / shared）
- [x] 前后端通信：HTTP + SSE，引擎监听 127.0.0.1:8787
- [x] 共享类型契约 `@aurevoy/shared`
- [x] Agent 引擎：Fastify + 事件总线 + Mock LLM + 工具注册表 + SQLite
- [x] 前端：Tauri + React，任务输入与流式输出 UI
- [x] 全链路验证：typecheck、后端冒烟、前端构建、Tauri `cargo check`

## M1 — 真实智能（下一步）

- [x] 接入真实 LLM Provider（OpenAI 兼容，覆盖 OpenAI/DeepSeek/Ollama 等）；已移除 Mock，未配置即明确报错
- [~] Provider 配置与 Key 管理（`.env` 已落地；设置界面与多 Provider 运行时切换待做）
- [ ] **ReAct 工具调用循环（合并「真正的 Agent 循环」+「工具调用闭环」）**

  > 调研结论见 [`research/agent-loop-findings.md`](./research/agent-loop-findings.md)。
  > 采用 tool-calling loop（模型每轮自主决定调工具或给最终答案，工具结果回灌再请求），
  > 而非 plan-then-execute；复用现有 SSE 契约，前端尽量零改动。

  关键设计决策（已定）：
  - **隐式计划**：不强制先规划，用工具调用轨迹映射现有 `plan`/`step_update`；显式规划留作后续可选增强。
  - **原生 fetch**：不引入 openai / Vercel AI / LangChain SDK，自行实现流式 tool_calls 累积（理由见 `TECH_STACK.md`）。
  - **DeepSeek `reasoning_content` 必须回传**：`Message` 保留 `reasoningContent`，多轮回传时注入，否则 400。
  - **Ollama 降级**：检测到 Ollama 时对带 tools 的请求关闭 streaming；模型不支持 tools 时退化为直接问答，不报错。
  - **防死循环**：指纹去重（同工具+同参数上限 3 次）+ 单轮并行调用上限 + 最大轮次（20）兜底。
  - **重试**：网络/429/5xx 指数退避重试；4xx/AbortError 不重试。
  - **取消**：`AbortController` 贯穿 fetch，预留 soft/hard cancel。
  - **审批预留**：工具注册预留 `riskLevel`；`approval_request` 事件留到 M2 接 UI。

  有序子任务（来自调研报告附录 A）：
  - [ ] `packages/shared`：`Message` 扩展 `toolCalls` / `toolCallId` / `reasoningContent`（+ `MessageToolCall` 类型）
  - [ ] `agent/tool-call-accumulator.ts`：流式 tool_calls 累积器（按 `index` 跨 chunk 拼接，处理并行/截断）
  - [ ] 扩展 `LLMProvider`：`LLMStreamOptions`（tools/toolChoice/signal 等）+ `LLMStreamChunk`
  - [ ] 重写 `OpenAICompatibleProvider.stream()`：支持 tools 参数、tool_calls 累积、`reasoning_content` 透传
        ⚠️ 同步移除 `.filter(m => m.role !== 'tool')`，补 `toOpenAIRole` 的 `'tool'` 分支
  - [ ] `toOpenAIMessage()` 转换（处理 tool_calls / tool_call_id / reasoning_content）
  - [ ] `withRetry()`：指数退避，AbortError/4xx 不重试
  - [ ] 重写 `agent/loop.ts` `runTask()`：ReAct 循环 + 防死循环 + 重试 + 每轮持久化
  - [ ] `AbortController` 取消支持与 `AbortError` 捕获
  - [ ] Ollama 降级检测（带 tools 时 `stream:false`）
  - [ ] 测试：单工具 → 并行工具 → 工具失败自我纠正 → 不支持 tools 降级 → 取消
  - [ ] 前端补充 `tool_call` / `tool_result` 渲染（非阻塞，见 `UI_DESIGN.md`）

- [ ] 任务控制对外接口：`POST /api/tasks/:id/cancel`（接循环内的 `AbortController`）、
      `pause`/`resume`；对应请求/响应类型先定义在 `packages/shared`

## M2 — 工具与操作（MCP）

- [ ] 集成 MCP TypeScript SDK，启动期把 MCP server 工具注册进 `toolRegistry`
- [ ] 内置基础工具：文件读写、HTTP 抓取、shell（带权限确认）
- [ ] 工具权限模型：危险操作需用户确认（呼应桌面侧 Tauri capabilities）
- [ ] 工具调用可视化（前端展示调用与结果）

## M3 — 记忆与个性化

- [ ] 持久记忆：用户偏好、习惯、长期事实
- [ ] 向量检索（sqlite-vec / LanceDB）支撑 RAG 与相关记忆召回
- [ ] 会话级短期记忆 vs 跨会话长期记忆的分层

## M4 — 产品化

- [ ] 多轮对话（同一任务内继续追问/补充）
- [x] 任务历史列表与详情回看（侧栏对话历史 + 选中回看，基于 `GET /api/tasks`）
- [ ] 设置界面：模型、Key、工具开关、数据管理（侧栏入口已占位，功能待接）
- [~] UI 打磨：计划/工具/思考过程的清晰呈现
  - 已落地**对话优先界面重做**：两栏布局、居中空状态 hero、大圆角输入框、
    对话流（用户气泡 / 内联可折叠计划卡片 / 流式输出 + 思考态）、运行详情抽屉。
  - 设计文档 `docs/UI_DESIGN.md` 已同步改写为"对话优先 + 透明度可选"方向。
  - 待补：Markdown 渲染、搜索/记忆/设置入口接入真实能力、多轮对话呈现。

## M5 — 分发与 Windows

- [ ] macOS 打包、签名、自动更新
- [ ] 引擎随桌面应用启动的进程管理（sidecar 或子进程托管）
- [ ] Windows 适配：WebView2、原生模块重编、路径与权限
- [ ] 跨平台 CI（mac + win 双平台构建与冒烟）

---

## 给协作智能体的取任务建议

1. 一次只推进一个有边界的小目标，完成即按 `CONVENTIONS.md` 验证。
2. 动 LLM/工具/存储能力时，保持抽象接口不变，新增实现而非改循环。
3. 接口/类型有变动，先改 `shared` 再联动两端。
4. 在本文勾选你完成的项，必要时拆出更细子任务。
