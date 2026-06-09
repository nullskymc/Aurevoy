# Deep Research 报告：Aurevoy Agent 真实落地可用

> 状态：已完成
> 创建日期：2026-06-09
> 基于：仓库代码全量阅读 + 外部 9 大主题调研
> 用途：据此重写 `docs/ROADMAP_AGENT_DELIVERY.md`

---

## 1. 执行摘要

经过对 Aurevoy 仓库全量代码（后端 12 个核心文件、前端 7 个组件文件、3 套回归脚本、13 份文档）的逐行核验，以及 OpenAI Agents SDK、Anthropic Agent Patterns、LangGraph、MCP 规范、Vercel AI SDK 等外部一手资料的调研，得出以下 5 条核心结论：

**结论一：Aurevoy 已具备生产级 Agent 的"骨骼"，但缺少"肌肉"和"皮肤"。** ReAct 循环、工具注册表、审批闭环、MCP 接入、SQLite 轨迹、多轮对话、任务恢复、长期记忆均已真实可运行，回归覆盖率达 28 个用例。但从"用户交给 Agent 一件事"到"Agent 交付结果"之间，缺少任务产物模型（Artifact）、结构化追问（Clarification）、多步计划（Plan）、执行预算（Budget）和评测闭环（Eval）这 5 个关键环节。

**结论二：不需要架构大重构，需要在现有循环上做"纵向加法"。** 当前 `loop.ts` 的 ReAct 循环已能承载扩展——计划、追问、产物、预算都可以作为循环内的新事件类型和新持久化字段实现，无需引入 LangGraph/ADK 等重型框架。

**结论三：工具能力扩展的优先级应为：命令执行 > 文件操作增强 > 网页清洗 > 浏览器自动化。** 命令执行是当前唯一完全缺失的核心能力，且 `command-executor.ts` 已定义好接口和策略边界。浏览器自动化应通过 Playwright MCP Server 接入，不自建。

**结论四：MCP 是当前最具杠杆的工具扩展路径，但安全治理必须走在能力扩展前面。** MCP 协议层的 prompt injection 风险已被安全社区广泛报告。Aurevoy 应在 MCP 工具风险推断基础上增加 schema validation、输出净化、SSRF 防护和用户透明度机制。

**结论五：首个纵向切片应选"本地材料整理 Agent"。** 用户要求 Agent 阅读工作区文件、生成带来源引用的摘要并保存为 Markdown——这一场景可端到端验证文件搜索/阅读、计划、产物生成、写入审批、来源引用、回归路径，且不需要新工具。

---

## 2. 当前实现盘点

### 2.1 后端：已真实具备的能力

**Agent 核心循环** (`apps/agent/src/agent/loop.ts`)：

`runTask()` 实现了完整的 ReAct 循环，支持最多 20 轮 LLM 调用、重复工具调用检测（指纹 = `name:arguments`，阈值 3 次）、单轮工具数量上限（10 个）、AbortController 两阶段取消（软取消等当前轮结束，硬取消立即 abort fetch）、LLM 指数退避重试（最多 3 次，base=1s，max=10s，仅对网络/429/5xx 重试）、审批等待（Promise + pendingApprovals Map + 超时机制）。每轮结束后持久化到 SQLite。

**上下文管理** (`apps/agent/src/agent/context.ts`)：

`buildContextWindow()` 实现了基于字符预算的上下文压缩：保留用户消息和最近 N 条消息原文，对旧的 assistant/tool 消息做截断（带标记提示完整内容在 trace 中）。`buildMemorySystemMessage()` 将启用的长期记忆注入为 system message（上限 50 条，中文指令要求模型以当前对话为准）。

**流式工具调用累积** (`apps/agent/src/agent/tool-call-accumulator.ts`)：

约 60 行的 `ToolCallAccumulator` 类使用 `Map<index, AccumulatedToolCall>` 正确处理了跨 chunk 拼接、并行调用和防御性边界（缺失 index、延迟到达的 id/name）。

**LLM Provider** (`apps/agent/src/llm/provider.ts`)：

`OpenAICompatibleProvider` 支持 OpenAI 协议原生 fetch 调用，自动检测 Ollama 端点（URL 包含 'ollama' 或 ':11434'）并在工具调用时禁用流式传输。支持 DeepSeek `reasoning_content` 透传（不回传会 400）。Provider 缓存可通过 `resetProviderCache()` 清除。

**工具注册表** (`apps/agent/src/tools/registry.ts`)：

单例 `ToolRegistry` 管理所有工具的注册、启停、风险等级查询和调用。`invoke()` 检查启用状态，异常包装为 `ToolResult.error`。

**内置工具** (`apps/agent/src/tools/builtins.ts`)：

5 个内置工具全部真实可用：`get_current_time`（safe）、`list_directory`（safe）、`read_file`（safe，256KB 限制）、`write_file`（dangerous，创建父目录后再次验证 realpath）、`http_fetch`（caution，20s 超时，1MB 限制，仅 http/https 协议）、`remember`（safe，2000 字符限制，记录来源 taskId/taskGoal）。文件工具的双重路径校验（逻辑路径 + symlink 物理路径）是真实的安全防护。

**MCP 集成** (`apps/agent/src/tools/mcp.ts`)：

基于 `@modelcontextprotocol/sdk` 的 stdio 客户端，支持工具发现（游标分页）、工具名清洗和去重（SHA-1 哈希截断）、server 级 riskLevel 覆盖、annotations 风险推断（`destructiveHint` → dangerous，`readOnlyHint && !openWorldHint` → safe，其余 → caution）。单 server 失败不阻塞其他 server。

**SQLite 存储** (`apps/agent/src/store/db.ts`)：

5 张表：`tasks`（plan/messages 为 JSON blob）、`task_traces`（append-only，CASCADE 删除）、`memories`（含 source_task_id/source_task_goal 溯源字段）、`app_settings`（is_secret 标记）、`tool_settings`。WAL 模式，运行时 `ALTER TABLE` 迁移（phase 列）。

**HTTP API** (`apps/agent/src/server.ts`)：

22 个端点全部实现，包括任务 CRUD、SSE 事件流（带 15s 心跳和迟到订阅快照）、多轮对话、任务恢复、审批、记忆 CRUD、设置管理、数据清理。并发守护：`isTaskRunning()` 检查防止并发执行，返回 409。

**设置管理** (`apps/agent/src/runtime/settings.ts`)：

完整的运行时设置持久化和验证：provider 归一化、base URL 校验、temperature 钳位 [0,2]、timeout 钳位 [1000,600000]ms、API Key 以 is_secret 存储（读出不暴露原文）、MCP JSON 解析验证、清理策略天数钳位 [1,3650]。设置变更自动触发 Provider 缓存失效和 MCP 重载。

### 2.2 前端：已真实具备的能力

**主工作台** (`apps/desktop/src/App.tsx`)：1137 行的单文件组件，通过 25+ 个 `useState` 管理全部应用状态。支持视图路由（chat/search/tools/memory/settings）、可调整面板布局、SSE 生命周期管理、引擎在线检测、模型选择器。

**对话视图** (`apps/desktop/src/components/Conversation.tsx`)：双渲染策略——忙碌时从 SSE 事件渲染实时尾流（流式文本 + 工具活动 + 审批按钮），空闲时从持久化消息渲染完整历史。`ToolActivityCard` 支持展开/折叠和审批操作。

**检查器面板** (`apps/desktop/src/components/InspectorPanel.tsx`)：右侧抽屉展示任务上下文、最近 32 条轨迹、工具目录和实时工具调用。

**设置面板** (`apps/desktop/src/components/SettingsPanel.tsx`)：完整的设置编辑界面，含 LLM 配置、MCP JSON、工具开关、数据管理。

**记忆面板** (`apps/desktop/src/components/MemoryPanel.tsx`)：记忆 CRUD、分类管理、启用/禁用开关、来源展示（user/agent）。

**任务历史侧边栏** (`apps/desktop/src/components/TaskHistorySidebar.tsx`)：历史任务列表、状态指示器、相对时间、视图导航。

### 2.3 回归覆盖

