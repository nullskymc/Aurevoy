# API 契约

> 本机 Agent 引擎 HTTP + SSE。类型与字段真相：`packages/shared/src/index.ts`。  
> Base：`http://127.0.0.1:8787`（`AGENT_DEFAULT_BASE_URL` / env 可改）。仅回环。

## 约定

- JSON 请求/响应；SSE：`text/event-stream`，事件体为 `AgentEvent` JSON。图片附件以 data URL 随任务请求上传，单张上限 20MB；引擎落盘后任务历史只保存内部路径。
- 鉴权：Agent 每次启动生成内存 Bearer token；受信任 Origin 先 GET `/api/auth/bootstrap` 获取本次会话令牌，后续 HTTP 与 SSE 均带 `Authorization: Bearer …`。默认 CORS 只允许 Tauri 与本地开发端口，外部 Web UI 必须显式设置 `AUREVOY_CORS_ORIGINS`。令牌不写入 SQLite、日志或诊断导出。
- 改接口：先 shared → `build:shared` → agent / web-ui。

## 端点一览

### 系统 / 工具 / Skill / MCP

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 在线探测；`provider` 如 `openai:model` 或 `unconfigured` |
| GET | `/api/auth/bootstrap` | 仅允许配置 Origin；返回本次进程内存会话 token |
| GET | `/api/health/diagnostics` | 本地诊断：LLM、SQLite、工作区、Embedding、sqlite-vec 与 KB 索引；不调用上游模型 |
| GET | `/api/tools` | 已注册工具（含 MCP）；禁用仍列出但不可调 |
| PATCH | `/api/tools/:name` | `{ enabled }` |
| GET | `/api/skills` | Skill catalog（无 body） |
| GET | `/api/skills/:name` | Skill 详情（含 SKILL.md body） |
| POST | `/api/skills/reload` | 重扫 skill |
| POST | `/api/skills/install` | 从 Git 安装；body 必须含 `repoUrl`、非空 `skillPaths` 和至少 20 字符的 `inspectionSummary`，可带 `inspectedSource` |
| PATCH | `/api/skills/:name` | `{ enabled }` 启停 |
| DELETE | `/api/skills/:name` | 卸载用户/系统 skill |
| GET | `/api/mcp/status` | MCP 连接状态、错误、已注册工具数及最近一次工具集合变化 |
| POST | `/api/mcp/test` | 一次性连接并枚举工具，不保存或注册配置 |

MCP 工具名：`mcp_<server>_<tool>`（净化/截断描述；本地 `riskLevel` 优先）。配置经 `PATCH /api/settings` 保存后会重载：支持本地 `stdio`（`command`、`args`、可选 `cwd` / `env`）及远程 `streamable-http`（`url`、可选 `headers`）两种传输。浏览器命名的 MCP 可选 `browserPermissionProfile`：`read_only`（默认）、`download`、`login`、`submit`；profile 之外的浏览器工具不会注册。敏感 header/env 值会移入 SQLite 本机凭据表，设置 JSON 和导出只保留占位符；缺失凭据不会把占位符发送给上游。单个服务器连接失败只标记该服务器不可用，不会阻断引擎启动。连接测试只在用户明确点击时启动一次临时客户端。

`/api/mcp/status` 中每个服务器可返回 `toolNames`、`toolRisks` 和 `changes`：`changes` 是最近一次初始化或重载相对上一份成功快照的 `added`、`removed`、`risk_changed` 工具差异。差异仅用于可观测性和设置页提示，不会自动启用、禁用或执行工具。

