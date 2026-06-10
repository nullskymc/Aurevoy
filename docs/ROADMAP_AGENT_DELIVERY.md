# Agent 功能落地路线图 — ROADMAP_AGENT_DELIVERY

> 本文是 Aurevoy 的第二份路线图，聚焦一个目标：
> **把已经完成的 Agent 技术底座，推进成普通用户能真实交付任务的个人 Agent。**
>
> 主路线图 `docs/ROADMAP.md` 记录 M0-M5 的工程底座；本文从 M6 开始，记录 Agent
> 产品能力的落地顺序。本文基于 `docs/research/agent-delivery-deepresearch-report.md`
> 重写，所有阶段都必须结合当前代码实现推进，不能脱离现有架构另起炉灶。

## 0. 当前判断

Deep Research 的结论可以压缩成一句话：

**Aurevoy 已经有生产级 Agent 的骨架，但缺少让用户感知“它真的完成了任务”的产物、追问、计划、预算和评测闭环。**

截至 M6，本路线图已经补齐第一批交付感知能力：任务产物、结构化追问、执行预算、
Provider token usage、基础命令执行和对应前端展示/回归。M7 起继续推进文件/网页工具、
schema validation、多步计划、checkpoint 和工作台拆分。

当前已真实具备：

- `apps/agent/src/agent/loop.ts`：单 Agent ReAct 循环、工具调用、审批等待、取消、重试、防重复调用、任务恢复。
- `apps/agent/src/tools/registry.ts`：工具统一注册、启停、风险等级、调用封装。
- `apps/agent/src/tools/builtins.ts`：`list_directory`、`read_file`、`write_file`、`http_fetch`、
  `remember`、`ask_user`、`create_artifact`、`apply_artifact`、`execute_command` 等真实工具。
- `apps/agent/src/tools/mcp.ts`：MCP stdio 工具发现、名称清洗、风险推断和注册。
- `apps/agent/src/store/db.ts`：SQLite 任务、轨迹、记忆、设置和工具开关。
- `apps/agent/src/server.ts`：任务、多轮、恢复、审批、记忆、设置、数据管理和 SSE。
- `apps/desktop/src/App.tsx` 与组件：对话、工具审批、轨迹、设置、记忆、历史任务工作台。
- `scripts/m3-regression.mjs`、`m4-regression.mjs`、`m5-regression.mjs`、`m6-regression.mjs`：
  覆盖基础 Agent、安全、恢复、记忆、设置、追问、产物、预算、token usage 和命令执行。

M6 之后仍阻塞更高可靠性交付的缺口：

- 计划仍是单步：`runTask()` 当前用 `id: "exec"` 的单步 plan 承载全部执行。
- `http_fetch` 仍是原始抓取：缺 SSRF 防护、重定向限制、HTML 清洗和来源结构。
- 文件工具覆盖面仍窄：缺搜索、复制、移动、删除和更细的大文件/编码诊断。
- 工具参数还缺统一 runtime schema validation，MCP 描述净化与风险覆盖仍需加强。
- 产物写入 M6 先做文本预览，覆盖前 diff、备份、版本化和大文件/二进制 artifact 留给 M7/M8。
- 无 trace grading / eval run / agent-usability 任务集。

## 1. 总原则

1. **不做大重构**：现有 ReAct loop、ToolRegistry、SQLite、HTTP + SSE、Tauri 工作台继续作为主线。
2. **纵向切片优先**：每个阶段都必须能让一个真实用户任务端到端跑通，而不是只补底层字段。
3. **产物优先于能力堆叠**：没有 artifact、确认和回看，就不能把“生成文件/报告/截图/日志”算作交付完成。
4. **治理先于高风险能力**：命令、删除、覆盖、浏览器、MCP 高风险工具必须先有 schema、审批、trace 和回归。
5. **评测作为发布门槛**：Agent 行为改动不能只靠人工试用判断，要能用固定任务集和 trace grading 比较。

非目标：

- 近期不引入多 Agent、LangGraph/ADK 等重型编排框架。
- 不用 Mock、占位 UI 或静态配置冒充能力完成。
- 不把 MCP annotations 当可信安全边界；本地 runtime 必须能覆盖风险等级。

## 2. 阶段总览