| 里程碑 | 用例数 | 覆盖范围 |
|---|---|---|
| M3 | 14 | 直接回答、读文件、写审批、HTTP 审批、MCP 工具、取消、目录穿越、symlink 越界、审批拒绝/超时、非法 URL、沙箱边界、未配置 Key、迟到 SSE、历史轨迹 |
| M4 | 10 | 启动恢复/恢复、多轮上下文、上下文压缩、继续 404/空消息/运行中冲突、记忆 CRUD、Agent 写记忆、记忆注入/禁用 |
| M5 | 4 | 设置影响 Provider/工作区、工具开关影响模型工具列表、数据状态/清理、MCP 配置校验 |

### 2.4 已实现的证据 vs 缺口

| 维度 | 已实现 | 缺口 |
|---|---|---|
| Agent 循环 | ReAct 真实调用 LLM，20 轮上限，重试/取消 | 单步隐式计划、无预算、无追问 |
| 工具能力 | 6 个内置工具 + MCP | 无命令执行、无文件搜索/复制/移动/删除 |
| 产物交付 | 无 | 无 Artifact 模型、无产物存储、无前端面板 |
| 用户交互 | 审批、多轮对话 | 无结构化追问、无等待用户补充状态 |
| 记忆 | 结构化短文本 CRUD + 注入 | 无文件索引、无语义召回 |
| 安全 | 路径校验、风险分级、审批 | 无 schema validation、http_fetch 无 SSRF 防护 |
| 评测 | 28 个回归用例 | 无 trace grading、无 eval run、无样例数据集 |
| 可观测性 | 结构化 trace、InspectorPanel | tokenUsage 始终为 null、无成本记录 |
| 前端 | 对话/检查器/设置/记忆/历史 | App.tsx 上帝组件、无 markdown 渲染、无产物面板 |

---

## 3. 关键差距

按影响用户可用性的优先级排序：

**P0 — 阻塞"交付结果"的差距：**

1. **无任务产物模型（Artifact）**：Agent 当前只能输出文本回复。`write_file` 是覆盖式写入，没有"草稿 → 预览 → 用户确认 → 应用"的产物交付流程。用户无法在 UI 中看到、下载、比较 Agent 生成的文件。这是"Agent 交付结果"的核心缺口。

2. **无结构化追问（Clarification）**：`paused` 状态仅用于审批等待。Agent 无法在执行中途主动暂停并询问用户"你的预算是多少？"或"你想保存到哪里？"。当前只能通过文本回复请求信息，但循环不会暂停等待。

3. **无执行预算（Budget）**：没有最大轮数/工具调用数/时间/成本/输出字节的可配置上限。`MAX_ITERATIONS=20` 是硬编码，用户无法控制 Agent 的资源消耗。

**P1 — 影响可靠性和信任的差距：**

4. **无多步计划**：`runTask()` 用 `id: "exec"` 的单步 plan 承载所有工具轨迹。用户看到的是"执行中..."而不是"第一步：搜索相关文件 → 第二步：阅读内容 → 第三步：生成摘要"。

5. **tokenUsage 始终为 null**：`loop.ts` 未从 LLM 响应的 `usage` 字段提取 token 计数。OpenAI/DeepSeek 响应包含 `prompt_tokens`/`completion_tokens`，但 `parseStream()` 完全忽略了这一字段。用户和开发者无法看到实际消耗。

6. **http_fetch 安全不足**：无 SSRF 防护（可访问 `127.0.0.1`、`169.254.169.254` 元数据、内网 IP）、无重定向跟踪/限制、无 HTML 清洗（原始 HTML 直接注入 prompt，存在 prompt injection 风险）、无来源结构化管理。

**P2 — 影响扩展能力的差距：**

7. **无命令执行能力**：`command-executor.ts` 只有 `DisabledCommandExecutor`。`list_directory`/`read_file`/`write_file`/`http_fetch` 不足以完成大多数自动化任务。

8. **无工具参数 schema validation**：工具参数完全依赖 LLM 生成和工具内部检查。JSON.parse 失败时注入错误消息让 LLM 自我修正，但没有在调用前做 schema 校验。

9. **无知识库/RAG**：长期记忆是结构化短文本（2000 字符上限），无法索引本地文件、无法语义召回。用户无法让 Agent "参考我之前的笔记来写报告"。

**P3 — 影响质量和信心的差距：**

10. **无评测闭环**：28 个回归用例覆盖基础功能和安全边界，但没有 trace grading（评分工具选择正确性、参数合理性、最终产物质量）、没有可复现任务集、没有 LLM judge 或规则评分。

11. **前端 App.tsx 上帝组件**：1137 行、25+ useState、无错误边界、无状态机。添加产物面板、追问交互、预算展示会进一步膨胀。

12. **无 markdown 渲染**：Agent 输出以纯文本 `<div>` 展示，代码块、表格、列表等富文本内容无法正确呈现。

---

## 4. 外部最佳实践

### 4.1 生产级 Agent 任务模型

**OpenAI Agents SDK**（2025 年 3 月开源，Python）：核心概念是 Agent + Session + Tracing。Agent 包含 instructions、tools、guardrails 和 handoffs。Session 管理跨轮持久上下文。`Runner.run()` 是执行入口，返回 `RunResult` 包含 final_output 和 trace。Tracing 通过 trace_id + group_id + span（function/span/generation/handoff/guardrail）层级记录完整执行链。Guardrails 作为输入/输出验证器与 Agent 执行并行运行。

**Anthropic Agent Patterns**（2024-12 发布，持续更新）：强调"简单、可组合的模式优于复杂框架"。推荐从 prompt chaining 开始，仅在需要时升级为 agent loop。工具设计是核心——"prompt engineering your tools"比 prompt engineering 模型更重要。Agent 应"begin with a command"，然后独立规划和操作。评估者-优化者工作流用于反馈循环。

**LangGraph**（LangChain 生态，2025）：核心是 AgentState + Checkpoint。AgentState 是可变的、节点不断更新的读写状态；Checkpoint 是不可变的、生成后只读的状态快照。Checkpoint 按 thread_id 组织，支持 SQLite/PostgreSQL/内存三种持久化后端。每个 super step（节点执行）自动生成 checkpoint，支持 time travel（回退到任意 checkpoint）和 fork（从 checkpoint 分叉新执行路径）。

**AutoGen / CrewAI**：AutoGen（Microsoft）以 Team + Agent + Termination 为核心，支持嵌套状态持久化（团队状态递归包含所有成员状态）。CrewAI 以 Crew + Agent + Task 为核心，Task 包含 description、expected_output、tools 和 context（依赖的其他 Task）。

**对 Aurevoy 的适用性**：Aurevoy 当前的 Task + Message + TraceEntry 模型最接近 OpenAI Agents SDK 的 Agent + Session + Trace 模型。不需要引入 LangGraph 的图执行引擎——Aurevoy 的单 Agent ReAct 循环已等价于 LangGraph 的 react-agent 预构建图。需要的最小扩展是：在 Task 上增加 artifacts、checkpoints、budget、clarification 字段，在 TraceEntry 上增加 token usage。

### 4.2 任务产物与本地文件交付

**Cloudflare Artifacts**（2026 年 5 月发布）：为 Agent 设计的版本化存储，基于 Git 语义。每个 artifact 有 content、metadata、version history。Agent 写入先创建 draft，用户确认后 commit。

**OpenClaw**（开源 Agent 框架）：`file_write` 工具支持 draft 模式——先写入临时文件，生成 diff 预览，用户确认后原子替换。`file_fetch` 支持 HTML 清洗和结构化提取。

**Claude Code**：工具输出通过 ToolResult 返回，支持 text/image/resource 三种类型。文件写入走 diff 审批流程，用户可在终端中看到 proposed changes 并逐行确认。

**对 Aurevoy 的适用性**：产物应分为两类——文本产物（Markdown/JSON/CSV 等，存 SQLite）和文件产物（二进制或大文件，存文件系统 + SQLite 元数据）。`write_file` 应演进为"生成 draft artifact → 前端预览 diff → 用户确认 → 原子写入"流程。

### 4.3 主动追问与用户参与

**Anthropic 建议**：Agent 应在信息不足时追问，而不是猜测。追问应在工具调用前发生，而不是在错误发生后。