### 任务

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/tasks` | 轻量 `TaskSummary[]` 列表（不含消息/计划）；`?projectId=` / `standalone` |
| GET | `/api/tasks/:id` | 详情 |
| GET | `/api/tasks/:id/traces` | 轨迹 |
| GET | `/api/tasks/:id/session-tree` | Pi 原生会话树安全投影（节点、父子关系、当前 leaf） |
| POST | `/api/tasks/:id/session-tree/navigate` | 将当前 leaf 切换到指定节点，并返回更新后的任务与会话树 |
| PUT | `/api/tasks/:id/session-tree/labels/:targetId` | 写入或清除会话树节点标签 |
| GET | `/api/tasks/:id/stream` | **SSE** |
| POST | `/api/tasks` | 创建并异步跑；body `goal`、可选 `projectId`/`budget`/附件 |
| POST | `/api/tasks/:id/messages` | 续聊；空闲则 `addUserTurn`+harness；运行中 steering/follow_up |
| POST | `/api/tasks/:id/queue/clear` | 撤回尚未注入的 steering/follow_up 队列 |
| POST | `/api/tasks/:id/resume` | 从历史恢复（不伪造用户句；可补悬空 tool result） |
| POST | `/api/tasks/:id/budget/continue` | 预算触顶后续跑（可选扩容 lifetime / run） |
| POST | `/api/tasks/:id/cancel` | 取消 |
| DELETE | `/api/tasks/:id` | 删除 |
| POST | `/api/tasks/:id/approvals` | 工具审批 |
| POST | `/api/tasks/:id/auto-mode-resume` | 解除 auto 安全暂停 |
| POST | `/api/tasks/:id/clarifications/:id` | 回答追问 |
| POST | `/api/tasks/:id/revert` | 编辑重试截断（见下） |
| POST | `/api/tasks/:id/unrevert` | 撤销截断（仅归档仍在时） |
| POST | `/api/tasks/:id/branch` | 分叉新任务 |
| POST | `/api/tasks/:id/compact` | 消息范围压成摘要 |

### 自动化任务配方

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/automations` | 列出本地任务配方 |
| POST | `/api/automations` | 创建配方；body 为 `name`、`goal`，可选 `projectId`、`executionMode`、预算、`cadence`、`enabled` |
| GET | `/api/automations/:id` | 获取配方状态 |
| PATCH | `/api/automations/:id` | 更新名称、目标、项目、预算、频率或启停；启用定时配方会生成 `nextRunAt` |
| DELETE | `/api/automations/:id` | 删除配方；已经创建的任务保留 |
| POST | `/api/automations/:id/run` | 立即触发一次；运行中重复触发返回 `409` |
| POST | `/api/automations/test-run` | 保存前以真实普通任务试跑草稿，不创建配方或运行历史 |
| GET | `/api/automations/:id/runs` | 最近运行记录及关联任务 |

`cadence` 取 `manual`、`hourly`、`every_6_hours`、`daily`、`weekly`。定时运行只创建普通 `Task`，任务的 `automationId` 用于来源追踪；审批、预算、暂停、工具风险和 Pi session tree 仍由既有任务主链控制。Agent 重启后调度器读取 SQLite 中未到期配方和未收敛运行记录继续诊断。

**常见状态码：** `404` 不存在；`409` 冲突（运行中不可 revert 等）；`400` 参数；创建/续聊成功多为 `201`/`202`。

#### Pi 会话树 `session-tree`

- 返回 Aurevoy 产品消息节点及安全的摘要/模型/思考变化节点；产品消息节点仍使用 `messageId`，其余节点使用稳定哈希 ID，不暴露 Pi 私有 ID、完整提示词、图片或工具结果。
- completion gate、max-steps 等 Pi 内部控制消息没有 Aurevoy message 映射，因此不进入响应，也不可导航。
- 会话树快照独立保存在 SQLite；同一任务续聊时从原 leaf 恢复。
- 导航 Body 为 `{ targetId, summarize?, customInstructions? }`，`targetId` 必须指向用户消息；`summarize=true` 时用当前任务模型生成被放弃分支摘要。assistant、tool、摘要和配置节点都不可作为切换目标。任务运行中、目标节点不可导航或任务包含图片消息时返回 `409`；含图片会话仍可只读浏览树。成功后任务进入可继续的 `pending`。
- 导航只切换对话上下文，不回滚工作区文件；UI 会在确认按钮旁明确提示这一边界。
- `Task.messages` 仍是产品级消息真相。revert/编辑造成消息前缀变化时，后端会从当前活跃消息安全重建 Pi 树，避免沿错误分支继续。

#### 续聊 `messages`

- Body：`message`，可选 `attachments`、`delivery: steering|follow_up`。  
- 成功写入新 user 消息后**清空** `archivedMessages`。  
- 运行中：投递 Pi 队列；队列不可用 → `409`。
- 撤回：`queue/clear { kind: steering|follow_up|all }` 只清除尚未注入模型上下文的消息；已经被当前 turn 消费的消息不可改写。

