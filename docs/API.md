# 接口契约 — API

> Agent 引擎对外的 HTTP API 与 SSE 事件流契约。改前后端接口前后请同步本文。
> 所有类型定义在 `packages/shared/src/index.ts`，本文为其说明与示例。

- Base URL：`http://127.0.0.1:8787`（常量 `AGENT_DEFAULT_BASE_URL`，可经环境变量改）
- 编码：JSON（`application/json`），SSE 为 `text/event-stream`
- 仅监听本机回环地址，不对外网暴露

## 1. HTTP 端点

### GET `/api/health`
健康检查 / 前端探测引擎是否在线。
```json
// 200 → HealthResponse
{ "status": "ok", "version": "0.1.0", "uptimeMs": 1442, "provider": "openai:gpt-4o-mini" }
```
- `provider`：当前生效的 LLM Provider 名，形如 `"openai:<model>"`（如 `"openai:gpt-4o-mini"`）。
  未配置 API Key 时为 `"unconfigured"`。前端据此在输入框展示当前模型来源。

### GET `/api/tools`
列出已注册工具（调试 / 前端展示）。
```json
// 200 → ToolDescriptor[]
[{ "name": "get_current_time", "description": "获取当前的 ISO 时间戳",
   "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
   "enabled": true, "source": { "type": "builtin" } }]
```
MCP server 暴露的工具会在 Agent 启动期注册进同一个列表，名称格式为
`mcp_<server>_<tool>`（非法字符会转为 `_`，超长名称会附加稳定 hash）。
禁用工具仍会出现在列表中，但不会提供给模型，直接调用也会返回明确失败。
M7 起，MCP 工具描述会做长度截断和 prompt injection 关键词净化；server 配置中的本地
`riskLevel` 优先于 MCP annotations。

### PATCH `/api/tools/:name`
启用或停用一个工具。
```json
// 请求体 UpdateToolRequest
{ "enabled": false }
```
命中返回更新后的 `ToolDescriptor`；工具不存在 → `404`；字段缺失 → `400`。

### GET `/api/skills`
列出已发现的 skill（Tier 1 catalog，不含 body）。
```json
// 200 → SkillListResponse
{ "skills": [
  { "name": "web-search", "description": "搜索网页获取最新信息、文档、技术方案。支持多轮搜索和结果整合。", "allowedTools": ["web_search","web_fetch","read","open_file","list_directory","grep","search_grep"], "license": null, "compatibility": null, "metadata": { "version": "1.0" }, "sourceDir": "builtin", "location": "/path/to/skills/builtin/web-search/SKILL.md" },
  { "name": "browser", "description": "浏览器自动化——打开网页、截图、获取DOM摘要、抓取控制台错误。", "allowedTools": ["web_fetch","web_search","read","open_file"], "license": null, "compatibility": "Requires Playwright MCP Server", "metadata": { "version": "1.0" }, "sourceDir": "builtin", "location": "/path/to/skills/builtin/browser/SKILL.md" }
]}
```
- Agent Skills 标准格式：每个 skill 是一个目录含 `SKILL.md`（+可选 scripts/references/assets）
- 发现路径：`.aurevoy/skills/`（Aurevoy 原生）+ `.agents/skills/`（跨客户端标准）
- 加载优先级：预装（builtin）< 用户（user）< 工作区（workspace），后发现的覆盖同名
- 渐进披露：启动仅加载 name+description（Tier 1），激活时加载 body（Tier 2），按需加载资源（Tier 3）

### GET `/api/mcp/status`
查看 MCP server 连接状态。
```json
// 200 → McpStatusResponse
{ "servers": [{ "name": "localTools", "enabled": true, "connected": true, "registeredTools": 3 }] }
```

### GET `/api/tasks`
列出全部任务，按创建时间倒序。返回 `Task[]`。

### GET `/api/tasks/:id`
任务详情。命中返回 `Task`；不存在返回 `404 {"error":"task not found"}`。

### GET `/api/tasks/:id/traces`
任务轨迹回看。命中返回 `TaskTraceListResponse`；不存在返回 `404 {"error":"task not found"}`。
轨迹来自 SQLite `task_traces`，覆盖 LLM 轮次、工具、审批、错误、done 和阶段变化。

### POST `/api/tasks`
创建并**立即异步启动**一个任务。
```json
// 请求体 CreateTaskRequest
{
  "goal": "帮我整理这周的会议纪要",
  "budget": { "maxIterations": 12, "maxToolCalls": 40, "maxWallTimeMs": 300000, "maxOutputBytes": 262144 }
}
```
```json
// 201 → CreateTaskResponse
{ "task": { /* Task */ }, "streamUrl": "/api/tasks/<id>/stream" }
```
- `goal` 为空 → `400 {"error":"goal is required"}`
- `budget` 可选；非法或非正数预算字段会被忽略，未提供字段使用后端默认值。
- 返回后任务在后台执行，进度通过 `streamUrl` 的 SSE 推送。