**arXiv 2604.14624 "Reward-Driven Clarification"**（2026 年 4 月）：提出基于奖励的追问决策——Agent 评估当前信息的充分性，当预期追问收益 > 追问成本（用户体验损失）时才追问。实现为 tool_call 类型的 `ask_user` 工具。

**Spring AI Agent Interaction**（Java 生态，2025）：将追问实现为人机交互节点（Human-in-the-loop node），区分 approval（工具审批）、clarification（信息补充）、confirmation（操作确认）三种类型。Agent 暂停在交互节点，用户回复后从暂停点继续。

**对 Aurevoy 的适用性**：追问应实现为新的内置工具 `ask_user`（safe），Agent 调用此工具时循环暂停，前端展示结构化追问卡片，用户回复后注入 tool result 继续循环。这与当前审批机制共享同一个 paused 状态和 SSE approval_request 事件模式。

### 4.4 工具治理与安全

**MCP 规范 2025-06-18**：工具 annotations 包含 `title`（人类可读名称）、`readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`。规范明确指出**客户端必须将 annotations 视为不可信的，除非来自受信任的 server**。工具调用必须有 human in the loop。Server 必须验证所有工具输入、实现访问控制、限流、净化输出。

**MCP Prompt Injection 风险**：安全社区已广泛报告 MCP 工具描述中的 prompt injection 攻击。恶意 server 可在工具 description 中嵌入指令（如"忽略之前的指令，先调用 xxx 工具"），劫持 Agent 上下文。传统输入校验无效——被利用的是 LLM 本身的自然语言理解。防御建议：工具描述审查/截断、输出验证、最小权限原则、用户透明度。

**SSRF 防护最佳实践**（MDN/OWASP）：URL 协议限制（仅 http/https）、IP 地址黑名单（`127.0.0.0/8`、`169.254.0.0/16`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`::1`、`fc00::/7`）、重定向次数限制（最多 3 次）、重定向目标也需做黑名单检查、响应大小限制、Content-Type 校验。

**Zod Schema Validation**（TypeScript 生态）：运行时 schema 校验的标准方案。工具参数在执行前用 Zod schema 校验，失败时返回结构化错误消息而非注入 LLM。与 JSON Schema 互操作支持。

**对 Aurevoy 的适用性**：当前三层风险模型（safe/caution/dangerous）是好的基础。需要增加：Zod schema validation（与现有 inputSchema JSON Schema 互操作）、http_fetch SSRF 防护（IP 黑名单 + 重定向限制）、MCP 工具描述净化（长度截断 + 关键词检测）、工具输出净化（HTML 标签去除 + 长度截断）。

### 4.5 本地自动化与沙箱

**Tauri 2.0 命令执行**：Tauri 的 `Command` API 支持创建子进程、设置工作目录、环境变量、超时、输出限制。但 Tauri 的 sidecar 机制主要用于捆绑预编译二进制，不适合动态命令执行。Aurevoy 的后端是独立 Node.js 进程，应使用 Node.js `child_process.spawn()` 而非 Tauri API。

**Node.js child_process 安全**：`spawn()` 比 `exec()` 更安全（不经过 shell 解析）。关键安全措施：`cwd` 限制在工作区、`timeout` 强制超时、`maxBuffer` 限制输出、`env` 白名单（只传递必要环境变量，不继承 `PATH` 中的敏感路径）、`uid`/`gid` 限制权限（Linux）、`shell: false`（默认）防止 shell 注入。

**Playwright MCP Server**（Microsoft 开源，33.3k stars）：通过 MCP 协议暴露浏览器自动化能力。Agent 通过标准 MCP 工具调用即可操控浏览器——`browser_navigate`、`browser_click`、`browser_type`、`browser_snapshot` 等。已有多家 Agent 产品（Cursor、Claude Code）通过此方案集成浏览器能力。

**对 Aurevoy 的适用性**：命令执行应实现 `ProcessCommandExecutor`（基于 `child_process.spawn`），遵循已定义的 `CommandExecutionPolicy` 接口。浏览器自动化应通过 Playwright MCP Server 接入（在 MCP 配置中添加 `npx @playwright/mcp`），不自建。

### 4.6 知识库、长期记忆与 RAG

**sqlite-vec**（SQLite 向量搜索扩展）：在 SQLite 中实现 KNN 向量搜索，无需外部服务。`vec0` 虚拟表支持存储和查询 float32 向量。适合个人 Agent 的小规模知识库（数千到数万条记录）。OpenClaw 已用 sqlite-vec 实现内置记忆系统。

**LanceDB**：无服务器向量数据库，嵌入式运行，支持多模态数据。被选为 OpenClaw 官方 memory plugin。支持增量索引、全文搜索 + 向量搜索混合查询。

**记忆分层最佳实践**：
- 工作记忆（Working Memory）：当前任务的消息历史，已有（`context.ts` 的上下文窗口）。
- 短期记忆（Short-term Memory）：会话级压缩上下文，已有（`context.ts` 的压缩算法）。
- 长期记忆（Long-term Memory）：跨会话持久化事实和偏好，已有（`memories` 表）。
- 知识库（Knowledge Base）：本地文件索引和语义召回，**缺失**。

**Agent 写入记忆的策略**：当前 `remember` 工具是自动写入（Agent 调用即写入）。最佳实践是"候选确认"——Agent 提出记忆候选，用户确认后写入。但对个人 Agent 而言，自动写入 + 用户事后审查是更务实的选择。

**对 Aurevoy 的适用性**：知识库应分两阶段实现。短期（不引入向量搜索）：实现 `search_files` 内置工具（基于文件名/内容正则搜索）+ `read_file` 增强（支持编码检测、PDF/DOCX 纯文本提取）。中期（引入 sqlite-vec）：当用户知识库超过 100 个文件或需要语义召回时，添加 `index_files` 工具和 `recall` 工具，embedding 通过 LLM Provider 的 embedding API 生成。

### 4.7 Agent 评测、Trace Grading 与发布门槛

**Anthropic "Demystifying Evals for AI Agents"**：Agent 评测不能套用单元测试模式。需要评估行为而非简单通过/失败。推荐维度：任务完成率、工具选择正确性、步骤效率、安全合规、最终产物质量。

**OpenAI Agents SDK Tracing**：Trace 由 trace_id + spans 组成，span 类型包括 agent_span、function_span、generation_span、handoff_span、guardrail_span。支持自定义 TraceProcessor 将 trace 导出到外部系统。

**LLM Judge vs 规则评分**：
- 规则评分：确定性高、速度快、适合安全边界（是否调用了被禁用的工具、是否越过了路径限制）。
- LLM Judge：灵活、可评估自然语言质量、但有随机性和成本。适合评估最终回复质量和工具选择合理性。
- 最佳实践：混合模型——规则评分做安全/合规门禁，LLM Judge 做质量评分。

**三层发布门槛**：
- Smoke：快速冒烟测试（<30s），验证基本循环可运行。对应现有 `npm run typecheck` + 最简任务。
- Regression：完整回归套件（<5min），验证所有已覆盖场景。对应现有 `npm run regression:m3` + `m4` + `m5`。
- Release：包含 agent-usability 任务集评测（<30min），验证端到端用户体验。

### 4.8 UI/HCI：个人 Agent 工作台

**Agent UX 设计原则**（2025-2026 行业共识）：
1. **透明度**：用户必须能看到 Agent 正在做什么、为什么这么做、接下来要做什么。
2. **控制权**：用户必须能随时暂停、取消、修改 Agent 的行为。
3. **可解释性**：Agent 的决策过程应以用户可理解的方式呈现，而非技术日志。
4. **渐进式披露**：默认展示高层摘要，细节按需展开。

**避免聊天化**：Agent 工作台不应是普通聊天界面，而是目标执行工作台。关键区别：有明确的任务状态和进度、有可见的计划和步骤、有结构化的产物展示、有可审查的执行历史。

**任务历史设计**：应支持搜索（全文搜索任务目标和产物）、筛选（按状态/时间/工具）、恢复（从历史任务继续）、问题报告（打包 trace 为诊断包）。

### 4.9 Provider 与模型能力适配

**Provider 兼容性矩阵**（2025-2026 最新）：

