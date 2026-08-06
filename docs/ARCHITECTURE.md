# 架构

> 跨模块改动前读本文。类型与事件字段以 `packages/shared` 为准。

## 原则

1. **双进程**：桌面壳 + Agent 引擎，本地 HTTP + SSE（`127.0.0.1:8787`）。  
2. **契约集中**：跨进程类型只在 `@aurevoy/shared`。  
3. **Pi 为唯一主循环**：Aurevoy 保留任务、工具、审批、持久化与事件适配。  
4. **本地优先**：SQLite；密钥不进仓库。  
5. **治理在 runtime**：权限/审批/沙箱/轨迹强制执行，不靠 prompt。  
6. **真实能力**：不可用则失败或降级，禁止 Mock 冒充。

## 仓库结构

```
apps/desktop     Tauri 壳、子进程托管、平台适配、系统托盘
apps/agent       Fastify 引擎（Pi harness、工具、存储）
packages/web-ui  React UI（对话、设置、工作台）
packages/shared  共享类型
docs/            协作文档
```

## 运行时

```
┌── Desktop (Tauri WebView + web-ui) ──┐
│  fetch / EventSource                 │
└────────────────┬─────────────────────┘
                 │ HTTP + SSE
┌────────────────▼─────────────────────┐
│  server.ts  → server-routes/*         │
│       → harness-controller             │
│       → pi-harness (AgentHarness)     │
│       → subagent / tools / memory      │
│       → knowledge-base / store         │
│  events.ts  → SSE 推送               │
└──────────────────────────────────────┘
```

## 模块职责

### 前端

| 路径 | 职责 |
|---|---|
| `packages/web-ui` | App、Conversation、Composer、Timeline、Workbench、hooks、api 客户端 |
| `apps/desktop` | 挂载 UI、Tauri 能力、Agent 进程生命周期、系统托盘与最近任务 |

UI 不持有业务真相：状态来自任务快照 + SSE。

### 后端（`apps/agent/src`）

| 路径 | 职责 |
|---|---|
| `server.ts` | Fastify 生命周期、鉴权、启动恢复与路由组装 |
| `server-routes/*` | 按 auth、task、SSE、workspace、settings、data、memory、KB 等域承载 HTTP 适配 |
| `agent/harness-controller.ts` | 建任务、恢复、revert/branch/compact、续聊 |
| `agent/pi-harness.ts` | Pi 适配与事件映射 |
| `agent/subagent*.ts` | 隔离子代理、并发、进度快照 |
| `agent/approval.ts` | Agent 自动执行与 paused 工具门禁 |
| `agent/context.ts` | 上下文压缩、记忆评分注入 |
| `llm/pi-provider.ts` | Provider / 模型映射 |
| `tool/` | Effect 工具框架 + 领域工具 + MCP |
| `memory/` · `knowledge-base/` · `embedding/` | 记忆向量、KB RAG |
| `sandbox/` | 高风险命令边界（默认关） |
| `store/db.ts` | SQLite 连接、迁移和 repository 组装 |
| `store/*-repository.ts` | 任务/轨迹、Pi 会话树、设置、记忆、项目、自动化和向量读写 |

### 契约

`packages/shared/src/index.ts`：`Task`、`AgentEvent`、`Message`、预算/产物/子代理等。  
改类型 → `npm run build:shared`。

## 任务生命周期

1. `POST /api/tasks` → 建库 + 异步 `runHarnessTask` → 返回 `streamUrl`  
2. 前端 `EventSource` 订阅；先可收到快照再收实时事件  
3. Pi：规划/思考 → 工具（并行策略 + 审批钩子）→ 最终消息  
4. 结束：`status` + `done`；轨迹落库  
5. 续聊 `POST .../messages`；恢复 `.../resume`  
6. 编辑重试：内联确认 → `revert` → 立刻 `messages`（编辑稿）  
7. 分支 `branch`；压缩 `compact` 或 `/compact`

## 扩展入口

| 目标 | 改哪里 | 禁止 |
|---|---|---|
| 新工具 | `tool/tools/*` + registry | 写进 loop |
| 新 Provider | `llm/pi-provider` | 第二套 agent 后端 |
| 子代理 | `subagent*` / `tools/delegate` | 绕过父权限 |
| 记忆/KB | `memory/` / `knowledge-base/` | 无回归改评分 |
| UI | `packages/web-ui` | 后端业务塞进组件 |
| 类型 | `packages/shared` | 前后端各自定义 |

## 跨平台

后端路径用 `node:path`；系统能力走 Tauri；原生模块（sqlite 等）按平台 rebuild。

- macOS：app bundle、菜单栏托盘与 DMG / updater。
- Windows：WebView2/Tauri 壳、NSIS 当前用户安装、资源与 Node runtime 同级路径、隐藏引擎子进程控制台与通知区托盘。
- Linux：Deb / AppImage 安装包与 updater 产物。

引擎逻辑保持跨平台；平台差异只能留在 Tauri 壳与打包层。