#### 编辑重试 `revert` + `messages`

1. UI 内联确认编辑稿。  
2. `POST revert { messageId, mode? }`：截断并归档；`mode=code_and_conv|conv_only`。  
3. 立刻 `POST messages` 用**编辑稿**（及原附件）。  
4. `removedContent` 仅诊断，**不得**覆盖用户编辑稿。  
5. 不回滚已落盘 applied 文件。  
6. `unrevert`：continue 失败等「归档仍在」场景。

#### 预算

- 双层：本轮 `budget`/`budgetUsage` + 寿命 `lifetimeBudget`/`lifetimeUsage`。  
- 触顶：`status=paused`、`phase=waiting_budget`，事件 `budget_exceeded` + `done(paused)`（非 failed）。

### 产物

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/tasks/:id/artifacts/:artifactId` | 元数据/内容（含名称、类型、来源任务、更新时间、落盘位置） |
| PATCH | `/api/tasks/:id/artifacts/:artifactId` | 确认/拒绝等状态 |

### 记忆 / 知识库 / 项目 / 工作区

| 域 | 路径 | 说明 |
|---|---|---|
| 记忆 | `GET/POST /api/memories`，`PATCH/DELETE /api/memories/:id` | CRUD + 启停 |
| KB | `GET/POST/DELETE .../knowledge-base/dirs`，`GET .../status` | 索引目录与统计；Agent 侧 `index_files`/`recall` |
| 项目 | `GET/POST /api/projects`，`PATCH/DELETE /api/projects/:id` | 文件夹工作区；删项目软解绑任务 |
| 工作台 | `GET /api/workspace/read`，`delete` / `rename` / `copy` | 按 `taskId`/`projectId` 解析根目录后读写浏览 |

### 设置 / 数据

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/PATCH | `/api/settings` | Runtime 设置；**不回显** API Key，仅 `apiKeyConfigured` |
| GET | `/api/settings/models` | 当前激活 Provider 拉模型列表 |
| GET | `/api/data` | DB/工作区/计数 |
| GET | `/api/data/token-usage` | 用量汇总 |
| GET | `/api/data/task-metrics` | 脱敏的任务完成/失败/恢复/介入/重试/耗时汇总与 token 用量 |
| POST | `/api/data/export` | 下载脱敏 JSON；默认仅任务元数据，`{ includeTaskMessages: true }` 才附带消息正文 |
| POST | `/api/data/database-backup` | 下载 SQLite 原生备份；备份生成后做 `quick_check`，磁盘不足返回 `507` |
| POST | `/api/data/cleanup` | 清理旧终态任务，并级联删除轨迹、图片分片与 Pi 会话树；`olderThanDays` 范围为 1–3650 |

数据导出由 `DataExportPayload` 明确投影：结构化字段不包含 API Key/OAuth、MCP JSON、代理地址、数据库/工作区/项目/附件路径、图片二进制、富内容 payload、工具参数或原始轨迹；用户目标、计划、记忆文本以及显式选择的任务消息仍可能包含用户隐私或路径，分享前应检查。

SQLite schema 使用 `PRAGMA user_version` + `schema_migrations` 记录版本。启动升级在单事务内执行；检测到已有旧库时会在升级前生成带版本和时间戳的副本。独立备份恢复代码位于 `apps/agent/src/store/database-maintenance.ts`，恢复必须在引擎离线后执行，并在替换前后验证 `quick_check`。

多 Provider：每槽位独立 key/baseUrl/model/列表；`PATCH` 切换 `provider` 会激活对应槽位。  
`search.preferNative` 控制搜索策略：开启后，Responses wire protocol 使用
`{ "type": "web_search" }`，Anthropic Messages 使用
`{ "type": "web_search_20250305", "name": "web_search" }`。兼容端不支持服务器搜索时，
同一轮自动回退原协议与 Aurevoy 本地 `web_search` 后端。
Provider 托管搜索会标准化为普通 `tool_call` / `tool_result` 事件，并以
`Message.toolCalls[].providerExecuted=true` 和配对 tool 消息持久化；恢复上下文时不会交给本地执行器重放。
`enabledModels` 必含当前 active model。
`memoryRecallEnabled` / `kbRecallEnabled` 控制任务 run 起点的有界隐式召回；关闭时不注入。启用多个来源时并行执行，记忆或 KB 单独失败只跳过该来源，另一来源仍可注入；合并后的召回提示有总字符上限，避免两个来源分别截断后共同挤占上下文。

## SSE：`GET /api/tasks/:id/stream`

- 每个线上事件包含任务内递增的 `seq`、服务端发出时间 `emittedAt`，并以 SSE `id` 同步该序号。
- 客户端已经通过 POST/GET 获得 Task 时传 `snapshot=0&afterSeq=0`，服务端仅回放建连空窗内的增量事件。
- 短线重连通过 `Last-Event-ID` 回放后续事件；短期环形日志出现缺口时自动回退 `task_created` 完整持久快照。
- 外部/旧客户端不传 `snapshot=0` 时，仍以 `task_created` 完整快照开始。
- 连续 `token` 会在短时间窗内无损合并，非 token 事件到来前强制排空以保持顺序。
- 客户端在 `done` / 卸载时关闭连接。
- Web UI 通过 Performance Timeline 写入 `aurevoy:task-request:*` 与 `aurevoy:sse:{connect-start|open|first-event|first-token}:*` 标记；事件标记 detail 含 `seq` 与估算的 `transportMs`。

### 事件类型（摘要）

| type | 含义 |
|---|---|
| `task_created` / `task_title` | 任务创建 / 标题 |
| `status` / `phase` | 生命周期 / 细阶段 |
| `plan` / `step_update` / `plan_generated` | 计划 |
| `scout_*` | 工作区侦查 |
| `token` / `message` / `message_start` | 流式与完整消息 |
| `tool_call` / `tool_result` / `tool_progress` / `approval_request` | 工具与审批 |
| `subagent_updated` | 子代理运行快照 |
| `clarification_*` | 追问 |
| `artifact_*` / `checkpoint_created` | 产物与检查点 |
| `budget_usage` / `budget_exceeded` / `token_usage` | 预算与用量 |
| `reverted` / `unreverted` / `branched` / `compacted` | 会话控制 |
| `queue_update` / `retry_status` / `model_updated` / `task_resumed` | 队列、重试、会话模型与重启恢复 |
| `content_blocks_*` | 主动附件 / 生成式 UI |
| `skill_*` / `auto_mode_state` | Skill / auto 状态 |
| `done` / `error` | 结束 / 错误 |

`TaskStatus`：`pending|planning|running|paused|completed|failed|cancelled`  
`TaskPhase`：`initializing|planning|thinking|calling_tool|waiting_approval|waiting_clarification|waiting_budget|finalizing|failed|cancelled`

### 典型序列

```
# 直接回答
status → phase → token* → message → status(completed) → done