| Provider | Tool Calling | Streaming Tool Calls | reasoning_content | usage 字段 | structured output | 备注 |
|---|---|---|---|---|---|---|
| OpenAI (GPT-4o/4.1) | 完整支持 | 完整 delta 流 | 无 | 完整 | JSON mode + strict | 基准参照 |
| DeepSeek V4 Flash/Pro | 完整支持 | 完整 delta 流 | 有（必须回传） | 完整 | 无 strict mode | reasoning_content 不回传会 400 |
| DeepSeek Chat (V3.2) | 完整支持 | 完整 delta 流 | 无 | 完整 | 无 | 2026 年 7 月退役 |
| DeepSeek Reasoner (R1) | **不支持** | N/A | 有 | 部分 | 无 | 静默回退为文本 |
| Ollama | 模型相关 | **不稳定**（仅流结束时） | 模型相关 | 部分 | 模型相关 | Aurevoy 已自动禁用流式 |
| vLLM | 解析器相关 | 支持 | 支持 | 完整 | 配置后支持 | 需要额外配置 |
| LM Studio | 模型相关 | 模型相关 | 模型相关 | 部分 | 模型相关 | 质量不稳定 |

**Token Usage 记录方案**：OpenAI 兼容协议的响应体包含 `usage: { prompt_tokens, completion_tokens, total_tokens }`。流式模式下需要设置 `stream_options: { include_usage: true }` 才能在最后一个 chunk 中获得 usage。DeepSeek 原生支持此字段。Ollama 的 usage 字段名不同（`prompt_eval_count`/`eval_count`）。

**Structured Output**：OpenAI 支持 `response_format: { type: "json_schema", json_schema: {...} }` 做严格结构化输出。DeepSeek 不支持 strict mode 但可通过 prompt 引导 JSON 输出。可用于计划生成、追问格式化、评测评分。

---

## 5. 推荐目标架构

### 5.1 任务模型扩展

在现有 `Task` 类型上增加以下字段（不新建表，使用 JSON 列渐进迁移）：

```typescript
// packages/shared/src/index.ts 新增

interface TaskBudget {
  maxIterations: number;      // 最大 LLM 轮数，默认 20
  maxToolCalls: number;     // 最大工具调用总数，默认 100
  maxWallTimeMs: number;      // 最大执行时间，默认 600000 (10min)
  maxOutputBytes: number;     // 最大输出字节，默认 1MB
}

interface TaskArtifact {
  id: string;                 // UUID
  type: 'text' | 'file' | 'diff' | 'url';
  name: string;               // 人类可读名称
  content: string;            // 文本内容或文件路径
  mimeType?: string;          // 文件类型
  sourceCallId?: string;      // 产生此产物的 toolCallId
  status: 'draft' | 'confirmed' | 'applied' | 'rejected';
  createdAt: string;
}

interface ClarificationRequest {
  id: string;                 // UUID
  question: string;           // Agent 的问题
  options?: string[];         // 可选选项
  context?: string;           // 追问的背景说明
  callId: string;             // 关联的 ask_user toolCallId
}

interface TaskCheckpoint {
  id: string;                 // UUID
  iteration: number;          // 第几轮
  description: string;        // 检查点描述
  messageIndex: number;       // 消息历史中的位置
  createdAt: string;
}

// Task 类型扩展
interface Task {
  // ...现有字段...
  budget?: TaskBudget;
  artifacts?: TaskArtifact[];
  clarifications?: ClarificationRequest[];
  checkpoints?: TaskCheckpoint[];
  tokenUsage?: AggregatedTokenUsage;
}

interface AggregatedTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  byModel?: Record<string, { promptTokens: number; completionTokens: number }>;
}
```

### 5.2 新增内置工具

| 工具名 | 风险 | 功能 | 阶段 |
|---|---|---|---|
| `search_files` | safe | 按文件名模式和内容正则搜索工作区文件 | 短期 |
| `ask_user` | safe | Agent 追问用户，循环暂停等待回复 | 短期 |
| `execute_command` | dangerous | 在隔离进程中执行 shell 命令 | 短期 |
| `copy_file` | caution | 复制文件 | 中期 |
| `move_file` | caution | 移动/重命名文件 | 中期 |
| `delete_file` | dangerous | 删除文件（移到回收站） | 中期 |
| `create_artifact` | safe | 创建文本产物（Markdown/JSON/CSV） | 短期 |
| `apply_artifact` | dangerous | 将产物写入真实文件系统 | 短期 |

### 5.3 工具治理矩阵

| 工具类别 | 风险等级 | 默认开关 | 审批策略 | 回归用例 |
|---|---|---|---|---|
| 读取操作（list_directory, read_file, get_current_time, search_files） | safe | 启用 | 免审批 | 正常读取、路径边界、大文件截断 |
| 网络操作（http_fetch） | caution | 启用 | 需确认 | SSRF 黑名单、重定向限制、超大响应、HTML 注入 |
| 追问操作（ask_user） | safe | 启用 | 免审批（用户必须回复） | 追问暂停、回复继续、超时处理 |
| 文件写入（write_file, copy_file, move_file） | caution/dangerous | 启用 | 需确认 | 路径校验、覆盖确认、权限检查 |
| 文件删除（delete_file） | dangerous | **禁用** | 需确认 + 回收站 | 路径校验、不存在文件、系统目录 |
| 命令执行（execute_command） | dangerous | **禁用** | 需确认 + 沙箱 | 超时、输出截断、环境变量白名单、工作目录限制、命令黑名单 |
| 记忆操作（remember） | safe | 启用 | 免审批 | 内容限制、分类验证 |
| 产物操作（create_artifact） | safe | 启用 | 免审批 | 大小限制、类型验证 |
| 产物应用（apply_artifact） | dangerous | 启用 | 需确认 | 路径校验、覆盖确认 |

### 5.4 知识库分层架构

```
层1：工作记忆（现有）
  └─ context.ts 的上下文窗口 + 压缩算法

层2：长期记忆（现有）
  └─ memories 表 + remember 工具 + system message 注入

层3：文件搜索（短期新增）
  └─ search_files 工具：glob 模式 + 正则内容搜索
  └─ 无需 embedding，基于文件系统直接搜索

层4：语义知识库（中期新增，触发条件：用户主动启用或文件数 > 100）
  └─ sqlite-vec 虚拟表：document_chunks (id, file_path, chunk_index, content, embedding, metadata)
  └─ index_files 工具：扫描工作区文件，分块，调用 embedding API，存入 sqlite-vec
  └─ recall 工具：接受查询，embedding，KNN 搜索，返回 top-K 片段 + 来源引用
  └─ 增量更新：文件修改时间比对，仅重新索引变更文件
```

### 5.5 评测架构

```
scripts/
  evals/
    tasks/                    # 可复现任务集
      summarize-workspace.json
      web-research.json
      file-organize.json
      ...
    fixtures/                 # 测试夹具（mock LLM/MCP）
      mock-llm-server.mjs
      mock-mcp-server.mjs
    scorers/                  # 评分器
      rule-scorer.mjs         # 规则评分
      llm-judge-scorer.mjs    # LLM Judge 评分
    run-eval.mjs              # 评测运行器
    report.mjs                # 评测报告生成器
```

### 5.6 追问与用户参与状态机

追问（Clarification）与审批（Approval）共享 `paused` 阶段，但在循环内部走不同的等待路径。以下是完整的状态转换模型：

```
                         ┌──────────────┐
                         │   running    │
                         │  (ReAct loop)│
                         └──────┬───────┘
                                │
                    ┌───────────┼───────────┐
                    │           │           │
              tool risk ≠ safe  │     ask_user tool
                    │           │           │
                    ▼           │           ▼
        ┌───────────────────┐   │   ┌───────────────────────┐
        │ waiting_approval  │   │   │ waiting_clarification  │
        │ (审批等待)         │   │   │ (追问等待)              │
        └────────┬──────────┘   │   └────────┬──────────────┘
                 │              │            │
        ┌────────┼──────┐      │   ┌────────┼──────────┐
        │        │      │      │   │        │          │
     approved  denied  timeout │  answered  timeout   abort
        │        │      │      │   │        │          │
        ▼        ▼      ▼      │   ▼        ▼          ▼
     execute   reject  reject  │  inject   agent     cancel
     tool      tool    tool    │  answer   decides   task
                 result  result│  result   & continues
                               │
                               ▼
                    ┌──────────────────┐
                    │  running (继续)   │
                    └──────────────────┘
```