### POST `/api/tasks/:id/messages`
在**同一任务内追加一轮用户输入并继续执行**（多轮对话）。后端保留该任务的完整
消息历史作为上下文，重新进入 Agent 循环。
```json
// 请求体 ContinueTaskRequest
{ "message": "再帮我把第二点展开说明" }
```
```json
// 202 → ContinueTaskResponse
{ "task": { /* Task（已含新追加的 user 消息） */ }, "streamUrl": "/api/tasks/<id>/stream" }
```
- 任务不存在 → `404 {"error":"task not found"}`
- 任务正在运行 → `409 {"error":"任务正在运行，请等待当前轮结束后再追问"}`
- `message` 为空 → `400 {"error":"message is required"}`
- 续聊复用相同的 `streamUrl`；订阅后会先补发数据库快照（含历史消息）再推送本轮实时事件。

### POST `/api/tasks/:id/resume`
恢复未完成、失败或已取消任务。后端不伪造新的用户消息，而是基于该任务已持久化的
`messages` 重新进入 Agent 循环；若上次中断发生在 assistant `tool_calls` 之后且工具结果尚未写入，
恢复前会补一条可解释的 `role:"tool"` 失败结果，保证 Provider 协议合法且轨迹可回看。
若任务已有 `checkpoints`，恢复 trace 会记录最近 checkpoint，便于用户理解从哪里继续。
```json
// 202 → ResumeTaskResponse
{ "task": { /* Task（已回到 pending/initializing） */ }, "streamUrl": "/api/tasks/<id>/stream" }
```
- 任务不存在 → `404 {"error":"task not found"}`
- 任务正在运行 → `409 {"error":"任务正在运行，不能重复恢复"}`
- 任务已完成 → `409 {"error":"已完成任务不需要恢复"}`
- 引擎启动时会扫描 SQLite 中遗留的 `pending | planning | running | paused` 任务；
  这些任务说明上次进程中断前未正常收尾，会被标记为 `failed/failed` 并写入可解释恢复轨迹，
  之后可由该端点显式恢复。

### POST `/api/tasks/:id/revert`
编辑重跑（对话截断语义）。把目标消息及其之后的所有消息从活跃历史移除（归档到 `archivedMessages`），
任务回到该消息发送前的状态。前端随后用 `messages` 端点把编辑后的文本作为该点的新输入。
```json
// 请求体 RevertTaskRequest
{ "messageId": "<目标消息 id>", "mode": "code_and_conv" }
```
```json
// 200 → RevertTaskResponse
{ "task": { /* Task（已截断） */ }, "removedContent": "原消息文本", "removedMessageId": "<id>", "removedCount": 5 }
```
恢复模式 `RevertMode`：
- `code_and_conv`（默认）：截断对话 + 清除 revert 点之后的 checkpoint、draft artifact 和未完成 plan 步骤
- `conv_only`：仅截断对话，保留 checkpoint、artifact 和 plan（文件没问题，只想重新推理）

- 任务不存在 → `404 {"error":"task not found"}`
- 消息不存在 → `404 {"error":"message not found in task history"}`
- 任务正在运行 → `409 {"error":"任务正在运行，请等待当前轮结束后再编辑"}`
- 不回滚已落盘文件（applied artifact 写入的文件保留不变）

### POST `/api/tasks/:id/unrevert`
撤销上一次 revert：从 `archivedMessages` 恢复被截断的消息到活跃历史。仅在 revert 后尚未
提交新的 continue 时可用（`archivedMessages` 非空）。
```json
// 200 → UnrevertTaskResponse
{ "task": { /* Task（已恢复） */ }, "restoredCount": 5 }
```
- 没有可撤销的操作 → `409 {"error":"没有可撤销的编辑操作"}`
- 任务正在运行 → `409`

### POST `/api/tasks/:id/branch`
从指定消息处分支出一个新任务（非破坏性 fork）。克隆父任务到目标消息（含）为止的所有消息，
每条消息分配新 ID（含 `toolCallId` 重映射），新任务独立演进，原任务不受影响。
```json
// 请求体 BranchTaskRequest
{ "messageId": "<分支点消息 id>", "goal": "可选的新目标" }
```
```json
// 201 → BranchTaskResponse
{ "task": { /* Task（新任务，parentTaskId 指向原任务） */ }, "streamUrl": "/api/tasks/<newId>/stream" }
```
- 消息不存在 → `404`
- 缺 `messageId` → `400`