| 阶段 | 时间 | 主题 | 目标 |
|---|---:|---|---|
| M6 | 2 周 | 产物、追问、预算与 token | 让 Agent 能交付可确认产物，并在信息不足时暂停追问 |
| M7 | 1-2 月 | 工具扩展、安全加固、多步计划、UI 拆分 | 让 Agent 能更可靠地处理文件/网页/命令任务 |
| Rewind | ✅ | 编辑重跑、撤销、分支、压缩 | 让用户能回溯历史、编辑重试、非破坏性探索 |
| M8 | 3+ 月 | 知识库、评测、浏览器、发布体验 | 建立长期资料理解、质量门禁和普通用户交付路径 |

## M6 — 产物、追问、预算与 Token

目标：让当前 Agent 从“会回答和调用工具”推进到“能交付可预览、可确认、可回看的结果”。

### M6.1 契约与存储

- [x] 在 `packages/shared/src/index.ts` 新增 `TaskArtifact`。
  - 字段建议：`id`、`type`、`name`、`content`、`mimeType?`、`sourceCallId?`、`status`、`createdAt`、`appliedAt?`、`appliedPath?`。
  - `type`: `text | file | diff | url`。
  - `status`: `draft | confirmed | applied | rejected`。
- [x] 新增 `ClarificationRequest`。
  - 字段建议：`id`、`question`、`options?`、`context?`、`callId`、`status`、`answer?`、`createdAt`、`answeredAt?`。
- [x] 新增 `TaskBudget`、`BudgetUsage`、`AggregatedTokenUsage`。
- [x] 扩展 `Task`：增加 `budget?`、`budgetUsage?`、`artifacts?`、`clarifications?`、`checkpoints?`、`tokenUsage?`。
- [x] 扩展 `AgentEvent`：
  - `clarification_request`
  - `clarification_resolved`
  - `artifact_created`
  - `artifact_updated`
  - `budget_usage`
  - `token_usage`
- [x] 在 `apps/agent/src/store/db.ts` 对 `tasks` 表做渐进迁移，新增 JSON 列：
  - `artifacts TEXT DEFAULT '[]'`
  - `clarifications TEXT DEFAULT '[]'`
  - `checkpoints TEXT DEFAULT '[]'`
  - `budget TEXT`
  - `budget_usage TEXT`
  - `token_usage TEXT`

约束：

- 不拆现有 `messages` / `plan` JSON 列；M6 只做增量列，避免一次性重构存储。
- 改 shared 后必须 `npm run build:shared`。

### M6.2 追问能力

- [x] 新增内置工具 `ask_user`，风险等级 `safe`。
- [x] 在 `apps/agent/src/agent/loop.ts` 增加 `pendingClarifications`，结构参考 `pendingApprovals`。
- [x] `ask_user` 被调用时：
  - 创建 `ClarificationRequest`。
  - 持久化到任务。
  - 发布 `clarification_request` SSE。
  - 将任务置为 `paused`，phase 可扩展为 `waiting_clarification` 或复用 `waiting_approval` 前先明确命名。
  - 等待用户回复、超时或取消。
- [x] 新增 API：`POST /api/tasks/:id/clarifications/:clarificationId`。
- [x] 用户回复后：
  - 发布 `clarification_resolved`。
  - 将回复作为 `tool` result 回灌给模型。
  - loop 从暂停点继续。
- [x] 超时后：
  - 不伪造用户回复。
  - 向模型回灌“用户未回复/超时”的 tool result，由 Agent 决定继续、降级或失败。

验收：

- Agent 能在目录不存在、格式不明确、保存路径缺失时追问用户。
- 用户回复后继续同一个任务，不新建任务、不丢历史。
- 取消任务能释放 pending clarification。

### M6.3 产物能力

- [x] 新增内置工具 `create_artifact`，风险等级 `safe`。
  - 只创建 draft，不写真实用户文件。
  - 产物进入 `Task.artifacts` 并发布 `artifact_created`。
- [x] 新增内置工具 `apply_artifact`，风险等级 `dangerous`。
  - 只允许写入工作区内。
  - 复用文件工具的路径校验和 symlink 真实路径校验。
  - 写入前必须走审批。
  - 覆盖已有文件前应生成 diff 摘要；M6 可先做文本预览，M7 补完整 diff。
- [x] 新增 API：
  - `GET /api/tasks/:id/artifacts`
  - `GET /api/tasks/:id/artifacts/:artifactId/content`
  - `PATCH /api/tasks/:id/artifacts/:artifactId`
