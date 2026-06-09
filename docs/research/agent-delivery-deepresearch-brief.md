# Deep Research 需求清单：Aurevoy Agent 真实落地可用

> 状态：待研究
> 创建日期：2026-06-09
> 用途：派发给另一个智能体做深度研究报告。报告完成后，再基于报告重写
> `docs/ROADMAP_AGENT_DELIVERY.md`。

## 1. 研究目标

当前 Aurevoy 已经完成基础架构、真实 LLM、ReAct 工具循环、审批、MCP、SQLite 轨迹、多轮对话、
长期记忆、任务恢复、设置和工具管理。现在需要回答：

**在现有代码实现基础上，下一阶段应如何把 Agent 功能真正落地到普通用户可用？**

研究报告必须同时覆盖：

- 现有实现事实：代码里已经真实具备什么能力。
- 可用性缺口：离“用户交给 Agent 一件事，Agent 交付结果”还缺什么。
- 外部最佳实践：2025-2026 年生产级 Agent 在工具、记忆、RAG、沙箱、评测、UI、权限方面的做法。
- 可执行建议：按 Aurevoy 当前 TypeScript + Fastify + Tauri + SQLite + MCP 架构给出落地顺序。

禁止只写泛泛的 Agent 趋势或产品愿景。每条建议都必须能映射到本仓库的文件、模块、API 或数据结构。

## 2. 研究前必须阅读的仓库资料

先读文档：

- `AGENTS.md`
- `start.md`
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/API.md`
- `docs/TECH_STACK.md`
- `docs/ENGINEERING_GOVERNANCE.md`
- `docs/CONVENTIONS.md`
- `docs/UI_DESIGN.md`
- `docs/ROADMAP.md`
- `docs/ROADMAP_AGENT_DELIVERY.md`
- `docs/research/agent-loop-brief.md`
- `docs/research/agent-loop-findings.md`

再读代码，不允许只读文档：

- `packages/shared/src/index.ts`
- `apps/agent/src/agent/loop.ts`
- `apps/agent/src/agent/context.ts`
- `apps/agent/src/agent/tool-call-accumulator.ts`
- `apps/agent/src/llm/provider.ts`
- `apps/agent/src/tools/registry.ts`
- `apps/agent/src/tools/builtins.ts`
- `apps/agent/src/tools/mcp.ts`
- `apps/agent/src/runtime/settings.ts`
- `apps/agent/src/sandbox/command-executor.ts`
- `apps/agent/src/store/db.ts`
- `apps/agent/src/server.ts`
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/lib/api.ts`
- `apps/desktop/src/components/Conversation.tsx`
- `apps/desktop/src/components/InspectorPanel.tsx`
- `apps/desktop/src/components/SettingsPanel.tsx`
- `apps/desktop/src/components/MemoryPanel.tsx`
- `apps/desktop/src/components/TaskHistorySidebar.tsx`
- `scripts/m3-regression.mjs`
- `scripts/m4-regression.mjs`
- `scripts/m5-regression.mjs`

## 3. 当前实现事实基线

研究报告需要核对并补充以下事实，不要无视现状重新设计。

### 3.1 已实现的后端能力

- 单 Agent ReAct 循环在 `apps/agent/src/agent/loop.ts`：
  - 真实调用 OpenAI-compatible Provider。
  - 支持流式 token、tool_calls、reasoning_content。
  - 支持最多 20 轮循环、重复工具调用限制、单轮工具数量限制。
  - 支持取消、LLM 重试、审批等待、审批超时。
- 工具注册表在 `apps/agent/src/tools/registry.ts`：
  - 工具统一注册、启停、风险等级查询、禁用后不可执行。
- 内置工具在 `apps/agent/src/tools/builtins.ts`：
  - `get_current_time`
  - `list_directory`
  - `read_file`
  - `write_file`
  - `http_fetch`
  - `remember`