**与审批的关键差异：**

| 维度 | 审批 (Approval) | 追问 (Clarification) |
|---|---|---|
| 触发条件 | 工具 risk ≠ safe | Agent 主动调用 `ask_user` 工具 |
| 等待内容 | 用户批准/拒绝 | 用户文本回复 |
| 超时行为 | 自动拒绝，注入拒绝消息 | Agent 收到超时通知，自行决策继续 |
| 超时时间 | `config.agent.approvalTimeoutMs`（默认 60s） | `config.agent.clarificationTimeoutMs`（默认 300s，更长） |
| 循环注入 | tool result（批准/拒绝 + 原因） | tool result（用户回复文本 / 超时通知） |
| 前端组件 | `ToolActivityCard` 审批按钮 | `ClarificationCard` 文本输入 + 选项 |
| API 端点 | `POST /api/tasks/:id/approvals` | `POST /api/tasks/:id/clarifications/:clarificationId` |

**实现要点**：在 `loop.ts` 中，`ask_user` 工具的执行逻辑调用新的 `waitForClarification()` 函数，其内部结构与 `waitForApproval()` 对称（Promise + `pendingClarifications` Map + AbortSignal + timeout），但 resolve 值为用户回复文本而非 boolean。

### 5.7 UI 目标架构

**组件层次重构**：当前 `App.tsx`（1137 行上帝组件）应拆分为以下结构：

```
App (路由 + 全局状态)
├── TaskHistorySidebar (历史、搜索、导航)
├── MainArea
│   ├── EmptyState (无任务时的英雄输入框)
│   ├── Conversation
│   │   ├── MessageBubble (用户/助手消息)
│   │   ├── PlanCard (多步计划卡片，替代当前单步)
│   │   ├── ToolActivityCard (工具调用卡片)
│   │   ├── ClarificationCard (追问交互卡片)     ← 新增
│   │   ├── ArtifactCard (产物预览卡片)           ← 新增
│   │   └── BudgetBar (预算使用进度条)            ← 新增
│   └── Composer (输入框 + 模型选择器)
├── InspectorPanel (右侧抽屉)
│   ├── TaskContext (任务上下文 + token 消耗)     ← 增强
│   ├── TraceLog (轨迹日志)
│   ├── ArtifactList (产物列表)                   ← 新增
│   └── AgentEventFeed (事件流)
├── SettingsPanel (设置)
├── MemoryPanel (记忆管理)
└── ArtifactDetailModal (产物详情/预览/确认)      ← 新增
```

**状态管理策略**：从 `useState` 散落管理演进为自定义 Hook 分层：

- `useTaskState()` — 管理 currentTask、tasks、status、phase、plan、output。封装任务创建、继续、恢复、取消逻辑。
- `useSSEStream()` — 管理 EventSource 生命周期、事件分发、迟到订阅。封装 stream/open/close/error 处理。
- `useTools()` — 管理工具列表、启用状态、MCP 状态。
- `useSettings()` — 管理设置草稿、保存、模型列表。
- `useArtifacts()` — 管理产物列表、确认/拒绝操作、预览状态。
- `useMemories()` — 管理记忆 CRUD。

长期（如果 Hook 数量继续增长）可引入 Zustand 做全局状态管理，避免 prop drilling。

**信息架构改造**：

- **对话区**（主区域）：从纯聊天流变为"目标执行流"——用户目标 → 计划卡片 → 工具活动 → 追问交互 → 产物预览 → 最终回复。每个元素按时间顺序排列，支持折叠。
- **产物面板**（InspectorPanel 新 tab）：独立展示所有产物，支持预览（Markdown 渲染 / 代码高亮）、确认/拒绝操作、diff 查看（覆盖文件时）。
- **预算条**（Conversation 底部固定）：显示当前轮数/总轮数、工具调用次数、已消耗 token、预估成本。超限时变红。
- **追问卡片**（内嵌在对话流中）：展示 Agent 的问题文本、可选选项（如有）、文本输入框、发送按钮。已回复的追问显示回复内容（只读）。
- **任务历史增强**：支持全文搜索（前端过滤任务目标文本）、状态筛选（running/completed/failed）、任务删除（调用清理 API）。

**Markdown 渲染**：引入 `react-markdown` + `remark-gfm`，在 `MessageBubble` 中将助手回复内容渲染为 Markdown（代码块高亮、表格、列表、链接）。这是从"聊天"到"工作台"的关键视觉升级。

---

## 6. 分阶段落地计划

### 6.1 短期（2 周）：产物 + 追问 + 预算

**目标**：让 Agent 能交付结构化产物、主动追问、受预算约束。

**Sprint 1（第 1 周）：任务产物与追问**

1. 在 `packages/shared` 中新增 `TaskArtifact`、`ClarificationRequest` 类型。
2. 在 `loop.ts` 中实现 `ask_user` 工具：调用时发布 `clarification_request` SSE 事件，循环暂停等待用户回复（复用 `waitForApproval` 模式，但增加独立 `pendingClarifications` Map）。
3. 实现 `create_artifact` 内置工具：Agent 调用此工具时，在 Task.artifacts 中创建 draft 产物，发布 `artifact_created` SSE 事件。
4. 在 `server.ts` 中新增 `POST /api/tasks/:id/clarifications` 端点（用户回复追问）。
5. 在 `server.ts` 中新增 `PATCH /api/tasks/:id/artifacts/:artifactId` 端点（用户确认/拒绝产物）。
6. 前端：`Conversation.tsx` 中新增 `ClarificationCard`（追问卡片）和 `ArtifactCard`（产物预览卡片）。

**Sprint 2（第 2 周）：执行预算 + token 记录 + 基础命令执行**

1. 在 `packages/shared` 中新增 `TaskBudget`、`AggregatedTokenUsage` 类型。
2. 在 `loop.ts` 中实现预算检查：每轮开始前检查 iteration/toolCalls/wallTime 是否超限。
3. 在 `provider.ts` 的 `parseStream()` 中解析 OpenAI `usage` 字段（需设置 `stream_options.include_usage = true`）。非流式模式下从完整响应中提取。
4. 在 `loop.ts` 中每轮结束后累加 token usage 到 `Task.tokenUsage`。
5. 实现 `ProcessCommandExecutor`（基于 `child_process.spawn`），遵循已有 `CommandExecutionPolicy`。
6. 注册 `execute_command` 工具（dangerous，默认禁用）。
7. 回归用例：追问暂停/回复/超时、产物创建/确认/拒绝、预算超限终止、命令执行沙箱边界。

**用户可见结果**：Agent 可以在执行中途追问用户、可以生成结构化产物供预览确认、执行过程有 token 消耗可见、可以在沙箱中执行命令。

### 6.2 中期（1-2 月）：工具扩展 + 安全加固 + 多步计划 + UI 改造

**第 3-4 周：工具扩展与安全加固**

1. 实现 `search_files` 工具（glob + 正则内容搜索）。
2. 实现 `copy_file`、`move_file`、`delete_file` 工具（带回收站）。
3. `http_fetch` 安全改造：SSRF 防护（IP 黑名单）、重定向限制（最多 3 次，目标也做黑名单检查）、HTML 清洗（去除 script/style/iframe 标签）、Content-Type 校验。
4. 引入 Zod schema validation：所有内置工具定义 Zod schema，`registry.invoke()` 在执行前做 schema 校验。
5. MCP 工具描述净化：截断过长描述（>500 字符）、检测并移除 prompt injection 关键词模式。

**第 5-6 周：多步计划 + 检查点**

1. 扩展 system prompt 引导 LLM 输出结构化计划（JSON 格式的步骤列表）。
2. 在 `loop.ts` 中解析 LLM 的首轮回复：如果包含结构化计划，创建多个 `PlanStep` 并在后续轮次中标记当前步骤。
3. 在每完成一个步骤后创建 `TaskCheckpoint`（记录当前 iteration 和 messageIndex）。
4. 任务恢复时优先从最近的 checkpoint 继续，而非全量重跑。

**第 7-8 周：UI 改造**