- [x] 前端新增：
  - `ArtifactCard`：在对话流展示产物名称、类型、状态、预览入口。
  - Inspector 中新增产物列表。
  - 产物确认/拒绝操作。

验收：

- Agent 生成 Markdown 报告时先出现 draft artifact。
- 用户确认后才写入真实文件。
- 拒绝后不会写文件，Agent 能收到拒绝结果并调整回复。

### M6.4 执行预算与 token usage

- [x] `POST /api/tasks` 支持可选 `budget`。
- [x] `runTask()` 每轮检查：
  - `maxIterations`
  - `maxToolCalls`
  - `maxWallTimeMs`
  - `maxOutputBytes`
- [x] 预算超限时写入 trace，并进入可解释失败或暂停。
- [x] `apps/agent/src/llm/provider.ts` 支持 OpenAI-compatible usage。
  - 流式请求添加 `stream_options: { include_usage: true }`。
  - 流式解析最后 usage chunk。
  - 非流式解析响应体 `usage`。
  - Ollama 等非标准字段做归一化时必须明确 provider 差异。
- [x] `loop.ts` 累加 `Task.tokenUsage`，发布 `token_usage` 事件。
- [x] `InspectorPanel` 展示 token 和预算使用。

验收：

- 支持 usage 的 Provider 完成任务后 `Task.tokenUsage` 非空。
- 不支持 usage 的 Provider 明确显示不可用，不伪造成本。
- 预算超限可在 trace 中定位原因。

### M6.5 基础命令执行

- [x] 实现 `ProcessCommandExecutor`，替换当前 `DisabledCommandExecutor` 的唯一生产实现前，保留默认关闭。
- [x] 使用 `child_process.spawn()`，禁止 shell 解析。
- [x] 执行策略：
  - `cwd` 限制在工作区。
  - `timeoutMs` 强制终止。
  - `outputLimitBytes` 截断 stdout/stderr。
  - `envAllowlist` 控制环境变量。
  - 支持 AbortSignal 取消。
- [x] 注册 `execute_command` 工具，风险等级 `dangerous`，默认禁用。
- [x] 设置页已有 `commandExecutionEnabled`，M6 必须让它控制真实执行器开关。

验收：

- 开启设置后，审批通过的 `echo hello` 能真实执行并返回 stdout。
- 审批拒绝、超时、输出过长、工作区外 cwd 都有明确 tool result 和 trace。
- 默认关闭时模型不可调用或调用明确失败。

### M6 回归

新增 `scripts/m6-regression.mjs`，至少覆盖：

- [x] `caseAskUserAndResume`
- [x] `caseAskUserTimeout`
- [x] `caseCreateArtifact`
- [x] `caseConfirmArtifact`
- [x] `caseRejectArtifact`
- [x] `caseBudgetExceeded`
- [x] `caseTokenUsageRecorded`
- [x] `caseExecuteCommand`
- [x] `caseExecuteCommandSandbox`

M6 完成命令：

```bash
npm run typecheck
npm run build:shared
npm run build
npm run regression:m3
npm run regression:m4
npm run regression:m5
node scripts/m6-regression.mjs
```

### M6 复盘

已交付：

- 契约：`TaskArtifact`、`ClarificationRequest`、`TaskBudget`、`BudgetUsage`、
  `AggregatedTokenUsage` 和 M6 SSE 事件进入 `@aurevoy/shared`。
- 存储：`tasks` 表以 JSON 增量列保存 artifacts、clarifications、checkpoints、budget、
  budget usage 和 token usage，不拆旧 `messages` / `plan`。
- Runtime：`ask_user` 由 Agent loop 接管暂停、超时、取消和回复回灌；预算在每轮、
  工具调用和输出累积时强制检查；支持 OpenAI-compatible `usage` 归一化。
- 产物：`create_artifact` 只生成 draft，`apply_artifact` 复用工作区路径和 symlink 校验，
  并作为 dangerous 工具走审批后写入。
- 命令：`execute_command` 使用 `child_process.spawn()` 且 `shell:false`，受设置开关、工作区 cwd、
  超时、输出上限和 env allowlist 控制。
- 前端：对话流展示待回复追问和 draft artifact，Inspector 展示产物、追问、预算和 token。
- 验证：`npm run typecheck`、`npm run build:shared`、`npm run build`、
  `npm run regression:m3/m4/m5/m6` 通过；Chrome 插件轻量检查本地前端可加载且无 console error。