# 工具
… → tool_call → [approval_request] → tool_result → … → message → done

# 编辑重试
revert → reverted → messages → status(running) → … → done
```

## 模型速查

完整字段见 shared。任务侧常带：

- `messages`、`plan`、`phase`/`status`  
- `budget*` / `lifetime*` / `budgetExceeded`  
- `artifacts`、`clarifications`、`checkpoints`、`tokenUsage`  
- `archivedMessages`（最近 revert；continue 后清空）  
- `subagentRuns`（`parentCallId` 关联 delegate）  
- `projectId`、`parentTaskId`、`autoModeState`

## 配置入口

| 类别 | 入口 |
|---|---|
| 运维 / 进程 | env：`AUREVOY_HOST` / `PORT` / `DB_PATH` / `WORKSPACE_DIR` / `LOG_*` / `CORS`（见 `.env.example`） |
| 产品 | 设置页 → SQLite：LLM 多槽位、OAuth、MCP、搜索、embedding、预算、沙箱开关等 |

密钥禁止写入文档示例的真实值；设置 API 永不回显明文 key。

## 演进

- 新增事件/字段：shared 联合类型扩展，前后端同发版。  
- 废弃字段先标记再删；破坏性变更写 ROADMAP/提交说明。  
- 文档保持**索引级**；长 JSON 样例以 shared 与回归脚本为准。