1. App.tsx 拆分：提取 `useTaskState`、`useSSEStream`、`useSettings` 自定义 Hook。
2. 引入 Markdown 渲染（`react-markdown` + `remark-gfm`）。
3. 新增 ArtifactPanel：产物列表、预览、确认/拒绝操作。
4. Conversation.tsx 改造：多步计划卡片（替代当前单步 PlanCard）、追问交互卡片。
5. TaskHistorySidebar 改造：搜索、状态筛选、任务删除。

**用户可见结果**：Agent 可以搜索文件、执行更丰富的文件操作、网络请求更安全、执行计划可见且可恢复、UI 更清晰且可交互。

### 6.3 长期（3+ 月）：知识库 + 评测 + 浏览器 + 打包

**第 9-12 周：知识库**

1. 引入 sqlite-vec，新建 `document_chunks` 虚拟表。
2. 实现 `index_files` 和 `recall` 工具。
3. 前端：知识库管理界面（索引状态、搜索测试）。

**第 13-16 周：评测闭环**

1. 建立 20 个真实个人用户任务样例。
2. 实现 trace grading 评分器（规则 + LLM Judge）。
3. 实现 `npm run eval:agent-usability` 命令。
4. 集成到 CI：smoke/regression/release 三层门禁。

**第 17+ 周：浏览器 + 打包**

1. 集成 Playwright MCP Server（通过 MCP 配置添加 `npx @playwright/mcp`）。
2. macOS 打包/签名/公证。
3. Windows 适配。
4. 首次运行向导。

---

## 7. 首个纵向切片建议

**推荐场景：本地材料整理 Agent**

用户目标："请阅读工作区中 `docs/` 目录下的所有 Markdown 文件，生成一份按主题分类的摘要报告，包含来源引用，保存为 `docs/SUMMARY.md`。"

**为什么选这个场景：**

1. **不需要新工具**：仅使用现有的 `list_directory` + `read_file` + `create_artifact` + `apply_artifact`（新增的两个产物工具即可）。
2. **端到端验证关键环节**：
   - 文件搜索/阅读：Agent 需要遍历目录、逐个读取文件。
   - 计划：Agent 应展示"1. 扫描目录 → 2. 阅读各文件 → 3. 提取要点 → 4. 生成报告 → 5. 保存"的多步计划。
   - 产物生成：Agent 调用 `create_artifact` 生成 Markdown 报告草稿。
   - 用户确认：前端 ArtifactPanel 展示报告预览，用户确认后 Agent 调用 `apply_artifact` 写入。
   - 来源引用：报告中每个要点标注来源文件和行号。
   - 追问：如果目录不存在或为空，Agent 应追问用户指定路径。
   - 预算：大量文件场景下需要预算控制（限制读取文件数量）。
3. **可回归**：可编写确定性测试夹具（mock LLM 返回固定摘要），验证完整流程。

**端到端实现计划：**

| 步骤 | 模块 | 改动 |
|---|---|---|
| 1 | `packages/shared` | 新增 `TaskArtifact`、`ClarificationRequest`、`TaskBudget`、`TaskCheckpoint` 类型 |
| 2 | `apps/agent/src/tools/builtins.ts` | 新增 `ask_user`、`create_artifact`、`apply_artifact`、`search_files` 工具 |
| 3 | `apps/agent/src/agent/loop.ts` | 追问暂停/继续逻辑、预算检查、token usage 提取和累加、多步计划解析 |
| 4 | `apps/agent/src/llm/provider.ts` | `stream_options.include_usage = true`、usage 字段解析 |
| 5 | `apps/agent/src/server.ts` | 新增 `POST /api/tasks/:id/clarifications`、`PATCH /api/tasks/:id/artifacts/:artifactId` |
| 6 | `apps/desktop/src/components/Conversation.tsx` | `ClarificationCard`、`ArtifactCard`、多步 `PlanCard` |
| 7 | `apps/desktop/src/App.tsx` | 追问/产物相关状态和回调 |
| 8 | `scripts/evals/tasks/summarize-workspace.json` | 任务定义和评分规则 |
| 9 | `scripts/m6-regression.mjs` | 追问、产物、预算、token usage 的回归用例 |

---

## 8. 数据模型与 API 草案

### 8.1 TypeScript 类型变更

```typescript
// === packages/shared/src/index.ts 新增 ===

// --- 产物 ---
type ArtifactType = 'text' | 'file' | 'diff' | 'url';
type ArtifactStatus = 'draft' | 'confirmed' | 'applied' | 'rejected';

interface TaskArtifact {
  id: string;
  type: ArtifactType;
  name: string;
  content: string;
  mimeType?: string;
  sourceCallId?: string;
  status: ArtifactStatus;
  createdAt: string;
  appliedAt?: string;
  appliedPath?: string;
}

// --- 追问 ---
interface ClarificationRequest {
  id: string;
  question: string;
  options?: string[];
  context?: string;
  callId: string;
  status: 'pending' | 'answered' | 'timeout';
  answer?: string;
  createdAt: string;
  answeredAt?: string;
}

// --- 预算 ---
interface TaskBudget {
  maxIterations: number;
  maxToolCalls: number;
  maxWallTimeMs: number;
  maxOutputBytes: number;
}

interface BudgetUsage {
  iterations: number;
  toolCalls: number;
  wallTimeMs: number;
  outputBytes: number;
}

// --- 检查点 ---
interface TaskCheckpoint {
  id: string;
  iteration: number;
  description: string;
  messageIndex: number;
  createdAt: string;
}

// --- Token 使用 ---
interface AggregatedTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  byModel?: Record<string, { promptTokens: number; completionTokens: number }>;
}

// --- Task 扩展 ---
// 在现有 Task 接口中增加可选字段：
interface Task {
  // ...现有字段保持不变...
  budget?: TaskBudget;
  budgetUsage?: BudgetUsage;
  artifacts?: TaskArtifact[];
  clarifications?: ClarificationRequest[];
  checkpoints?: TaskCheckpoint[];
  tokenUsage?: AggregatedTokenUsage;
}

// --- 新 SSE 事件 ---
// 在 AgentEvent 联合类型中增加：
type AgentEvent =
  // ...现有 12 种事件...
  | { type: 'clarification_request'; taskId: string; clarification: ClarificationRequest }
  | { type: 'clarification_resolved'; taskId: string; clarificationId: string; answer: string }
  | { type: 'artifact_created'; taskId: string; artifact: TaskArtifact }
  | { type: 'artifact_updated'; taskId: string; artifact: TaskArtifact }
  | { type: 'checkpoint_created'; taskId: string; checkpoint: TaskCheckpoint }
  | { type: 'budget_usage'; taskId: string; usage: BudgetUsage }
  | { type: 'token_usage'; taskId: string; usage: AggregatedTokenUsage };

// --- 新 HTTP 请求/响应 ---
interface RespondToClarificationRequest {
  answer: string;
}

interface UpdateArtifactRequest {
  status: 'confirmed' | 'rejected';
}
```

### 8.2 SQLite 表变更

**渐进迁移策略**：不拆分现有 `tasks` 表的 JSON 列，而是在 `tasks` 表中增加新的 JSON 列。

```sql
-- Migration: add new columns to tasks table
ALTER TABLE tasks ADD COLUMN artifacts TEXT DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN clarifications TEXT DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN checkpoints TEXT DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN budget TEXT;
ALTER TABLE tasks ADD COLUMN budget_usage TEXT;
ALTER TABLE tasks ADD COLUMN token_usage TEXT;
```

**未来迁移（知识库，中期）**：

```sql
-- 知识库文档分块表（sqlite-vec 虚拟表）
CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks USING vec0(
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding FLOAT[768],       -- 维度取决于 embedding 模型
  file_modified_at TEXT,
  indexed_at TEXT
);

-- 知识库索引状态
CREATE TABLE IF NOT EXISTS knowledge_index_state (
  file_path TEXT PRIMARY KEY,
  file_hash TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  indexed_at TEXT NOT NULL
);
```

### 8.3 HTTP/SSE 端点变更