已知边界：

- M6 的 artifact content 仍直接保存在任务 JSON 中，适合文本草稿；大文件、二进制和版本历史需在 M8 artifact store 中扩展。
- `apply_artifact` 覆盖前只有文本预览和审批，完整 diff、备份和冲突处理留给 M7。
- `execute_command` 是基础进程执行边界，不是完整容器沙箱；默认仍关闭，启用后仍必须走 dangerous 审批。
- `ask_user` 复用审批超时时间；后续可独立出 `clarificationTimeoutMs`。

## M7 — 工具扩展、安全加固、多步计划与 UI 改造

目标：在 M6 的产物与追问基础上，补齐个人 Agent 高频能力，并把安全治理提升到可发布水平。

### M7.1 文件与资料工具

- [x] 新增 `search_files`，风险等级 `safe`。
  - 支持文件名 glob。
  - 支持工作区内文本内容搜索。
  - 返回路径、匹配片段、大小、mtime。
- [x] 新增 `copy_file`，风险等级 `caution`。
- [x] 新增 `move_file` / `rename_file`，风险等级 `caution`。
- [x] 新增 `delete_file`，风险等级 `dangerous`，默认禁用。
  - 当前移入工作区 `.aurevoy-trash`，不做永久删除。
  - 工作区外路径拒绝。
- [x] 增强 `read_file`：
  - 编码错误可诊断。
  - 支持更明确的大文件截断和建议。

验收：

- 文件搜索、复制、移动、删除均有成功、失败、审批拒绝回归。
- 删除默认禁用；启用后仍需审批。

### M7.2 `http_fetch` 安全改造

- [x] 增加 SSRF 防护：
  - 拒绝 `127.0.0.0/8`
  - 拒绝 `10.0.0.0/8`
  - 拒绝 `172.16.0.0/12`
  - 拒绝 `192.168.0.0/16`
  - 拒绝 `169.254.0.0/16`
  - 拒绝 `::1`、`fc00::/7` 等本地/私有地址。
- [x] 不再直接 `redirect: 'follow'` 无限制跟随；改为最多 3 次重定向，且每次目标都重新校验。
- [x] 增加 Content-Type 策略：
  - 文本类型可提取。
  - 二进制类型返回元信息，不把二进制内容塞进 prompt。
- [x] HTML 清洗：
  - 去除 `script`、`style`、`iframe`、`object`、`embed`。
  - 输出正文摘要和链接，而不是原始 HTML。
- [x] 为网页内容增加来源结构：URL、抓取时间、status、contentType、truncated、cleanedText。

验收：

- 内网/本机/metadata 地址请求被拒绝。
- 重定向到内网地址被拒绝。
- HTML 注入内容不会直接覆盖系统指令。

### M7.3 工具 schema validation 与 MCP 治理

- [x] 引入运行时 schema validation。
  - 优先评估 Zod；如引入依赖，更新 `docs/TECH_STACK.md` 说明理由。
  - 内置工具的 schema 需要同时服务 LLM `inputSchema` 和 runtime validation。
- [x] `ToolRegistry.invoke()` 执行前校验参数。
- [x] MCP 工具描述净化：
  - 描述长度截断。
  - 可疑 prompt injection 关键词检测。
  - 工具来源、server 名和风险等级在 UI 可见。
- [x] 本地风险等级可覆盖 MCP annotations；annotations 只作为参考，不作为可信边界。

验收：

- 参数不合法时不进入工具执行函数，返回结构化 tool result。
- 恶意 MCP 工具描述不会原样长文本注入模型上下文。

### M7.4 多步计划与 checkpoint

- [x] 保留现有单步计划作为降级路径。
- [x] 增加结构化计划生成机制。
  - 可用 prompt 引导 JSON 片段，不强依赖所有 Provider 支持 strict JSON。
  - 解析失败时回退单步计划。
- [x] `PlanStep` 支持真实多步状态更新。
- [x] 每个关键步骤完成后创建 `TaskCheckpoint`。
- [x] `resume` 优先基于最近 checkpoint 给模型构造恢复上下文。

验收：

- “本地材料整理 Agent”任务能展示扫描、阅读、提取、生成、保存等多步计划。
- 恢复任务时能说明从哪个 checkpoint 继续。