### POST `/api/tasks/:id/compact`
将指定消息范围压缩为 LLM 生成的摘要，释放上下文窗口空间。替换原消息为一条 `system` 摘要消息。
```json
// 请求体 CompactTaskRequest
{ "fromMessageId": "<起始消息 id（可选）>", "toMessageId": "<结束消息 id（可选）>" }
```
```json
// 200 → CompactTaskResponse
{ "task": { /* Task（已压缩） */ }, "originalCount": 12, "summaryLength": 186 }
```
- 范围无效 → `400`
- 任务正在运行 → `409`
- `fromMessageId`/`toMessageId` 缺省时覆盖全部消息

### GET `/api/tasks/:id/stream`  (SSE)
订阅某任务的实时事件流。
- 响应头：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`
- 每个事件：`data: <AgentEvent 的 JSON>\n\n`
- 心跳：每 15s 发 `: ping\n\n`（注释行，前端应忽略）
- 收到 `type:"done"` 后服务端主动关闭连接。

### POST `/api/tasks/:id/cancel`
取消进行中的任务（中断其 LLM 流）。返回 `{ taskId, cancelling, status }`；
`cancelling=false` 表示无活跃句柄（任务可能已结束）。任务不存在 → `404`。

### POST `/api/tasks/:id/approvals`
对一次工具调用做出审批决策（响应 `approval_request` 事件）。
```json
// 请求体 ApprovalDecisionRequest
{ "callId": "<approval_request 事件里的 call.id>", "approved": true }
```
```json
// 200 → ApprovalDecisionResponse
{ "taskId": "<id>", "callId": "<id>", "delivered": true }
```
- `delivered=false`：无对应的待审批项（已超时/已决策/不存在）。
- 审批只作用于当前这一次工具调用，不产生会话级或命令前缀级自动批准。
- 字段缺失或类型错误 → `400`；任务不存在 → `404`。

### POST `/api/tasks/:id/auto-mode-resume`
恢复因安全暂停（连续自动批准数达上限）而暂停的 auto mode。重置连续计数，恢复原有自动等级。
```json
// 200 → { taskId, resumed: true, level: "auto-edit" }
```
- 任务未处于暂停状态 → `409 {"error":"task is not in auto-mode paused state"}`
- 任务不存在 → `404`。

### POST `/api/tasks/:id/plan-approval`
历史兼容端点。主 Agent 执行链已固定为 Pi AgentHarness，当前后端不再生成独立 Plan Agent 审批请求。
```json
// 请求体 PlanApprovalRequest
{ "approved": true }
// 拒绝时可选填理由
{ "approved": false, "reason": "步骤 3 不需要，直接生成报告即可" }
```
```json
// 200 → PlanApprovalResponse
{ "taskId": "<id>", "delivered": true }
```
- `approved=false` 时计划被拒绝，Default Agent 会以单步模式直接执行，拒绝原因回灌给模型供参考。
- `delivered=false`：无对应的待审批项；`approved` 字段缺失或类型错误 → `400`。

### POST `/api/tasks/:id/clarifications/:clarificationId`  (M6)
回复 Agent 的结构化追问。该端点只把真实用户回复投递给当前等待中的任务，不新建任务。
```json
// 请求体 ClarificationAnswerRequest
{ "answer": "docs/SUMMARY.md" }
```
```json
// 200 → ClarificationAnswerResponse
{ "taskId": "<id>", "clarificationId": "<id>", "delivered": true }
```
- `delivered=false`：无对应的待追问项（已超时/已回复/不存在或任务未在等待）。
- `answer` 为空 → `400 {"error":"answer is required"}`；任务不存在 → `404`。
- 回复后后端发布 `clarification_resolved`，并把答案作为 tool result 回灌给模型继续同一任务。

### 任务产物 `/api/tasks/:id/artifacts`  (M6)
任务产物是 Agent 生成的可预览、可确认、可回看的交付物。M6 先支持文本类内容保存在任务 JSON 中。

- `GET /api/tasks/:id/artifacts` → `TaskArtifactListResponse { taskId, artifacts }`
- `GET /api/tasks/:id/artifacts/:artifactId/content` →
  `TaskArtifactContentResponse { taskId, artifactId, content, mimeType? }`
- `PATCH /api/tasks/:id/artifacts/:artifactId`（`UpdateTaskArtifactRequest { status }`）→ `TaskArtifact`

`status` 只能是 `confirmed` 或 `rejected`；非法状态 → `400`；任务或产物不存在 → `404`。
确认/拒绝只更新 artifact 状态并发布 `artifact_updated`；真实写文件仍必须由 Agent 调用
`apply_artifact` 工具，按 `dangerous` 风险等级走审批和工作区路径校验。

### 长期记忆 `/api/memories`  (M4.3)
跨会话长期记忆。每条记录来源（用户手动 / agent 写入）、来源任务、置信度与启停状态。
启用的记忆会作为 system 消息注入每轮 Agent 上下文；禁用后不注入但仍可见可恢复。

- `GET /api/memories` → `MemoryListResponse { memories: MemoryEntry[] }`（含禁用，按更新时间倒序）。
- `POST /api/memories`（`CreateMemoryRequest { content, category?, confidence? }`）→ `201 MemoryEntry`。
  用户手动新增，`source.origin='user'`，默认 `confidence=1`、`enabled=true`。`content` 为空 → `400`。
- `PATCH /api/memories/:id`（`UpdateMemoryRequest { content?, category?, confidence?, enabled? }`）
  → `200 MemoryEntry`。编辑内容/分类/置信度或启停。记忆不存在 → `404`；`category` 非法或内容空 → `400`。
- `DELETE /api/memories/:id` → `200 { id, deleted: true }`；记忆不存在 → `404`。

> Agent 侧通过内置 `remember` 工具写入记忆（`source.origin='agent'`，自动记录来源任务与目标），
> 调用会留下工具轨迹可审计。删除/禁用始终由用户掌控（agent 无删除工具）。

### 知识库 `/api/knowledge-base`  (M8.1)
知识库文件索引与向量检索。需要先配置 Embedding Provider（如 Ollama/nomic-embed-text）。

- `GET /api/knowledge-base/dirs` → `{ dirs: KbDir[] }`。列出已配置的索引目录。
- `POST /api/knowledge-base/dirs`（`{ dirPath, recursive? }`）→ `201 KbDir`。添加索引目录。路径重复 → `409`。
- `DELETE /api/knowledge-base/dirs/:id` → `200 { id, deleted: true }`。删除目录并级联清理索引。
  目录不存在 → `404`。
- `GET /api/knowledge-base/status` → `{ totalFiles, totalChunks, lastIndexed }`。索引状态统计。

工具侧：
- `index_files`（Agent 工具）：遍历已配置目录，对新增/变更文件增量索引（分块+向量化），
  已删除文件自动清理。需先配置目录和 Embedding Provider。
- `recall`（Agent 工具）：对查询进行向量 KNN 搜索，返回 top-K 匹配片段（含文件路径、内容、评分）。

### 项目 `/api/projects`

导入文件夹作为项目。项目目录即为该项目下对话的工作区（文件工具/命令执行的作用域）。
同一目录不可重复导入（`path` 唯一索引）。删除项目时关联对话变为独立对话（软删除）。

- `GET /api/projects` → `ProjectListResponse { projects: Project[] }`（按创建时间倒序）。
- `POST /api/projects`（`CreateProjectRequest { path, name? }`）→ `201 Project`。
  `path` 必须是已存在的目录绝对路径；缺省 `name` 取目录 basename。路径重复 → `409`；路径无效 → `400`。
- `PATCH /api/projects/:id`（`UpdateProjectRequest { name }`）→ `200 Project`。仅支持重命名。项目不存在 → `404`。
- `DELETE /api/projects/:id` → `200 { deleted: true, orphanedTasks: number }`。关联对话的 `project_id` 置空。项目不存在 → `404`。

> 任务创建时可传 `projectId`（`POST /api/tasks`），校验项目存在。任务列表支持 `?projectId=xxx` 过滤，
> `?projectId=standalone` 返回独立对话。

### 运行设置 `/api/settings`  (M5)
设置来自 SQLite 持久化，启动时覆盖环境变量默认值；PATCH 后立即更新内存 runtime。
响应不会回显 API Key，只返回 `apiKeyConfigured`。

- `GET /api/settings` → `RuntimeSettings`
- `PATCH /api/settings`（`UpdateRuntimeSettingsRequest`）→ `RuntimeSettings`
- `GET /api/settings/models` → `ModelListResponse { models: string[] }`：按当前已保存的
  Base URL/API Key 手动拉取一次 OpenAI-compatible `/models`，前端不在打开模型菜单时自动请求。

可更新项：OpenAI 兼容 `baseUrl` / `model` / `temperature` / `timeoutMs` / `apiKey`、
`availableModels` / `enabledModels`、工作区目录、命令执行边界、MCP server JSON、数据清理保留天数。
Provider 设置会清空 Provider 缓存，下一轮任务使用新配置；工作区目录会被文件工具实时读取；
MCP JSON 改动会触发 MCP 工具重载。非法 URL、非法 MCP JSON、空工作区等返回 `400`。

模型列表字段语义：
- `availableModels`：最近一次手动 `GET /api/settings/models` 获取到的完整模型列表，由设置页保存。
- `enabledModels`：用户勾选后允许出现在主界面 Composer 模型菜单中的模型列表。
- 后端兼容旧版 `llm.modelOptions` 持久化键；若新 `enabledModels` 尚不存在，会读取旧值作为迁移来源。
- 后端会保证当前 active `model` 始终包含在 `enabledModels` 中，避免主界面隐藏正在使用的模型。

### 数据管理 `/api/data`  (M5)

- `GET /api/data` → `DataStatusResponse`：返回 SQLite 路径、工作区目录、清理策略、任务/轨迹/记忆计数。
- `GET /api/data/token-usage` → `TokenUsageReport`：汇总所有任务的 Provider usage，包含总览、参与统计的任务数、
  reasoning/cache/cost 字段，以及按 provider/model 分组的 `breakdown`。
- `POST /api/data/cleanup`（`CleanupDataRequest { olderThanDays? }`）→
  `CleanupDataResponse`：删除指定天数以前的终态任务（completed/failed/cancelled）及其轨迹。

## 2. 事件契约：`AgentEvent`

所有事件都带 `taskId`（用于多任务路由）。`type` 是判别字段：

| type | 载荷字段 | 含义 |
|---|---|---|
| `task_created` | `task: Task` | 任务已创建 |
| `status` | `status: TaskStatus` | 任务状态变化 |
| `phase` | `phase: TaskPhase`, `detail?` | Pi harness 细粒度阶段变化 |
| `scout_started` | — | 工作区侦查开始 |
| `scout_report` | `report: ScoutReport` | 工作区侦查报告 |
| `plan_generated` | `plan: PlanStep[]`, `source` | 当前任务计划已生成 |
| `plan_approval_request` | `plan`, `reasoning`, `scoutReport?` | `/plan` 模式请求用户确认计划 |
| `plan_approval_resolved` | `approved`, `reason?` | `/plan` 模式计划审批已完成 |
| `skill_activated` | `skillName`, `allowedTools?`, `description?`, `compatibility?` | Skill：用户或 LLM 通过 `/skill-name` 或 `activate_skill` 工具激活了某个技能 |
| `skill_deactivated` | `previousSkill?` | Skill：当前技能已停用（含上一技能名） |
| `plan` | `plan: PlanStep[]` | 给出/更新完整计划 |
| `step_update` | `step: PlanStep` | 单个计划步骤状态变化 |
| `token` | `delta: string` | LLM 流式输出的增量片段 |
| `message` | `message: Message` | 一条完整消息（通常是助手最终回复） |
| `tool_call` | `call: ToolCall` | 发起一次工具调用 |
| `approval_request` | `call: ToolCall`, `riskLevel` | 非 safe 工具执行前请求用户确认 |
| `tool_result` | `result: ToolResult` | 工具返回结果 |
| `clarification_request` | `clarification: ClarificationRequest` | Agent 信息不足，暂停等待用户补充 |
| `clarification_resolved` | `clarification: ClarificationRequest` | 用户已回复、超时或取消追问 |
| `artifact_created` | `artifact: TaskArtifact` | 创建 draft 任务产物 |
| `artifact_updated` | `artifact: TaskArtifact` | 产物状态或写入路径变化 |
| `checkpoint_created` | `checkpoint: TaskCheckpoint` | 关键步骤完成后创建恢复点 |
| `budget_usage` | `usage: BudgetUsage`, `budget?` | 预算使用量更新 |
| `token_usage` | `usage: AggregatedTokenUsage` | Provider token usage 汇总更新 |
| `reverted` | `messageId`, `removedCount`, `archivedCount` | 编辑重跑：消息已截断并归档 |
| `unreverted` | `restoredCount` | 撤销编辑：归档消息已恢复 |
| `branched` | `parentTaskId`, `messageId`, `messageCount` | 会话分支：新任务已从父任务克隆 |
| `compacted` | `originalCount`, `summaryLength` | 上下文压缩：旧消息已替换为摘要 |
| `content_blocks_added` | `messageId`, `blocks: ContentBlock[]` | Agent 主动推送文件对象到对话（如图片、附件） |
| `auto_mode_state` | `state: AutoModeState` | Auto mode 运行时状态更新（等级切换、暂停、恢复） |
| `done` | `status: TaskStatus` | 任务结束（completed/failed/cancelled） |
| `error` | `message: string` | 执行出错 |

`TaskStatus`：`pending | planning | running | paused | completed | failed | cancelled`

`TaskPhase`：`initializing | planning | thinking | calling_tool | waiting_approval | waiting_clarification | finalizing | failed | cancelled`

### 典型事件序列

无需工具（直接回答）：
```
status(running) → phase(initializing)
  → plan
  → phase(thinking) → token × N
  → phase(finalizing) → message → status(completed) → done(completed)
