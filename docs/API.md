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
   "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false } }]
```
MCP server 暴露的工具会在 Agent 启动期注册进同一个列表，名称格式为
`mcp_<server>_<tool>`（非法字符会转为 `_`，超长名称会附加稳定 hash）。

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
{ "goal": "帮我整理这周的会议纪要" }
```
```json
// 201 → CreateTaskResponse
{ "task": { /* Task */ }, "streamUrl": "/api/tasks/<id>/stream" }
```
- `goal` 为空 → `400 {"error":"goal is required"}`
- 返回后任务在后台执行，进度通过 `streamUrl` 的 SSE 推送。

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
- 字段缺失或类型错误 → `400`；任务不存在 → `404`。

## 2. 事件契约：`AgentEvent`

所有事件都带 `taskId`（用于多任务路由）。`type` 是判别字段：

| type | 载荷字段 | 含义 |
|---|---|---|
| `task_created` | `task: Task` | 任务已创建 |
| `status` | `status: TaskStatus` | 任务状态变化 |
| `phase` | `phase: TaskPhase`, `detail?` | Agent runtime 细粒度阶段变化 |
| `plan` | `plan: PlanStep[]` | 给出/更新完整计划 |
| `step_update` | `step: PlanStep` | 单个计划步骤状态变化 |
| `token` | `delta: string` | LLM 流式输出的增量片段 |
| `message` | `message: Message` | 一条完整消息（通常是助手最终回复） |
| `tool_call` | `call: ToolCall` | 发起一次工具调用 |
| `approval_request` | `call: ToolCall`, `riskLevel` | 非 safe 工具执行前请求用户确认 |
| `tool_result` | `result: ToolResult` | 工具返回结果 |
| `done` | `status: TaskStatus` | 任务结束（completed/failed/cancelled） |
| `error` | `message: string` | 执行出错 |

`TaskStatus`：`pending | planning | running | paused | completed | failed | cancelled`

`TaskPhase`：`initializing | thinking | calling_tool | waiting_approval | finalizing | failed | cancelled`

### 典型事件序列

无需工具（直接回答）：
```
status(running) → phase(initializing) → phase(thinking) → token × N
  → phase(finalizing) → message → status(completed) → done(completed)
```

ReAct 工具调用循环（含一次工具调用）：
```
status(running)
  → phase(thinking)
  → token × N                       (模型本轮的文本/思考)
  → phase(calling_tool)
  → tool_call                       (模型请求调用工具)
  → tool_result                     (工具执行结果，回灌给模型)
  → phase(thinking)
  → token × N                       (下一轮，带着工具结果)
  → phase(finalizing) → message → status(completed) → done(completed)
```
- 计划以隐式方式呈现：循环用工具调用轨迹更新 `plan`/`step_update`，不强制先规划。
- 一轮可能有多个并行 `tool_call`（各带独立 `id`），对应多个 `tool_result`。
- 取消时以 `status(cancelled)` + `done(cancelled)` 收尾。
- `phase` 是诊断和 UI 解释用的细粒度阶段，必须来自后端真实状态转换，不能由前端猜测。

非 safe 工具（`caution`/`dangerous`，如 `http_fetch`/`write_file`）需审批：
```
… → tool_call → approval_request          (等待用户)
  → phase(waiting_approval)
  → [POST /api/tasks/:id/approvals]        (批准/拒绝)
  → tool_result                            (批准→执行结果；拒绝→ok:false 错误回灌)
  → token × N → message → done
```
工具的风险等级由 `ToolDescriptor.riskLevel`（`safe`|`caution`|`dangerous`，缺省 `safe`）声明，
`safe` 工具自动放行；审批超时（5 分钟）或任务取消视为拒绝。

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
- **破坏性改动**：改字段语义/删字段时，前后端要同一次提交内联动，并 `npm run build:shared`。
- **鉴权**：当前为本机单用户、无鉴权。若未来引擎需被其它客户端访问，必须先加鉴权（token/本地 socket 校验），不可裸暴露。
- **真实能力**：API 不提供 Mock 成功响应；配置缺失、工具不可用、模型失败等情况必须返回明确错误或事件。

## 5. LLM Provider 配置

引擎通过环境变量选择 LLM Provider（开发期写在**项目根目录** `.env`，已 gitignore；
模板见根目录 `.env.example`）。Provider 抽象在 `apps/agent/src/llm/provider.ts`。

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `AUREVOY_LLM_PROVIDER` | `openai` | OpenAI 兼容协议（后续可扩展其它厂商） |
| `AUREVOY_LLM_API_KEY` | 空 | API Key，**必填**；缺失时执行任务会明确报错 |
| `AUREVOY_LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容端点基础地址（不含 `/chat/completions`） |
| `AUREVOY_LLM_MODEL` | `gpt-4o-mini` | 模型名 |
| `AUREVOY_LLM_TEMPERATURE` | `0.7` | 采样温度 |
| `AUREVOY_LLM_TIMEOUT_MS` | `120000` | 单轮 LLM 调用超时 |
| `AUREVOY_APPROVAL_TIMEOUT_MS` | `300000` | 工具审批等待超时；超时按拒绝处理 |

- `openai` 走标准 Chat Completions 流式协议（`stream: true`，SSE），
  兼容 OpenAI / DeepSeek / Moonshot / 本地 Ollama(`/v1`) / vLLM / LM Studio 等。
- 未配置 API Key 或 provider 不支持时，执行任务会通过 `error` 事件明确报错，
  **不再有占位/Mock 回退**，避免污染真实结果。
- 当前生效的 Provider 名通过 `GET /api/health` 的 `provider` 字段暴露给前端。
- **密钥安全**：Key 只走环境变量，禁止硬编码或提交。

## 6. 沙箱 / 高风险执行配置

命令/代码执行当前只定义边界，默认关闭，没有作为工具暴露给模型。

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `AUREVOY_ENABLE_COMMAND_EXECUTION` | `false` | 未来显式启用隔离命令执行器；当前默认拒绝 |
| `AUREVOY_COMMAND_TIMEOUT_MS` | `30000` | 命令执行超时 |
| `AUREVOY_COMMAND_OUTPUT_LIMIT_BYTES` | `65536` | stdout/stderr 输出上限 |
| `AUREVOY_COMMAND_ENV_ALLOWLIST` | `PATH,HOME,TMPDIR` | 允许传入执行环境的变量名 |

## 7. MCP server 配置

`AUREVOY_MCP_SERVERS_JSON` 用 JSON 配置可选 MCP servers。当前支持 stdio transport，
启动时连接 server，调用 `listTools()` 发现工具并注册到 Aurevoy 的 `ToolRegistry`；
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