### M7.5 前端工作台改造

- [x] 拆分 `apps/desktop/src/App.tsx`：
  - `useTaskState`
  - `useSSEStream`
  - `useSettings`
  - `useTools`
  - `useMemories`
  - `useArtifacts`
- [x] 引入 Markdown 渲染。
  - 当前实现使用内置安全 Markdown 渲染边界，避免在 M7 引入额外依赖；链接仍需走安全属性，复杂 GFM 留给后续增强。
- [x] `Conversation.tsx` 新增：
  - 多步 `PlanCard`
  - `ClarificationCard`
  - `ArtifactCard`
  - `BudgetBar`
- [x] `InspectorPanel` 新增：
  - artifact 列表。
  - token usage。
  - 预算使用。
- [x] `TaskHistorySidebar` 新增：
  - 本地搜索。
  - 状态筛选。
  - 清理入口继续由设置页的数据管理承载，侧栏先提供搜索和状态筛选。

验收：

- 主界面不是普通聊天流，而能清楚看到目标、计划、追问、工具、产物、预算和最终结果。
- App 拆分后不牺牲现有 SSE 和历史任务行为。

### M7 回归

新增或扩展回归覆盖：

- [x] `caseSearchFiles`
- [x] `caseCopyMoveDeleteFile`
- [x] `caseHttpFetchSSRFDenied`
- [x] `caseHttpFetchRedirectLimit`
- [x] `caseToolSchemaValidation`
- [x] `caseMcpPromptInjectionDescriptionSanitized`
- [x] `caseMultiStepPlan`
- [x] `caseCheckpointResume`
- [x] 前端构建：`npm run build -w @aurevoy/desktop`

### M7 复盘

已交付：

- 文件工具：新增 `search_files`、`copy_file`、`move_file`/`rename_file`、`delete_file`；
  所有路径继续复用工作区和 symlink 真实路径校验。`delete_file` 默认禁用，启用后仍按
  dangerous 审批，并移入 `.aurevoy-trash`。
- `read_file`：不再因大文件直接失败，而返回截断预览、大小、编码诊断和后续建议。
- `http_fetch`：改为手动 redirect，最多 3 次；每次请求前做 DNS 解析和本机/私网地址拒绝；
  文本内容才进入上下文，二进制只返回元信息；HTML 会移除高风险标签并输出 `cleanedText`
  与链接来源。
- 工具治理：`ToolRegistry.invoke()` 在执行前基于工具 `inputSchema` 做运行时校验；
  MCP 描述做长度截断和 prompt injection 关键词检测，疑似恶意描述不再原样注入模型上下文；
  server 配置里的本地 `riskLevel` 优先于 MCP annotations。
- 计划与 checkpoint：普通任务保留单步降级；文件/网页/命令/产物类目标会生成多步计划，
  工具成功后推进步骤并创建 `checkpoint_created` 事件；恢复任务时 trace 会记录最近 checkpoint。
- 前端工作台：`App.tsx` 已拆出 `useTaskState`、`useSSEStream`、`useSettings`、`useTools`、
  `useMemories`、`useArtifacts`；对话流支持安全 Markdown 渲染、BudgetBar、checkpoint 事件；
  Inspector 展示 checkpoint；历史侧栏支持本地搜索和状态筛选。
- 验证：新增 `npm run regression:m7`，覆盖 M7 文件工具、安全网络、schema validation、
  MCP 描述净化、多步计划和 checkpoint resume；前端构建纳入 M7 完成门槛。

已知边界：

- `delete_file` 当前使用工作区 `.aurevoy-trash`，不是系统级回收站；跨平台系统回收站集成留给 M8。
- `search_files` 是确定性 glob/文本搜索，不做语义索引；大规模知识库索引仍属于 M8。
- `http_fetch` 的 HTML 清洗是轻量实现，不等同完整浏览器 DOM 解析；复杂网页、JS 渲染和截图留给浏览器 MCP 阶段。
- 运行时 schema validation 覆盖当前 JSON Schema 子集，未引入 Zod/Ajv 作为新直接依赖；复杂 schema 关键字需要后续扩展。
- 多步计划采用确定性启发式生成，避免依赖 Provider strict JSON；后续可引入模型生成计划和更细粒度 step/checkpoint 映射。

## Rewind / Edit & Regenerate — 编辑重跑（✅ 已完成）