```

Pi 工具调用循环：
```
status(running)
  → phase(initializing)
  → plan
  → phase(thinking)
  → token × N                       (Pi 模型本轮的文本/思考)
  → phase(calling_tool)
  → tool_call × N                   (Pi 请求调用工具，safe 并行执行)
  → tool_result × N                 (工具执行结果，回灌给模型)
  → phase(thinking)
  → token × N                       (下一轮，带着工具结果)
  → phase(finalizing) → message → status(completed) → done(completed)
```
- P1: 任务启动时先侦查工作区（仅 safe 只读工具，最多 3 轮），再用 LLM 生成结构化计划。
- P2: Pi AgentHarness 依据工具 executionPolicy 选择并行或顺序执行；执行前由 harness `tool_call` hook 统一套用 auto mode 策略。
  每个工具有独立 `invokeWithTimeout`（默认 30s）。
- 计划以降级优先方式呈现：LLM 规划失败时回退到正则启发式。
- 一轮可能有多个并行 `tool_call`（各带独立 `id`），对应多个 `tool_result`。
- 取消时以 `status(cancelled)` + `done(cancelled)` 收尾。
- `phase` 是诊断和 UI 解释用的细粒度阶段，必须来自后端真实状态转换，不能由前端猜测。

未被当前 auto mode 放行的工具需一次性审批：
```
… → tool_call → approval_request          (等待用户)
  → phase(waiting_approval)
  → [POST /api/tasks/:id/approvals]        (批准/拒绝)
  → tool_result                            (批准→执行结果；拒绝→ok:false 错误回灌)
  → token × N → message → done