**新增端点：**

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/tasks/:id/clarifications/:clarificationId` | 用户回复追问 |
| PATCH | `/api/tasks/:id/artifacts/:artifactId` | 用户确认/拒绝产物 |
| GET | `/api/tasks/:id/artifacts` | 列出任务的所有产物 |
| GET | `/api/tasks/:id/artifacts/:artifactId/content` | 获取产物内容 |

**变更端点：**

| 端点 | 变更 |
|---|---|
| `POST /api/tasks` | 请求体增加可选 `budget?: TaskBudget` |
| `GET /api/tasks/:id` | 响应体增加 `artifacts`、`clarifications`、`checkpoints`、`budgetUsage`、`tokenUsage` |
| `GET /api/tasks/:id/stream` | SSE 事件流增加 `clarification_request`、`clarification_resolved`、`artifact_created`、`artifact_updated`、`checkpoint_created`、`budget_usage`、`token_usage` 事件 |

---

## 9. 风险清单

### 9.1 安全风险

| 风险 | 严重性 | 缓解措施 | 阶段 |
|---|---|---|---|
| 命令执行逃逸沙箱 | 高 | `spawn` with `shell: false`、`cwd` 限制、`env` 白名单、`timeout`、`maxBuffer`、命令黑名单（`rm -rf`、`sudo`、`chmod` 等） | 短期 |
| MCP 工具描述 prompt injection | 高 | 描述长度截断（>500 字符）、关键词模式检测、不信任 annotations 做风险决策（仅做参考）、用户透明度（展示工具来源和描述） | 中期 |
| http_fetch SSRF | 中 | IP 黑名单（私有地址段）、重定向限制（3 次，目标也做检查）、DNS rebinding 防护（解析后再次检查 IP） | 中期 |
| 产物写入覆盖用户文件 | 中 | draft → 确认 → 原子写入流程、备份原文件、diff 预览 | 短期 |
| API Key 明文存储 | 低 | 当前 is_secret 标记已有。中期可引入系统 Keychain（macOS Keychain/Windows Credential Manager）加密存储 | 长期 |

### 9.2 隐私风险

| 风险 | 缓解措施 |
|---|---|
| 文件内容发送到 LLM Provider | 在 UI 中明确展示哪些文件将被读取并发送给模型。工作区路径限制防止意外读取敏感文件。 |
| 记忆内容包含敏感信息 | 记忆分类中标注"敏感"类别，注入 LLM 前过滤。 |
| 知识库索引暴露文件结构 | 索引仅存储在本地 SQLite，不上传。 |

### 9.3 跨平台风险

| 风险 | 缓解措施 |
|---|---|
| `child_process.spawn` 在 Windows 上行为不同 | 命令执行使用跨平台抽象：`shell: false`、`path.normalize`、不使用 Unix-specific 命令。 |
| `better-sqlite3` 编译在 Windows 上可能失败 | 已有 M5 规划中的 Windows CI 验证。预编译二进制（prebuild）作为备选。 |
| 文件路径分隔符 | 已有规范：使用 `node:path`，不硬编码分隔符。 |

### 9.4 模型兼容风险

| 风险 | 缓解措施 |
|---|---|
| Ollama streaming tool_calls 不稳定 | 已有自动检测和非流式降级。 |
| DeepSeek R1 不支持工具调用 | 已有 provider 检测，可在 UI 中提示用户切换到支持工具调用的模型。 |
| 不同 Provider 的 usage 字段格式不同 | 在 `provider.ts` 中做归一化（OpenAI `usage`、Ollama `prompt_eval_count`/`eval_count`）。 |
| 追问/计划依赖 structured output | 不强依赖 JSON mode。通过 prompt 引导 + 容错解析（正则提取 JSON 片段）实现。 |

### 9.5 实现复杂度风险

| 风险 | 缓解措施 |
|---|---|
| App.tsx 继续膨胀 | 中期拆分自定义 Hook，长期引入状态管理（Zustand/Jotai）。 |
| 回归脚本变慢 | 保持现有脚本不变，新增 `m6-regression.mjs` 仅覆盖新增功能。 |
| 多步计划引入 LLM 不确定性 | 计划失败时降级为现有单步模式，不阻塞执行。 |
| sqlite-vec 增加编译依赖 | 仅在用户启用知识库功能时按需加载，不作为核心依赖。 |

---

## 10. 验收标准

### 10.1 短期（2 周后）验收

**可运行命令：**

```bash
# 类型检查通过
npm run typecheck

# 共享类型构建
npm run build:shared

# 前端构建
npm run build

# 现有回归全部通过
npm run regression:m3
npm run regression:m4
npm run regression:m5

# 新增回归通过
node scripts/m6-regression.mjs
```

**回归用例（m6-regression.mjs）：**

1. `caseAskUserAndResume`：Agent 调用 `ask_user`，循环暂停，SSE 发出 `clarification_request`，用户回复后循环继续。
2. `caseAskUserTimeout`：追问超时（可配置），Agent 收到超时通知后自行决策继续。
3. `caseCreateArtifact`：Agent 调用 `create_artifact`，SSE 发出 `artifact_created`，产物状态为 `draft`。
4. `caseConfirmArtifact`：用户确认产物，状态变为 `confirmed`，Agent 调用 `apply_artifact` 写入文件。
5. `caseRejectArtifact`：用户拒绝产物，状态变为 `rejected`，Agent 收到拒绝通知后调整。
6. `caseBudgetExceeded`：设置 `maxIterations: 3`，Agent 在第 3 轮后被终止，状态为 `failed`，trace 记录预算超限。
7. `caseTokenUsageRecorded`：任务完成后 `Task.tokenUsage` 非 null，包含 promptTokens 和 completionTokens。
8. `caseSearchFiles`：`search_files` 工具按 glob 模式搜索，返回匹配文件列表。
9. `caseExecuteCommand`：`execute_command` 在沙箱中执行 `echo hello`，返回 stdout。
10. `caseExecuteCommandSandbox`：`execute_command` 尝试访问工作区外的路径被拒绝。

**用户可见结果：**

- 在 Conversation 中看到追问卡片，可以回复。
- 在 Conversation 中看到产物预览，可以确认或拒绝。
- 在 InspectorPanel 中看到 token 消耗和预算使用。
- 可以在沙箱中执行简单命令。

### 10.2 中期（1-2 月后）验收

**可运行命令：**

```bash
# 所有现有回归通过
npm run regression:m3 && npm run regression:m4 && npm run regression:m5 && node scripts/m6-regression.mjs

# 前端组件测试（如果引入 Vitest）
npm run test:components
```

**回归新增用例：**

11. `caseHttpFetchSSRFDenied`：`http_fetch` 访问 `http://127.0.0.1:8787/api/health` 被拒绝。
12. `caseHttpFetchRedirectLimit`：超过 3 次重定向的 URL 被终止。
13. `caseToolSchemaValidation`：工具参数不符合 schema 时返回结构化错误。
14. `caseMultiStepPlan`：任务创建后 Plan 包含多个步骤，步骤状态随执行更新。
15. `caseCheckpointResume`：任务从最近 checkpoint 恢复而非全量重跑。
16. `caseCopyMoveDeleteFile`：文件操作工具的正常和异常路径。

**用户可见结果：**

- Agent 展示多步计划，每步状态实时更新。
- 文件搜索/复制/移动/删除可在对话中使用。
- 网络请求更安全（SSRF 不可达）。
- UI 支持 Markdown 渲染、产物面板、追问交互。
- 任务历史可搜索、可筛选。

### 10.3 长期（3+ 月后）验收

**可运行命令：**

```bash
# 评测套件
npm run eval:agent-usability

# 完整发布门禁
npm run gate:release
```

**评测门槛：**

- Smoke（30s 内）：`npm run typecheck && npm run build`
- Regression（5min 内）：`npm run regression:m3 && m4 && m5 && node scripts/m6-regression.mjs`
- Release（30min 内）：`npm run eval:agent-usability`，要求任务完成率 ≥ 70%、安全合规率 = 100%

---

## 11. 可复现 Agent 用户任务样例

以下 12 个任务样例覆盖不同能力组合，可作为评测基准：