- 文件工具已有工作区限制和 symlink 真实路径校验。
- `write_file` 是 `dangerous`，`http_fetch` 是 `caution`，会走审批。
- MCP stdio 接入在 `apps/agent/src/tools/mcp.ts`：
  - 启动/重载时发现 tools，注册到同一 registry。
  - 工具名稳定清洗，支持 server riskLevel 覆盖和 annotations 风险推断。
- SQLite 存储在 `apps/agent/src/store/db.ts`：
  - `tasks`
  - `task_traces`
  - `memories`
  - `app_settings`
  - `tool_settings`
- 多轮对话：
  - `POST /api/tasks/:id/messages`
  - 使用持久消息历史重新进入 loop。
- 任务恢复：
  - 启动时把遗留运行态任务标记为 failed。
  - `POST /api/tasks/:id/resume` 基于历史继续执行，并修补悬空 tool result。
- 长期记忆：
  - 用户 CRUD。
  - Agent 可通过 `remember` 写入。
  - 启用记忆作为 system message 注入。
- 运行设置：
  - Provider/Base URL/Model/API Key/temperature/timeout/workspace/MCP JSON/工具开关/清理策略。
  - 设置写入 SQLite 并影响下一轮真实运行。
- 命令执行：
  - 目前只有禁用执行器和策略边界，没有真实执行能力。

### 3.2 已实现的前端能力

- 主工作台在 `apps/desktop/src/App.tsx`。
- `Conversation.tsx` 能展示：
  - 用户目标。
  - assistant 回复。
  - 单步计划/运行状态。
  - 实时工具活动。
  - 审批按钮。
  - 历史 tool call / tool result。
- `InspectorPanel.tsx` 能展示：
  - 当前任务上下文。
  - 持久轨迹日志。
  - 工具目录。
  - 实时事件流。
- `SettingsPanel.tsx` 能管理真实设置、MCP、工具、数据。
- `MemoryPanel.tsx` 能管理长期记忆。
- `TaskHistorySidebar.tsx` 能展示历史任务和导航。

### 3.3 已有回归覆盖

- `scripts/m3-regression.mjs` 覆盖：
  - 直接回答、读文件、写文件审批、HTTP 审批、MCP 工具、取消。
  - 目录穿越、symlink 越界、审批拒绝/超时、非法 URL、未配置 Key。
  - 迟到 SSE、历史轨迹回看、命令执行默认关闭。
- `scripts/m4-regression.mjs` 覆盖：
  - 多轮对话、上下文压缩、任务恢复、记忆 CRUD、Agent 写记忆、记忆注入/禁用。
- `scripts/m5-regression.mjs` 覆盖：
  - 设置真实生效、Provider 缓存失效、工作区切换、工具启停、MCP 配置校验、数据清理。

### 3.4 明显未实现或不足

以下只是初步判断，研究报告必须通过代码核验：

- 没有任务产物模型：缺 `TaskArtifact`、artifact store、artifact API、前端产物面板。
- 没有任务 checkpoint 模型：任务恢复仍是基于全量消息历史重跑，不是按 checkpoint 继续。
- 计划仍是单步隐式计划：`runTask()` 当前用 `id: "exec"` 的单步 plan 承载工具轨迹。
- 没有主动追问/等待用户补充的结构化状态：`paused` 主要用于审批等待。
- 没有知识库/RAG：长期记忆是结构化短文本注入，不是文件索引或语义召回。
- `http_fetch` 是原始抓取，没有网页清洗、引用管理、来源结构、prompt injection 隔离。
- 命令/代码/浏览器自动化没有真实工具实现。
- 没有 trace grading、agent eval run、样例数据集或评分模型。
- 没有工具参数 schema runtime validation，只依赖 LLM 和工具内部检查。
- 没有工具/任务预算的共享契约和 UI。
- 没有成本/token 使用记录，trace 中 `tokenUsage` 当前写 `null`。

## 4. 需要外部调研的问题

请把我的需求转换成英文查询互联网、官方文档、权威实现和近期工程文章；最终报告用中文。
优先官方文档和一手资料，不要依赖二手营销文。

### 4.1 生产级 Agent 任务模型

研究问题：