```
工具的风险等级由 `ToolDescriptor.riskLevel`（`safe`|`caution`|`dangerous`，缺省 `safe`）声明，
`safe` 工具始终自动放行；`plan` 只放行 safe，`auto-edit` 放行 safe/caution 和工作区写入类工具，
`full` 放行全部工具。审批超时（5 分钟）或任务取消视为拒绝。

结构化追问（`ask_user`）：
```
… → tool_call(name=ask_user)
  → clarification_request
  → phase(waiting_clarification)
  → [POST /api/tasks/:id/clarifications/:clarificationId]
  → clarification_resolved
  → tool_result({ answer })
  → phase(thinking) → token × N → message → done
```
追问超时或取消时不会伪造答案；后端会回灌明确失败结果，由模型解释降级或无法继续的原因。

产物生成与应用：
```
… → tool_call(name=create_artifact)
  → artifact_created(status=draft)
  → artifact_updated(status=confirmed|rejected)    (用户在前端确认/拒绝)
  → tool_call(name=apply_artifact)                 (仅需要写入真实文件时)
  → approval_request → tool_result → artifact_updated(status=applied)
```

编辑重跑（revert + edit + continue）：
```
[用户点击历史消息编辑按钮]
  → [POST /api/tasks/:id/revert { messageId, mode }]
  → reverted(messageId, removedCount, archivedCount)
  → [前端 Composer 回填 removedContent]
  → [用户编辑并提交]
  → [POST /api/tasks/:id/messages { message: editedText }]
  → status(running) → phase(thinking) → token × N
  → phase(finalizing) → message → status(completed) → done(completed)