目标：让用户可以回溯到历史任意一点，编辑输入后重新生成，并支持非破坏性探索。

### Phase 1 — 最小可用：revert + cleanup-on-prompt

- `POST /api/tasks/:id/revert`：把目标消息及之后从活跃历史移除（soft-delete 归档到 `archivedMessages`），
  清除 revert 点之后的 checkpoint、draft artifact 和未完成 plan 步骤
- 前端 `UserBubble` 编辑按钮 → 后端 revert → Composer 回填 `removedContent` → 用户编辑提交 →
  `POST /api/tasks/:id/messages` 以截断后的历史重新进入 Agent 循环
- 不回滚已落盘文件（applied artifact 写入的文件保留不变）
- 存储层新增 `archived_messages` 列，`RevertTaskResponse` 返回 `removedContent`/`removedMessageId`/`removedCount`
- SSE 新增 `reverted` 事件

### Phase 2 — 精细化：多模式 + unrevert

- `RevertMode` 扩展为 `'code_and_conv' | 'conv_only'`：
  - `code_and_conv`（默认）：截断对话 + 清除 checkpoint/artifact/plan
  - `conv_only`：仅截断对话，保留 checkpoint/artifact/plan（文件没问题，只想重新推理）
- `UserBubble` 编辑后显示模式选择面板（两个按钮）
- `POST /api/tasks/:id/unrevert`：从 `archivedMessages` 恢复被截断的消息
- 前端 turn-actions 区新增"撤销编辑"按钮（`hasArchivedMessages` 时可见）
- SSE 新增 `unreverted` 事件

### Phase 3 — 非破坏性：branch + compact

- `POST /api/tasks/:id/branch`：克隆父任务到指定消息为止的所有消息，
  每条消息分配新 ID（含 `toolCallId` 重映射），新任务 `parentTaskId` 指向原任务
- `POST /api/tasks/:id/compact`：将指定消息范围发给 LLM 生成 ≤200 字摘要，
  替换为一条 `role:'system'` 摘要消息，释放上下文窗口空间
- 前端 `UserBubble` 新增分支按钮（fork 图标）；turn-actions 区消息超过 4 条时出现"压缩上下文"按钮
- 存储层新增 `parent_task_id` 列
- SSE 新增 `branched`、`compacted` 事件

已知边界：

- `code_only` 模式（仅回滚文件、保留对话）需要增强 checkpoint 系统以存储文件快照，当前未实现。
- branch 创建的新任务在侧栏中作为独立任务显示，未实现父子分组展示。
- compact 的摘要质量取决于 LLM 能力，不做二次校验；摘要失败时保留原消息不变。

## M8 — 知识库、评测、浏览器与交付体验

目标：让 Aurevoy 从单次任务执行，进入长期资料理解、持续质量改进和普通用户发布阶段。

### M8.1 知识库与 RAG

短期不直接上向量库，先做文件搜索；满足触发条件后再引入语义召回。

触发条件：

- 用户主动启用知识库。
- 或工作区文件数超过 100 且文件名/正则搜索无法满足召回质量。
- 或任务明确需要“参考长期资料/笔记/模板”。

交付项：

- [ ] 建立知识库设置入口，明确哪些目录会被索引。
- [ ] 增加索引状态表，记录文件路径、hash/mtime、chunk 数、索引时间。
- [ ] 评估并引入 `sqlite-vec`，如决定引入，更新 `docs/TECH_STACK.md`。
- [ ] 新增 `index_files` 工具。
- [ ] 新增 `recall` 工具。
- [ ] 前端展示来源：文件、片段、更新时间、置信度。
- [ ] 禁用或删除知识库时，索引必须可清理。

验收：

- 用户能让 Agent 参考本地资料生成报告，并看到来源。
- 索引失败、权限不足、格式不支持有明确诊断。

### M8.2 Agent 评测与质量门禁

- [ ] 建立 `scripts/evals/` 目录。
- [ ] 建立至少 20 个真实个人任务样例。
- [ ] 每个样例定义：
  - 输入目标。
  - fixture 工作区。
  - 允许工具。
  - 预期产物。
  - 安全约束。
  - 评分规则。
- [ ] 实现规则评分器。
  - 工具是否正确。
  - 参数是否正确。
  - 是否越权。
  - 是否请求审批。
  - 是否生成产物。