- 个人 Agent 应如何建模 task / objective / plan / checkpoint / artifact / user question / approval？
- OpenAI Agents、Anthropic、LangGraph、AutoGen、CrewAI、Vercel AI SDK 等对任务状态和可回放 trace 如何组织？
- 对 Aurevoy 当前 `Task`、`PlanStep`、`Message`、`TaskTraceEntry`，建议增加哪些最小字段？
- 是否应该拆分 SQLite 表：`messages`、`plan_steps`、`artifacts`、`checkpoints`、`eval_runs`？

输出要求：

- 给出推荐数据模型草案。
- 给出需要修改的 shared 类型和 API 端点。
- 给出从当前 JSON 列迁移到结构化表的优先级，不要一次性大重构。

### 4.2 任务产物与本地文件交付

研究问题：

- Agent 生成的文件、报告、截图、stdout、diff、网页快照如何作为 artifact 管理？
- artifact 应存 SQLite、文件系统，还是混合存储？
- 产物如何和 trace、工具调用、最终回复建立关联？
- 写入真实用户文件前应该如何设计草稿、预览、审批和覆盖策略？

输出要求：

- 给出 Aurevoy 的 artifact store 方案。
- 给出 `write_file` 如何从覆盖式写入演进到“草稿产物 -> 用户确认 -> 应用写入”。
- 给出前端 artifact 面板的信息架构。

### 4.3 主动追问与用户参与

研究问题：

- Agent 什么时候应该追问而不是继续猜？
- 追问是作为 tool、task phase、message 类型，还是独立 checkpoint？
- 用户回复后如何从暂停状态继续，如何避免丢失上下文？
- 如何区分 approval、clarification、confirmation、credential/setup missing？

输出要求：

- 给出 Aurevoy 的状态机建议。
- 给出 API 和 SSE 事件建议。
- 给出前端交互建议。

### 4.4 工具治理与安全

研究问题：

- 生产 Agent 如何做工具 schema validation、参数净化、风险分级和审批？
- MCP 工具如何覆盖或继承风险等级？如何处理 MCP prompt injection 和恶意 tool description？
- 网络抓取工具如何防 SSRF、内网探测、超大响应、重定向风险、HTML 注入到 prompt？
- 文件工具如何处理 delete/move/rename/search 等新增能力的风险等级？

输出要求：

- 给出工具治理矩阵：工具类别、风险等级、默认开关、审批策略、回归用例。
- 给出应该引入的 schema validation 方案，尽量符合当前 TS 技术栈。
- 给出 `http_fetch` 的安全改造清单。

### 4.5 本地自动化与沙箱

研究问题：

- 个人桌面 Agent 是否应优先做命令执行、代码执行、浏览器自动化，还是文件/网页/RAG？
- Node/Tauri 桌面应用中命令执行如何实现隔离、取消、超时、输出上限、环境变量 allowlist？
- 浏览器自动化应该通过 MCP、Playwright sidecar，还是系统浏览器控制？
- 哪些动作必须默认关闭或逐次审批？

输出要求：

- 给出分阶段开放策略。
- 给出 command executor 的实现选型建议。
- 给出最小可用工具集和安全边界。

### 4.6 知识库、长期记忆与 RAG

研究问题：

- 个人 Agent 的长期记忆和本地知识库应该如何分层？
- 什么时候需要 embedding / sqlite-vec / LanceDB / 外部向量库？
- 文件索引如何处理权限、隐私、增量更新、来源引用和删除？
- Agent 写入记忆是否应该默认自动、候选确认，还是规则触发？

输出要求：

- 给出 Aurevoy 的 memory + knowledge base 分层架构。
- 给出是否引入向量检索的门槛和最小方案。
- 给出索引表、召回 API、前端来源展示建议。

### 4.7 Agent 评测、trace grading 与发布门槛

研究问题：

- 如何为个人 Agent 建立可复现任务集？
- trace grading 应评分哪些维度？
- 如何评估工具选择、参数正确性、审批合规、最终产物质量？
- 如何在本地回归脚本中集成 LLM judge 或规则评分，同时避免测试不稳定？

