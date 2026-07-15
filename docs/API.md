# API 契约

> 本机 Agent 引擎 HTTP + SSE。类型与字段真相：`packages/shared/src/index.ts`。  
> Base：`http://127.0.0.1:8787`（`AGENT_DEFAULT_BASE_URL` / env 可改）。仅回环。

## 约定

- JSON 请求/响应；SSE：`text/event-stream`，事件体为 `AgentEvent` JSON。图片附件以 data URL 随任务请求上传，单张上限 20MB；引擎落盘后任务历史只保存内部路径。
- 鉴权：本机进程，无公网鉴权层。  
- 改接口：先 shared → `build:shared` → agent / web-ui。

## 端点一览

### 系统 / 工具 / Skill / MCP

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 在线探测；`provider` 如 `openai:model` 或 `unconfigured` |
| GET | `/api/tools` | 已注册工具（含 MCP）；禁用仍列出但不可调 |
| PATCH | `/api/tools/:name` | `{ enabled }` |
| GET | `/api/skills` | Skill catalog（无 body） |
| POST | `/api/skills/reload` | 重扫 skill |
| POST | `/api/skills/install` | 从 Git 安装 |
| DELETE | `/api/skills/:name` | 卸载用户 skill |
| GET | `/api/mcp/status` | MCP 连接与工具数 |

MCP 工具名：`mcp_<server>_<tool>`（净化/截断描述；本地 `riskLevel` 优先）。

### 任务

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/tasks` | 列表；`?projectId=` / `standalone` |
| GET | `/api/tasks/:id` | 详情 |
| GET | `/api/tasks/:id/traces` | 轨迹 |
| GET | `/api/tasks/:id/stream` | **SSE** |
| POST | `/api/tasks` | 创建并异步跑；body `goal`、可选 `projectId`/`budget`/附件 |
| POST | `/api/tasks/:id/messages` | 续聊；空闲则 `addUserTurn`+harness；运行中 steering/follow_up |
| POST | `/api/tasks/:id/resume` | 从历史恢复（不伪造用户句；可补悬空 tool result） |
| POST | `/api/tasks/:id/budget/continue` | 预算触顶后续跑（可选扩容 lifetime / run） |
| POST | `/api/tasks/:id/cancel` | 取消 |
| DELETE | `/api/tasks/:id` | 删除 |
| POST | `/api/tasks/:id/approvals` | 工具审批 |
| POST | `/api/tasks/:id/plan-approval` | 计划审批 |
| POST | `/api/tasks/:id/auto-mode-resume` | 解除 auto 安全暂停 |
| POST | `/api/tasks/:id/clarifications/:id` | 回答追问 |
| POST | `/api/tasks/:id/revert` | 编辑重试截断（见下） |
| POST | `/api/tasks/:id/unrevert` | 撤销截断（仅归档仍在时） |
| POST | `/api/tasks/:id/branch` | 分叉新任务 |
| POST | `/api/tasks/:id/compact` | 消息范围压成摘要 |

**常见状态码：** `404` 不存在；`409` 冲突（运行中不可 revert 等）；`400` 参数；创建/续聊成功多为 `201`/`202`。

#### 续聊 `messages`

- Body：`message`，可选 `attachments`、`delivery: steering|follow_up`。  
- 成功写入新 user 消息后**清空** `archivedMessages`。  
- 运行中：投递 Pi 队列；队列不可用 → `409`。

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
| GET | `/api/tasks/:id/artifacts/:artifactId` | 元数据/内容（实现以路由为准） |
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
| POST | `/api/data/cleanup` | 清理旧终态任务 |

多 Provider：每槽位独立 key/baseUrl/model/列表；`PATCH` 切换 `provider` 会激活对应槽位。  
`enabledModels` 必含当前 active model。

## SSE：`GET /api/tasks/:id/stream`

- 先可补发任务快照，再推实时 `AgentEvent`。  
- 客户端在 `done` / 卸载时关闭连接。

### 事件类型（摘要）

| type | 含义 |
|---|---|
| `task_created` / `task_title` | 任务创建 / 标题 |
| `status` / `phase` | 生命周期 / 细阶段 |
| `plan` / `step_update` / `plan_*` | 计划与审批 |
| `scout_*` | 工作区侦查 |
| `token` / `message` / `message_start` | 流式与完整消息 |
| `tool_call` / `tool_result` / `tool_progress` / `approval_request` | 工具与审批 |
| `subagent_updated` | 子代理运行快照 |
| `clarification_*` | 追问 |
| `artifact_*` / `checkpoint_created` | 产物与检查点 |
| `budget_usage` / `budget_exceeded` / `token_usage` | 预算与用量 |
| `reverted` / `unreverted` / `branched` / `compacted` | 会话控制 |
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
