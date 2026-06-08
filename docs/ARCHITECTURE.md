# 架构设计 — ARCHITECTURE

> 面向智能体协作：本文描述 Aurevoy 的系统结构、模块职责、运行时数据流与扩展边界。
> 改动跨模块前请先读本文。

## 1. 设计原则

1. **前后端分离**：UI（桌面壳）与 Agent 引擎是两个独立进程，通过本地 HTTP + SSE 通信。
   好处是从 macOS 扩展到 Windows 时，引擎代码几乎不动，只需重新打包桌面壳。
2. **契约集中**：所有跨进程数据结构定义在 `packages/shared`，前后端共用，杜绝类型漂移。
3. **能力可插拔**：LLM Provider、工具（Tool/MCP）、存储都在抽象接口之后，
   Agent 主循环不感知具体实现。
4. **可插拔 Provider**：LLM 走 OpenAI 兼容协议（OpenAI/DeepSeek/Ollama 等），通过 `.env` 配置；未配置即明确报错。
5. **本地优先**：数据默认存本地 SQLite；引擎只监听 `127.0.0.1`，不对外暴露。
6. **交付真实能力**：不允许用 Mock、占位事件或前端假状态替代真实运行链路。
   能力不可用时必须明确失败、降级或要求配置。
7. **治理外置于模型**：权限、审批、沙箱、审计、状态恢复和评测由 runtime 强制执行，
   不能只依赖 prompt 约束。

## 2. 顶层结构

```
Aurevoy/  (npm workspaces monorepo)
├── apps/
│   ├── desktop/      @aurevoy/desktop  — Tauri 2.0 + React + TS（前端）
│   └── agent/        @aurevoy/agent    — Node + Fastify（Agent 引擎，后端）
├── packages/
│   └── shared/       @aurevoy/shared   — 前后端共享 TypeScript 类型（契约层）
└── docs/             协作文档
```

## 3. 运行时拓扑

```
┌──────────────────────────── 桌面进程 ────────────────────────────┐
│  Tauri (Rust 壳)  ──加载──▶  WebView (React UI)                   │
│                                  │                                │
│                                  │  fetch / EventSource           │
└──────────────────────────────────┼───────────────────────────────┘
                                    │  HTTP + SSE  (127.0.0.1:8787)
┌──────────────────────────────────┼───────────────────────────────┐
│  Agent 引擎进程 (Node + Fastify)   ▼                               │
│   server.ts (路由/SSE)                                            │
│        │ createTask / runTask                                     │
│        ▼                                                          │
│   agent/loop.ts  ──emit──▶  agent/events.ts (TaskEventBus)        │
│        │  ReAct 工具调用循环         │ subscribe                    │
│        │                          └──▶ SSE 推送回前端              │
│        ├──▶ llm/provider.ts            (LLMProvider：OpenAI 兼容)   │
│        ├──▶ agent/tool-call-accumulator (流式 tool_calls 累积)     │
│        ├──▶ tools/registry.ts          (ToolRegistry：内置 / MCP)  │
│        ├──▶ approval/risk gate          (工具审批与风险控制)         │
│        ├──▶ sandbox/command-executor.ts (命令执行边界，默认关闭)     │
│        └──▶ store/db.ts                (SQLite 任务 + 轨迹持久化)   │
└───────────────────────────────────────────────────────────────────┘
```

## 4. 模块职责

### 4.1 前端 `apps/desktop`

| 文件/目录 | 职责 |
|---|---|
| `src-tauri/` | Rust 桌面壳；窗口、打包、系统集成。`tauri.conf.json` 配置产品名/窗口/devUrl |
| `src/main.tsx` | React 挂载入口 |
| `src/App.tsx` | 主界面：输入目标、展示状态/计划/流式输出/轨迹回看 |
| `src/lib/api.ts` | 访问 Agent 引擎的客户端：`checkHealth` / `createTask` / `listTasks` / `listTaskTraces` / `streamTask` |

前端**不直接持有业务状态真相**，状态来自后端事件流；UI 只做渲染与交互。

### 4.2 后端 `apps/agent`

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 进程入口，启动 Fastify |
| `src/config.ts` | 运行时配置（host/port/dbPath/cors），全部可被环境变量覆盖 |
| `src/server.ts` | HTTP 路由 + SSE 端点（见 `docs/API.md`） |
| `src/agent/loop.ts` | **Agent 主循环**：`createTask` 建任务；`runTask` 跑 **ReAct 工具调用循环**（调 LLM → 有 tool_calls 则执行并回灌 → 直到最终答案）；含显式 runtime phase、防死循环、重试、取消、任务恢复和每轮持久化 |
| `src/agent/events.ts` | `TaskEventBus`：按 `taskId` 发布/订阅 `AgentEvent`，桥接执行与 SSE |
| `src/agent/tool-call-accumulator.ts` | 流式 `tool_calls` 累积器：按 `index` 跨 chunk 拼接 `id`/`name`/`arguments`，处理并行调用与截断 |
| `src/llm/provider.ts` | `LLMProvider` 抽象（`stream(messages, options)` 支持 tools/signal）+ `OpenAICompatibleProvider`；`getProvider()` 按配置返回，未配置即报错 |
| `src/tools/registry.ts` | `ToolRegistry`：注册/列举/调用工具；`riskLevelOf()` 查风险等级 |
| `src/tools/builtins.ts` | 内置基础工具：`list_directory`/`read_file`/`write_file`/`http_fetch`；文件类路径限定 `config.workspaceDir` 内（防穿越） |
| `src/tools/mcp.ts` | MCP TypeScript SDK 客户端：启动期连接 `AUREVOY_MCP_SERVERS_JSON` 配置的 stdio servers，发现 tools 并注册到 `ToolRegistry` |
| `src/runtime/settings.ts` | 运行设置服务：从 SQLite 加载/保存 Provider、工作区、工具边界、MCP 和清理策略；更新后影响真实 runtime |
| `src/sandbox/command-executor.ts` | 命令/代码执行前置边界：策略、超时、输出上限、env allowlist；默认禁用，不暴露 shell |
| `src/store/db.ts` | SQLite 持久化（`taskStore`：save/get/list；`traceStore`：append/list） |