```
- revert 将目标消息及之后归档到 `archivedMessages`，按 `mode` 决定是否清除 checkpoint/artifact/plan。
- `conv_only` 模式仅截断对话，保留 plan 和 checkpoint（文件改动没问题，只想重新推理）。
- unrevert 可在 revert 后、continue 前调用，恢复归档消息。

### 前端消费示例
```ts
import { streamTask, createTask } from "./lib/api";

const { task } = await createTask("帮我做一份周报");
const es = streamTask(task.id, (event) => {
  switch (event.type) {
    case "plan":   renderPlan(event.plan); break;
    case "token":  appendOutput(event.delta); break;
    case "done":   es.close(); break;
  }
});
```

## 3. 数据模型速查（详见 shared）

```ts
interface Task {
  id: string; goal: string; status: TaskStatus; phase: TaskPhase | null;
  plan: PlanStep[]; messages: Message[];
  budget?: TaskBudget; budgetUsage?: BudgetUsage;
  artifacts?: TaskArtifact[]; clarifications?: ClarificationRequest[];
  checkpoints?: TaskCheckpoint[]; tokenUsage?: AggregatedTokenUsage;
  archivedMessages?: Message[];   // revert 归档的消息（unrevert 恢复来源）
  parentTaskId?: string;          // branch 来源的父任务 ID
  createdAt: string; updatedAt: string;   // ISO 8601
}
interface PlanStep { id: string; description: string; status: TaskStatus; }
interface Message  {
  id: string; role: 'user'|'assistant'|'system'|'tool'; content: string; createdAt: string;
  toolCalls?: MessageToolCall[];   // 仅 assistant：本轮请求的工具调用
  toolCallId?: string;             // 仅 tool：关联的 tool_call id
  reasoningContent?: string;       // DeepSeek 思考模式透传，多轮须回传，否则 400
}
interface MessageToolCall { id: string; type: 'function'; function: { name: string; arguments: string /* JSON 串 */ }; }
interface ToolDescriptor { name: string; description: string; inputSchema: Record<string, unknown>; riskLevel?: 'safe'|'caution'|'dangerous'; }
interface ToolCall   { id: string; toolName: string; args: Record<string, unknown>; }
interface ToolResult { callId: string; ok: boolean; output?: unknown; error?: string; }
interface TaskArtifact {
  id: string; type: 'text'|'file'|'diff'|'url'; name: string; content: string;
  mimeType?: string; sourceCallId?: string;
  status: 'draft'|'confirmed'|'applied'|'rejected';
  createdAt: string; appliedAt?: string; appliedPath?: string;
}
interface ClarificationRequest {
  id: string; question: string; options?: string[]; context?: string; callId: string;
  status: 'pending'|'answered'|'timeout'|'cancelled';
  answer?: string; createdAt: string; answeredAt?: string;
}
interface TaskBudget { maxIterations?: number; maxToolCalls?: number; maxWallTimeMs?: number; maxOutputBytes?: number; }
interface BudgetUsage { iterations: number; toolCalls: number; wallTimeMs: number; outputBytes: number; }
interface AggregatedTokenUsage {
  available: boolean; provider?: string; model?: string; updatedAt?: string;
  promptTokens?: number; completionTokens?: number; totalTokens?: number; reasoningTokens?: number;
  cacheReadTokens?: number; cacheWriteTokens?: number; estimatedCostUsd?: number;
}
interface TokenUsageReportBreakdown {
  provider: string; model: string; tasks: number;
  promptTokens: number; completionTokens: number; totalTokens: number; reasoningTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number; estimatedCostUsd: number; updatedAt?: string;
}
interface TokenUsageReport {
  tasks: number; measuredTasks: number; available: boolean;
  promptTokens: number; completionTokens: number; totalTokens: number; reasoningTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number; estimatedCostUsd: number;
  breakdown: TokenUsageReportBreakdown[];
}
interface TaskTraceEntry {
  id: string; taskId: string; kind: 'llm'|'tool_call'|'tool_result'|'approval'|'error'|'done'|'phase';
  phase: TaskPhase | null; iteration?: number; callId?: string; toolName?: string;
  startedAt: string; endedAt?: string; durationMs?: number; ok?: boolean;
  errorCategory?: 'configuration'|'model'|'tool'|'permission'|'timeout'|'cancelled'|'parse'|'unknown';
  tokenUsage: TokenUsage | null;  // Provider 不支持时明确为 null
}
```

## 4. 演进约定

- **新增事件类型**：在 `AgentEvent` 联合里加一个分支（必须含 `taskId`），前端 `switch` 默认忽略未知类型即可向后兼容。
- **审批事件 `approval_request`**：非 safe 工具执行前必须发出该事件，载荷为 `{ call: ToolCall; riskLevel }`。
  循环在执行 `caution`/`dangerous` 工具前等待用户授权；拒绝、超时或取消都必须回灌为明确的工具失败结果。
- **追问事件 `clarification_request`**：只用于信息补充，不等同于审批。前端回复后必须调用
  `POST /api/tasks/:id/clarifications/:clarificationId`，不能把追问当作新任务。
- **产物事件 `artifact_created` / `artifact_updated`**：只表示任务产物状态变化；写入真实文件仍由
  `apply_artifact` 工具承担，并受审批和工作区限制。
- **预算与 token**：`budget_usage` 是后端 runtime 强制计量；`token_usage.available=false`
  表示 Provider 未返回 usage，不允许前端伪造成本。
- **破坏性改动**：改字段语义/删字段时，前后端要同一次提交内联动，并 `npm run build:shared`。
- **鉴权**：当前为本机单用户、无鉴权。若未来引擎需被其它客户端访问，必须先加鉴权（token/本地 socket 校验），不可裸暴露。
- **真实能力**：API 不提供 Mock 成功响应；配置缺失、工具不可用、模型失败等情况必须返回明确错误或事件。

## 5. Agent Runtime 与 LLM Provider 配置

引擎通过环境变量选择 LLM Provider（开发期写在**项目根目录** `.env`，已 gitignore；
模板见根目录 `.env.example`）。Provider 抽象在 `apps/agent/src/llm/`。

主 Agent 执行链固定使用 `@earendil-works/pi-agent-core` 的 `AgentHarness`，不再提供独立 loop 回退开关。

Provider 以 Pi provider id 配置；常用值：

| Provider | 端点 | 说明 |
|---|---|---|
| `openai` | Pi 内置 OpenAI provider | OpenAI 官方模型 |
| `anthropic` | Pi 内置 Anthropic provider | Claude 模型 |
| `deepseek` / `openrouter` / `google` / `xai` / `groq` / `mistral` 等 | Pi 内置 provider | 由 Pi provider catalog 映射 |
| `openai-compatible` | 自定义 `/v1` base URL | Ollama / vLLM / LM Studio / 私有 OpenAI 兼容网关 |

通用环境变量：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `AUREVOY_LLM_PROVIDER` | `openai` | Pi provider id，如 `openai`、`anthropic`、`deepseek`、`openrouter`、`google`、`openai-compatible` |
| `AUREVOY_LLM_API_KEY` | 空 | API Key，**必填**；缺失时执行任务会明确报错 |
| `AUREVOY_LLM_MODEL` | `gpt-4o-mini` | 模型名（Anthropic 默认 `claude-sonnet-4-20250514`） |
| `AUREVOY_LLM_TEMPERATURE` | `0.7` | 采样温度 |
| `AUREVOY_LLM_TIMEOUT_MS` | `120000` | 单轮 LLM 调用超时 |
| `AUREVOY_APPROVAL_TIMEOUT_MS` | `300000` | 工具审批等待超时；超时按拒绝处理 |

OpenAI 兼容专用：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `AUREVOY_LLM_BASE_URL` | `https://api.openai.com/v1` | 主要用于 `openai-compatible` 或自定义 provider；Pi 内置 provider 默认使用自身端点 |