输出要求：

- 给出 `regression:agent-usability` 的任务集结构。
- 给出 eval run / score 数据模型。
- 给出 smoke、regression、release 三层发布门槛。

### 4.8 UI / HCI：个人 Agent 工作台

研究问题：

- 用户如何理解 Agent 正在做什么、为什么卡住、接下来要他做什么？
- 任务产物、来源、审批、追问、恢复、设置问题应该如何放在工作台里？
- 如何避免把 UI 做成普通聊天，而是目标执行工作台？
- 任务历史应该如何支持搜索、筛选、恢复、问题报告？

输出要求：

- 给出对现有 `Conversation`、`InspectorPanel`、`SettingsPanel`、`TaskHistorySidebar` 的改造建议。
- 给出首个最小切片的 UI 验收标准。

### 4.9 Provider 与模型能力适配

研究问题：

- OpenAI-compatible Provider 在 tool calling、reasoning_content、structured output、token usage 上有哪些差异？
- DeepSeek、OpenAI、Ollama、LM Studio、vLLM 对工具调用和 usage 记录的现实兼容性如何？
- 是否需要引入 structured output / JSON mode 来做计划、追问、评分？

输出要求：

- 给出 provider compatibility matrix。
- 给出 Aurevoy Provider 抽象是否需要扩展。
- 给出 token usage / cost 记录方案。

## 5. 报告格式要求

请输出一份 Markdown 报告，建议文件名：

```text
docs/research/agent-delivery-deepresearch-report.md
```

必须包含以下章节：

1. 执行摘要：3-5 条最重要结论。
2. 当前实现盘点：按后端、前端、存储、回归列出证据，引用具体文件路径。
3. 关键差距：按影响用户可用性的优先级排序。
4. 外部最佳实践：每条结论附链接和适用边界。
5. 推荐目标架构：任务模型、产物、追问、工具治理、知识库、评测、UI。
6. 分阶段落地计划：短期 2 周、中期 1-2 月、长期。
7. 首个纵向切片建议：建议从哪个任务场景开始，为什么。
8. 数据模型与 API 草案：TypeScript 类型、SQLite 表、HTTP/SSE 端点。
9. 风险清单：安全、隐私、跨平台、模型兼容、实现复杂度。
10. 验收标准：每阶段可运行命令、回归用例和用户可见结果。
11. 参考资料：官方文档或权威实现链接。

## 6. 研究方法要求

- 先从本仓库代码建立事实基线，再做外部调研。
- 外部调研必须使用英文关键词搜索，但报告用中文写。
- 优先引用官方文档：
  - OpenAI Agents / Evals / Tracing / Guardrails / MCP
  - Anthropic MCP / tool use / agent patterns
  - LangGraph / LangSmith / AutoGen / CrewAI / Vercel AI SDK 官方资料
  - Tauri / Playwright / Node child_process 安全相关官方资料
- 对非官方文章，只提炼工程经验，不作为唯一依据。
- 明确区分：
  - 已实现
  - 代码已有边界但未启用
  - 需要小改
  - 需要架构变更
  - 暂不建议做

## 7. 不要做的事

- 不要把多 Agent 作为近期主线，除非报告能证明单 Agent 已到瓶颈。
- 不要建议引入重型框架而不说明替换成本。
- 不要建议 mock connector、静态 UI 或演示数据。
- 不要忽略本地优先、SQLite、Tauri、OpenAI-compatible、MCP、审批这些既有约束。
- 不要只给产品想法；必须落到代码模块、数据结构、API 和测试。

## 8. 最终交付验收

报告合格标准：

- 能让后续智能体据此重写 `docs/ROADMAP_AGENT_DELIVERY.md`。
- 每个建议都能回指到当前代码或明确指出需要新增的模块。
- 至少列出 10 个可复现的 Agent 用户任务样例。
- 至少给出 5 条高风险能力的审批/沙箱/回归方案。
- 至少给出一个纵向切片的端到端实现计划。
- 不需要立即写代码，但要足够具体到可以拆任务。