工程治理模块保持边界：轨迹日志落在 `store/`，沙箱执行器落在 `sandbox/`，评测脚本落在 `scripts/`。
Agent loop 只编排状态转换和写入审计点，不直接写平台特例或绕过安全策略。

### 4.3 契约层 `packages/shared`

`src/index.ts` 定义全部跨进程类型：领域模型（`Task`/`Message`/`PlanStep`）、
工具（`ToolDescriptor`/`ToolCall`/`ToolResult`）、runtime 阶段（`TaskPhase`）、事件流（`AgentEvent`）、
API 请求响应、运行时常量（默认地址端口）。

## 5. 核心数据流：一次任务的生命周期

1. 用户在 UI 输入目标 → `POST /api/tasks {goal}`。
2. `server.ts` 调 `createTask()` 建 `Task` 存库 → 立即 `201` 返回 `{task, streamUrl}`；
   同时 `void runTask(task)` 异步执行（不阻塞响应）。
3. 前端拿到 `task.id` → `EventSource(streamUrl)` 订阅 SSE。
4. `runTask` 跑 **ReAct 工具调用循环**，逐步 emit 事件到 `TaskEventBus`：
   `status(running)` → `phase(initializing/thinking)` →（每轮）流式 `token` →
   若模型请求工具则 `phase(calling_tool)` → `tool_call` → 执行 → `tool_result` →
   非 safe 工具会进入 `phase(waiting_approval)` 并等待审批；
   把工具结果作为 `role:'tool'` 消息回灌、再请求 LLM →…直到模型给出最终答案 →
   `phase(finalizing)` → `message` → `status(completed|failed|cancelled)` → `done`。
   计划以隐式方式呈现：用工具调用轨迹更新 `plan`/`step_update`。
   每轮请求 LLM 前，`agent/context.ts` 把完整历史压成**上下文窗口**（会话级短期记忆）：
   用户约束与最近窗口逐字保留，超预算时就地压缩旧 assistant/tool 内容，压缩留轨迹。
4b. **多轮对话**：任务结束后 `POST /api/tasks/:id/messages` 经 `addUserTurn()` 追加 user 轮次，
   带完整历史重新进入同一循环；前端复用同一 `streamUrl` 订阅。
4c. **任务恢复**：Agent 启动时扫描 SQLite 中遗留的 `pending/planning/running/paused` 任务，
   将其标记为 `failed` 并写入“上次进程中断”的轨迹说明；用户调用
   `POST /api/tasks/:id/resume` 后，后端先补齐可能悬空的 tool result，再用持久消息历史继续运行。
5. `events.ts` 把事件序列化为 SSE（`data: {json}\n\n`）推给前端；前端按事件类型增量渲染。
6. 收到 `done`，前端与后端各自关闭 SSE 连接。
7. 任务状态通过 `taskStore.save()` 落库，可经 `GET /api/tasks` 回看。
   运行轨迹通过 `traceStore.append()` 落入 `task_traces`，可经 `GET /api/tasks/:id/traces` 回看。

## 6. 扩展边界（往哪里加东西）

| 想做的事 | 改哪里 | 不要碰 |
|---|---|---|
| 接真实大模型 | 在 `llm/provider.ts` 新增 `LLMProvider` 实现，改 `getProvider()` | Agent 循环、前端 |
| 加一个工具 | 在 `tools/` 新建并 `toolRegistry.register()` | Agent 循环内联逻辑 |
| 接 MCP server | 配置 `AUREVOY_MCP_SERVERS_JSON`，或扩展 `tools/mcp.ts` 的 transport 支持 | 工具调用协议 / Agent 循环 |
| 加轨迹日志/审计 | `store/` 新增结构化记录，`agent/` 在状态边界写入 | 前端临时数组、console-only 日志 |
| 加沙箱/命令执行 | 新增执行器模块和权限策略，默认关闭高风险能力 | 直接在工具里调用本机 shell |
| 加评测 | 新增可复现用例和脚本，覆盖工具/状态/安全路径 | 只靠手工试一次 |
| 加运行设置 | `runtime/settings.ts` + `store/db.ts` + `packages/shared` API 类型 | 前端静态表单、只改 `.env.example` |
| 改任务/事件结构 | 改 `packages/shared` 并 `build:shared` | 前后端各自重定义 |
| 加界面 | `apps/desktop/src` | 后端业务逻辑 |
| 换存储/加表 | `store/db.ts` | 其它模块直接访问 DB |

## 7. 跨平台说明（macOS → Windows）

- **后端**：纯 Node，无平台专有依赖；`better-sqlite3` 为原生模块，Windows 上 `npm install` 会自动重编。
- **前端壳**：Tauri 跨平台，Windows 需安装 Microsoft Visual C++ Build Tools + WebView2。
- **约定**：路径用 `path` 模块拼接，不要硬编码 `/`；不要调用 macOS 专有命令。