- `AUREVOY_LLM_PROVIDER` 会被映射成 Pi `Model`。
- 主 Agent loop 由 `@earendil-works/pi-agent-core` 执行；Aurevoy 负责本地工具、审批、事件和持久化适配。
- 未配置 API Key 或 provider 不支持时，执行任务会通过 `error` 事件明确报错，
  **不再有占位/Mock 回退**，避免污染真实结果。
- 当前生效的 Provider 名通过 `GET /api/health` 的 `provider` 字段暴露给前端。
- **密钥安全**：Key 只走环境变量，禁止硬编码或提交。

## 6. 沙箱 / 高风险执行配置

命令执行通过 `execute_command` 工具暴露，风险等级 `dangerous`，默认禁用。
设置页或环境变量显式开启后才会提供给模型；执行前仍必须走审批。
实现使用 `child_process.spawn()` 且 `shell:false`，不支持管道/重定向等 shell 语法。

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `AUREVOY_ENABLE_COMMAND_EXECUTION` | `false` | 是否启用基础命令执行工具；默认不提供给模型 |
| `AUREVOY_COMMAND_TIMEOUT_MS` | `30000` | 命令执行超时 |
| `AUREVOY_COMMAND_OUTPUT_LIMIT_BYTES` | `65536` | stdout/stderr 输出上限 |
| `AUREVOY_COMMAND_ENV_ALLOWLIST` | `PATH,HOME,TMPDIR` | 允许传入执行环境的变量名 |
| `AUREVOY_HTTP_FETCH_PRIVATE_HOST_ALLOWLIST` | 空 | `web_fetch` 私网/本机主机精确放行列表，逗号分隔；保留旧环境变量名以兼容已有配置，默认拒绝，主要用于受控内网或回归 fixture |
| `AUREVOY_SEARCH_PROVIDER` | `duckduckgo_lite` | `web_search` 使用的搜索后端：`duckduckgo_lite` / `searxng` / `tavily` / `custom` |
| `AUREVOY_SEARCH_BASE_URL` | 空 | `searxng` / `custom` / `tavily` 的搜索端点 Base URL；SearXNG 默认拼接 `/search?q=...&format=json`，也支持 `{{query}}` 占位 |
| `AUREVOY_SEARCH_API_KEY` | 空 | Tavily 或自定义搜索 API 的密钥；运行时不会回显 |