- [ ] 可选实现 LLM Judge，只用于质量评分，不用于安全门禁。
- [ ] 新增数据模型：
  - eval run id。
  - sample id。
  - score。
  - failure category。
  - provider/model/settings snapshot。
- [ ] 新增命令：`npm run eval:agent-usability`。

发布门槛：

- Smoke：`npm run typecheck && npm run build`，30 秒级。
- Regression：M3 + M4 + M5 + M6，5 分钟级。
- Release：`npm run eval:agent-usability`，30 分钟级。
- 安全合规率必须 100%；任务完成率初期目标 >= 70%。

### M8.3 浏览器自动化

- [ ] 优先通过 Playwright MCP Server 接入，不自建浏览器工具。
- [ ] 建立推荐 MCP 配置模板，但不自动启用高风险浏览器动作。
- [ ] 浏览器工具必须显示来源、风险等级、审批要求和最近错误。
- [ ] 截图、DOM 摘要、控制台错误进入 artifact。

验收：

- 用户可授权 Agent 打开页面、截图并总结页面内容。
- 浏览器动作失败可在 MCP 状态和 trace 中诊断。

### M8.4 发布体验

- [ ] macOS 打包、签名、公证、自动更新。
- [ ] Windows WebView2、原生模块重编、路径权限验证。
- [ ] 首次启动向导：
  - Provider/API Key。
  - 工作区。
  - 数据目录。
  - 工具权限。
  - MCP 配置。
- [ ] 运行健康页：
  - Provider 连通性。
  - 模型列表。
  - MCP 状态。
  - 数据库位置。
  - 沙箱状态。
  - 最近错误。
- [ ] 数据导出和清理：
  - 任务。
  - trace。
  - memory。
  - artifact。

验收：

- 普通用户无需命令行即可完成配置并跑通第一个真实任务。
- 升级后旧任务、记忆、设置、trace、artifact 可迁移或有明确兼容提示。

## 3. 首个纵向切片：本地材料整理 Agent

优先实施这个切片，不要先横向铺满全部工具。

用户目标：

```text
请阅读工作区中 docs/ 目录下的所有 Markdown 文件，生成一份按主题分类的摘要报告，
包含来源引用，保存为 docs/SUMMARY.md。
```

为什么选它：

- 它直接验证 Aurevoy 的核心定位：从自然语言目标到本地产物。
- 基于现有文件工具即可起步，只需要新增 artifact 和追问能力。
- 能覆盖计划、文件读取、来源引用、产物预览、写入审批、trace 回看和失败恢复。
- fixture 容易构造，适合成为 `m6-regression` 和 `eval:agent-usability` 的第一条样例。

端到端要求：

- [ ] Agent 展示多步计划：扫描目录、读取文件、提取主题、生成报告、保存文件。
- [ ] 目录不存在时调用 `ask_user` 追问新路径。
- [ ] 生成 Markdown draft artifact。
- [ ] 前端可预览 artifact。
- [ ] 用户确认后调用 `apply_artifact` 写入 `docs/SUMMARY.md`。
- [ ] 报告包含来源文件引用。
- [ ] trace 记录文件读取、artifact 创建、审批、写入结果。
- [ ] 回归覆盖：
  - 成功生成。
  - 目录不存在并追问。
  - 用户拒绝写入。
  - 文件过大或上下文预算不足。

## 4. 推荐任务拆分顺序

最小实施顺序：

1. `packages/shared` 增加 M6 类型和事件。
2. `store/db.ts` 增加任务 JSON 列迁移。
3. `loop.ts` 增加预算统计骨架。
4. `create_artifact` 工具和 `artifact_created` 事件。
5. 前端 `ArtifactCard` 和 Inspector artifact 列表。
6. `apply_artifact` 工具和审批写入。
7. `ask_user` 工具、clarification API 和前端 `ClarificationCard`。
8. Provider usage 解析和 `token_usage` 事件。
9. `m6-regression.mjs`。
10. 再做命令执行、文件搜索和 http_fetch 安全加固。

这样做的原因：

- 先让“产物可见”落地，用户能感知价值。
- 再补追问，避免 Agent 在目标不清时硬猜。
- 然后补预算和 token usage，给高风险/长任务加治理。
- 最后开放命令执行，避免先上高风险能力导致治理滞后。

## 5. 工具治理矩阵