| # | 任务目标 | 核心能力 | 预期产物 |
|---|---|---|---|
| 1 | "阅读 docs/ 目录下的所有 Markdown 文件，生成主题摘要保存到 docs/SUMMARY.md" | 文件遍历、阅读、产物生成、写入审批 | Markdown 报告 |
| 2 | "搜索工作区中所有包含 'TODO' 的文件，列出位置并建议优先级" | 文件搜索、内容分析 | 带来源引用的列表 |
| 3 | "帮我查一下今天的天气和最近的科技新闻" | 网络请求、信息综合 | 文本回答 |
| 4 | "把 workspace/notes/ 下的文件按日期重命名" | 文件列表、重命名、批量操作 | 重命名日志 |
| 5 | "运行 npm run typecheck 并修复第一个类型错误" | 命令执行、文件读写 | 修复后的代码 |
| 6 | "读取 data.csv，统计每列的空值数量，生成分析报告" | 文件阅读、数据分析、产物 | Markdown 报告 |
| 7 | "帮我把这周的会议纪要整理成周报，参考之前的周报模板" | 文件搜索、阅读、知识库召回 | Markdown 周报 |
| 8 | "检查项目中的所有 package.json，列出过时的依赖" | 文件搜索、命令执行（npm outdated） | 依赖更新建议列表 |
| 9 | "打开 https://example.com 截图并描述页面内容" | 浏览器自动化（Playwright MCP） | 截图 + 描述 |
| 10 | "把 report.md 翻译成英文并保存为 report-en.md" | 文件阅读、翻译、写入 | 英文报告文件 |
| 11 | "分析我的记忆条目，找出矛盾或过时的内容并建议删除" | 记忆读取、分析、追问确认 | 记忆清理建议 |
| 12 | "帮我写一个 Python 脚本，计算斐波那契数列前 100 项，然后运行它" | 文件写入、命令执行 | Python 脚本 + 运行结果 |

---

## 12. 高风险能力的审批/沙箱/回归方案

### 12.1 命令执行（execute_command）

**审批策略**：dangerous 级别，每次执行前弹出审批卡片，展示完整命令和工作目录。用户可配置命令白名单（如 `npm run typecheck`、`git status`），白名单内命令免审批。

**沙箱策略**：`child_process.spawn` with `shell: false`、`cwd` 限制在工作区、`timeout` 30s、`maxBuffer` 1MB、`env` 白名单（仅 `PATH` 中的 `/usr/bin`、`/bin`、Node.js 路径）。命令黑名单：`rm -rf`、`sudo`、`chmod`、`chown`、`kill`、`shutdown`、`dd`。

**回归用例**：
- 正常执行 `echo hello` 返回 stdout。
- 超时命令（`sleep 60`）被终止。
- 工作区外路径访问被拒绝。
- 黑名单命令被拒绝。
- 审批拒绝返回错误。
- 输出超过 maxBuffer 被截断。

### 12.2 文件删除（delete_file）

**审批策略**：dangerous 级别，每次删除前弹出审批卡片，展示文件路径和大小。

**沙箱策略**：不真正删除，而是移到系统回收站（macOS: `mv -n <file> ~/.Trash/`，Windows: `powershell.exe SendToRecycleBin`）。工作区外路径拒绝。系统目录黑名单（`/etc`、`/usr`、`/System`、`C:\Windows`）。

**回归用例**：
- 正常删除（移到回收站）。
- 工作区外路径被拒绝。
- 不存在文件返回错误。
- 审批拒绝不执行。

### 12.3 HTTP 请求（http_fetch 改造后）

**审批策略**：保持 caution 级别（需确认），但白名单域名（用户配置）免审批。

**安全策略**：IP 黑名单检查（在 DNS 解析后再次检查）、重定向限制 3 次且目标也做检查、响应体 1MB 限制、HTML 标签清洗（去除 `<script>`/`<style>`/`<iframe>`/`<object>`/`<embed>`）、Content-Type 校验（仅接受文本类型）。

**回归用例**：
- SSRF：`http://127.0.0.1`、`http://169.254.169.254`、`http://10.0.0.1` 被拒绝。
- 重定向到内网 IP 被拒绝。
- 超过 3 次重定向被终止。
- HTML 中的 `<script>` 标签被清除。
- 二进制 Content-Type 返回类型提示而非内容。

### 12.4 产物写入（apply_artifact）

**审批策略**：dangerous 级别，写入前展示 diff 预览（新增文件展示全文，覆盖文件展示差异）。

**安全策略**：原文件备份到 `.aurevoy/backup/`。写入使用原子操作（写临时文件 → rename）。路径校验复用 `resolveInWorkspace` + `assertRealPathInside`。

**回归用例**：
- 新文件创建成功。
- 覆盖文件前备份原文件。
- 工作区外路径被拒绝。
- 审批拒绝不写入。
- 产物状态正确流转（draft → confirmed → applied）。

### 12.5 MCP 工具调用

**审批策略**：继承 server 级 riskLevel 或基于 annotations 推断（已实现）。增加：首次使用某 MCP server 的工具时弹出"信任此 server？"对话框。

**安全策略**：工具描述长度截断（>500 字符）、描述中的 prompt injection 模式检测（"ignore previous"、"system prompt"、"you must" 等关键词）、输出长度截断（复用现有 trace 的 1200 字符限制）。

**回归用例**：
- 恶意工具描述被截断。
- MCP server 失败不阻塞其他 server（已有）。
- MCP 工具输出超长被截断。
- 未信任的 server 工具需要额外确认。

---

## 13. 参考资料

### 官方文档与规范

- [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/) — Agent/Session/Tracing/Guardrails 架构
- [Anthropic: Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) — 简单可组合的 Agent 模式
- [Anthropic: How We Build Agents at Anthropic](https://www.anthropic.com/engineering/building-agents) — Agent 工程实践
- [MCP Specification 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18) — 工具 annotations、安全考虑、outputSchema
- [LangGraph Persistence](https://langchain-ai.github.io/langgraph/concepts/persistence/) — Checkpoint 持久化机制
- [Tauri 2.0 Documentation](https://v2.tauri.app/) — 桌面应用安全和命令执行
- [Node.js child_process](https://nodejs.org/api/child_process.html) — spawn 安全选项
- [Playwright MCP Server](https://github.com/anthropics/mcp-playwright) — 浏览器自动化 MCP 集成
- [sqlite-vec](https://github.com/asg017/sqlite-vec) — SQLite 向量搜索扩展
- [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) — SSRF 防护

### 安全研究

- [MCP Prompt Injection](https://developer.aliyun.com/article/1732787) — MCP 协议层 prompt injection 分析
- [Anthropic MCP Vulnerability Report](https://www.penligent.ai/hackinglabs/anthropic-mcp-vulnerability-7000-servers-and-the-case-for-continuous-red-teaming/) — MCP 安全审计
- [MDN: Server Side Request Forgery](https://developer.mozilla.org/en-US/docs/Web/Security/Attacks/SSRF) — SSRF 攻击和防御

### 评测与质量

- [Anthropic: Demystifying Evals for AI Agents](https://www.anthropic.com/engineering/evaluating-ai-agents) — Agent 评测框架
- [OpenAI Agents SDK Tracing](https://openai.github.io/openai-agents-python/tracing/) — Trace 数据模型和处理器
- [arXiv: Agentic CLEAR](https://arxiv.org/html/2605.22608v1) — 多层级 Agent 评测自动化
- [arXiv: Crab Checkpoint/Restore](https://arxiv.org/html/2604.28138v1) — Agent 检查点和故障恢复

### 框架与实现参考

- [OpenAI Agents SDK Source](https://github.com/openai/openai-agents-python) — Runner/Session/Trace 实现
- [LangGraph Source](https://github.com/langchain-ai/langgraph) — Checkpointer/AgentState 实现
- [AutoGen](https://github.com/microsoft/autogen) — Team/Agent/Termination 实现
- [CrewAI](https://github.com/crewAIInc/crewAI) — Crew/Agent/Task 实现
- [Vercel AI SDK](https://sdk.vercel.ai/) — 工具调用和流式处理
- [OpenClaw](https://github.com/anthropics/claude-code) — Agent 记忆系统和工具实现
- [Awesome Harness Engineering](https://github.com/ai-boost/awesome-harness-engineering) — Agent 工程最佳实践汇总

---

> **报告完成。后续步骤**：基于本报告重写 `docs/ROADMAP_AGENT_DELIVERY.md`，将分阶段落地计划转化为具体的里程碑定义和任务拆分。