M7 文件与网络工具边界：

- `search_files`：`safe`，支持文件名 glob 和工作区内文本搜索；返回路径、片段、大小、mtime。
- `copy_file` / `move_file` / `rename_file`：`caution`，工作区内路径校验，目标存在默认拒绝覆盖。
- `delete_file`：`dangerous`，默认禁用；启用后仍需审批，当前移入工作区 `.aurevoy-trash`。
- `read_file`：`safe`，大文件返回截断预览和建议；UTF-8 解码异常会返回诊断，不伪装为可靠文本。
- `web_fetch`：`safe`，拒绝本机/私网/metadata 地址，最多 3 次重定向且每跳重新校验；
  二进制响应只返回元信息，HTML 会清洗 `script/style/noscript/iframe/object/embed` 后输出可读 `content` 和链接。

## 7. MCP server 配置

`AUREVOY_MCP_SERVERS_JSON` 用 JSON 配置可选 MCP servers。当前支持 stdio transport，
启动时连接 server，调用 `listTools()` 发现工具并注册到 Aurevoy 的统一工具注册表；
工具执行时再通过 MCP `callTool()` 转发。

支持 Claude Desktop 风格：
```json
{
  "mcpServers": {
    "localTools": {
      "command": "node",
      "args": ["./mcp/local-tools-server.js"],
      "riskLevel": "caution"
    }
  }
}
```

- `name`：server 名；对象映射写法可省略，使用 key。
- `command` / `args` / `cwd` / `env`：stdio server 启动参数。
- `enabled`：为 `false` 时跳过。
- `riskLevel`：可填 `safe | caution | dangerous`；不填时按 MCP tool annotations 推断，兜底 `caution`。