| 工具类别 | 风险 | 默认 | 审批 | 必要回归 |
|---|---|---|---|---|
| 只读文件：`list_directory`、`read_file`、`search_files` | safe | 开 | 否 | 正常读取、路径越界、大文件 |
| 网络：`http_fetch` | caution | 开 | 是，可配置白名单 | SSRF、重定向、超大响应、HTML 清洗 |
| 追问：`ask_user` | safe | 开 | 否 | 暂停、回复继续、超时、取消 |
| 产物草稿：`create_artifact` | safe | 开 | 否 | 创建、预览、大小限制 |
| 应用产物：`apply_artifact` | dangerous | 开 | 是 | 覆盖预览、拒绝、备份、路径越界 |
| 文件复制/移动 | caution | 开 | 是 | 成功、冲突、路径越界、拒绝 |
| 文件删除 | dangerous | 关 | 是 | 回收站、拒绝、系统目录、路径越界 |
| 命令执行 | dangerous | 关 | 是，可配置白名单 | 超时、输出截断、cwd 限制、env allowlist |
| MCP 工具 | inferred / override | 按 server | 非 safe 审批 | 描述净化、server 失败、输出截断 |
| 记忆：`remember` | safe | 开 | 否 | 长度限制、来源、启停注入 |

## 6. 可复现 Agent 用户任务样例

这些样例是 `eval:agent-usability` 的候选集：

| # | 任务 | 核心能力 | 预期结果 |
|---|---|---|---|
| 1 | 阅读 `docs/` 下 Markdown，生成 `docs/SUMMARY.md` | 文件读取、artifact、写入审批 | Markdown 报告 |
| 2 | 搜索所有包含 `TODO` 的文件并按优先级整理 | `search_files`、来源引用 | 列表报告 |
| 3 | 抓取一个公开网页并总结要点 | `http_fetch`、清洗、引用 | 带 URL 来源的摘要 |
| 4 | 将 `notes/` 下文件按日期重命名 | 文件列表、move、审批 | 重命名日志 |
| 5 | 运行 `npm run typecheck` 并总结失败原因 | 命令执行、stdout artifact | 错误报告 |
| 6 | 读取 CSV，统计空值并生成分析报告 | 文件读取、数据分析、artifact | Markdown 报告 |
| 7 | 参考历史周报模板整理本周纪要 | 文件搜索、知识库 | 周报 |
| 8 | 检查所有 `package.json`，列出过时依赖 | 文件搜索、命令执行 | 依赖建议 |
| 9 | 打开网页截图并描述页面 | Playwright MCP、artifact | 截图和描述 |
| 10 | 翻译 `report.md` 并保存 `report-en.md` | 文件读写、artifact | 英文文件 |
| 11 | 分析长期记忆，找出冲突或过时项 | memory、追问确认 | 清理建议 |
| 12 | 创建并运行一个小脚本，保存运行结果 | 文件写入、命令执行 | 脚本和 stdout |

## 7. 每项能力的完成定义

任何 Agent 能力只有同时满足以下条件，才能在本文标记完成：

- 共享契约在 `packages/shared/src/index.ts` 定义清楚。
- 后端真实接入 runtime，不是前端假状态。
- 工具经过 `ToolRegistry`，声明 schema、风险等级和失败路径。
- 非 safe 动作有审批或显式关闭策略。
- 输入、工具调用、审批、产物、错误和 done 都有 trace。
- 前端能展示用户需要知道的状态，而不是只显示技术日志。
- 至少有一个成功回归、一个失败回归；高风险能力还要有审批拒绝回归。
- 不硬编码密钥，不越过工作区，不默认暴露 shell。
- 文档同步更新：`docs/API.md`、`docs/ARCHITECTURE.md`、`docs/CONVENTIONS.md` 或 `docs/TECH_STACK.md` 视改动范围补齐。

## 8. 参考资料

本路线图的研究依据见：

- [`docs/research/agent-delivery-deepresearch-report.md`](./research/agent-delivery-deepresearch-report.md)
- [`docs/research/agent-delivery-deepresearch-brief.md`](./research/agent-delivery-deepresearch-brief.md)

外部资料以报告中的一手链接为准，包括 OpenAI Agents SDK、Anthropic Agent Patterns、MCP 规范、LangGraph Persistence、Node.js `child_process`、OWASP SSRF、sqlite-vec、Playwright MCP 等。
