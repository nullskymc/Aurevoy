# 架构设计 — ARCHITECTURE

> 面向智能体协作：本文描述 Aurevoy 的系统结构、模块职责、运行时数据流与扩展边界。
> 改动跨模块前请先读本文。

## 1. 设计原则

1. **前后端分离**：UI（桌面壳）与 Agent 引擎是两个独立进程，通过本地 HTTP + SSE 通信。
   好处是从 macOS 扩展到 Windows 时，引擎代码几乎不动，只需重新打包桌面壳。
2. **契约集中**：所有跨进程数据结构定义在 `packages/shared`，前后端共用，杜绝类型漂移。
3. **能力可插拔**：Agent runtime、LLM Provider、工具（Tool/MCP）、存储都在抽象接口之后，
   主控制面不感知具体实现。
4. **可插拔 Provider**：LLM 配置以 Pi provider id 为准（OpenAI、Anthropic、DeepSeek、OpenRouter、
   Google、OpenAI-compatible 自定义端点等）。通过 `.env` 或设置界面配置；
   未配置即明确报错。
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
│        │ createTask / runHarnessTask                              │
│        ▼                                                          │
│   agent/harness-controller.ts ──emit──▶ agent/events.ts           │
│        │  Pi AgentHarness 控制器        │ subscribe                 │
│        │                          └──▶ SSE 推送回前端              │
│        ├──▶ agent/pi-harness.ts         (Pi AgentHarness 适配层)    │
│        ├──▶ agent/subagent.ts           (Pi 子代理：受限委托执行)    │
│        ├──▶ llm/pi-provider.ts          (Pi model/provider 映射)    │
│        ├──▶ tool/tools/  (新一代 Effect-TS 工具系统, P0-P4)         │
│        ├──▶ sandbox/command-executor.ts (命令执行边界，默认关闭)     │
│        ├──▶ memory/                     (向量检索 + Dreams 管道)    │
│        ├──▶ knowledge-base/             (RAG: 索引 + KNN 召回)      │
│        └──▶ store/db.ts                (SQLite 任务 + 轨迹持久化)   │
└───────────────────────────────────────────────────────────────────┘
```

## 4. 模块职责

### 4.1 前端 `apps/desktop`

| 文件/目录 | 职责 |
|---|---|
| `src-tauri/` | Rust 桌面壳；窗口、打包、系统集成。`tauri.conf.json` 配置产品名/窗口/devUrl；`src/agent_process.rs` 负责本地 Agent 引擎子进程托管 |
| `src/main.tsx` | React 挂载入口 |
| `src/App.tsx` | 主界面壳：组织任务工作台、侧栏、设置、记忆、工具和运行详情 |
| `src/hooks/` | 前端状态拆分：`useTaskState`、`useSSEStream`、`useSettings`、`useTools`、`useMemories`、`useArtifacts` |
| `src/components/Conversation.tsx` | 对话与交付工作台：目标、计划、追问、工具活动、artifact、预算和最终回复 |
| `src/components/MarkdownRenderer.tsx` | 安全 Markdown 渲染边界：只渲染受控块/内联语法，链接使用安全属性 |
| `src/lib/api.ts` | 访问 Agent 引擎的客户端：`checkHealth` / `createTask` / `listTasks` / `listTaskTraces` / `streamTask` |
| `src/lib/desktopAgent.ts` | Tauri command 薄封装：请求桌面壳确保本地 Agent 引擎运行；业务健康仍由 `api.ts` 的 HTTP 探测决定 |

前端**不直接持有业务状态真相**，状态来自后端事件流；UI 只做渲染与交互。

### 4.2 后端 `apps/agent`

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 进程入口，启动 Fastify |
| `src/config.ts` | 运行时配置（host/port/dbPath/cors/provider/sandbox/network/MCP），全部可被环境变量覆盖 |
| `src/server.ts` | HTTP 路由 + SSE 端点（见 `docs/API.md`） |
| `src/agent/harness-controller.ts` | **Pi harness 控制器**：`createTask` 建任务；`runHarnessTask` 委托 `pi-harness.ts`，保留任务恢复、取消、revert/branch/compact 和 SSE 事件桥接 |
| `src/agent/pi-harness.ts` | **Pi AgentHarness 适配层**：把 Aurevoy task/messages/tools/approval 映射到 `@earendil-works/pi-agent-core` 的 `AgentHarness`，并把 Pi 事件转换回现有 SSE 契约 |
| `src/agent/subagent.ts` | **Pi 子代理执行引擎**：`delegate` 使用独立 Pi session；角色化最小工具面，继承父权限/任务上下文，支持并发闸门、父级取消、轮次与超时限制、结果截断和父任务 trace 关联 |
| `src/agent/context.ts` | **上下文窗口 + 记忆注入**。 P4: `estimateTokens()` 轻量 token 估算；预算超限时做本地确定性摘要。 P5/M8: 记忆相关性评分、缓存与注入 |
| `src/agent/m6-state.ts` | Agent 交付状态辅助：预算、token usage、追问、artifact、checkpoint 的创建与状态更新 |
| `src/agent/events.ts` | `TaskEventBus`：按 `taskId` 发布/订阅 `AgentEvent`，桥接执行与 SSE |
| `src/llm/pi-provider.ts` | Pi model/provider 映射：保留 `AUREVOY_LLM_*` 配置入口，生成 Pi `Model` 并提供模型列表/健康展示 |
| `src/tool/` | **新一代 Effect-TS 工具系统**（P0-P4）：Schema 驱动输入输出、作用域注册、审批引擎、文件快照、并行执行管线。见下方独立模块 |
| `src/tool/framework/definition.ts` | **工具定义**：`ToolConfig<I,O>` 接口 + `make()` 工厂。输入/输出用 Effect `Schema` 定义，自动生成 JSON Schema。支持 `toModelOutput` 多部分输出（文本/文件） |
| `src/tool/framework/registry.ts` | **作用域注册表**：Effect Tag + Layer，`register()` 作用域内自动清理。同名单栈（最新覆盖），`materialize()` 快照当前注册集合 |
| `src/tool/framework/executor.ts` | **执行管线**：`ToolExecutionPipeline` 包装 `Materialization`，支持 `executeOne`/`executeParallel`/`executeSequential`，`Promise.race` 独立超时 |
| `src/tool/framework/permission.ts` | **权限服务**：`PermissionService` 允许/拒绝规则引擎，last-match-wins，支持 `*` 通配符 |
| `src/tool/tools/` | **14 个领域工具**：`read`/`write`/`edit`/`glob`/`grep`/`bash`/`web-search`/`web-fetch`/`ask-user`/`artifact`/`delegate`/`memory` 等，每个工具独立目录 |
| `src/tool/filesystem/` | **Effect 文件系统服务**：`read-filesystem` 只读操作 + `file-mutation` 文件写入/快照/回滚抽象 |
| `src/tool/builtins.ts` | **工具注册入口**：P4 将 Effect 工具注册进统一工具框架 |
| `src/tool/skill-integration.ts` | **Skill**: `load_skill` 工具（Agent Skills 标准）——LLM 可调用加载 skill，返回 `<skill_content>` 结构化标签 + 资源列表 |
| `src/tool/web-content.ts` | **网页抓取共享模块**：`web_fetch` 的 SSRF/重定向边界、文本读取、HTML 正文提取与链接抽取；同时为搜索结果清洗复用 HTML 解码工具 |
| `src/tool/mcp-integration.ts` | MCP TypeScript SDK 客户端：启动期连接 `AUREVOY_MCP_SERVERS_JSON` 配置的 stdio servers，发现 tools 并注册到统一工具注册表；MCP 描述会截断/净化，本地风险覆盖优先于 annotations |
| `src/skills/types.ts` | **Skill 类型**（Agent Skills 标准）：`SkillFrontmatter`（含 license/compatibility/metadata）、`SkillCatalogEntry`（Tier 1 catalog）、`SkillContent`（Tier 2 body+resources）、`SkillResource` |
| `src/skills/loader.ts` | **Skill 加载器**（Agent Skills 标准）：`discoverSkills()` 扫描目录发现 SKILL.md（标准格式）+ flat .md（向后兼容）；`loadSkillContent()` 激活时懒加载 body + 资源枚举 |
| `src/skills/registry.ts` | **Skill 注册表**（渐进披露）：Tier 1 `load()` 仅加载 name+description；Tier 2 `getContent()` 激活时加载 body+resources。发现路径含 `.aurevoy/skills/` 和 `.agents/skills/` |
| `skills/builtin/` | **预装 skill 目录**：`web-search/SKILL.md`、`browser/SKILL.md`、`report-design/SKILL.md`（Agent Skills 标准格式，含 scripts/references/assets 支持） |
| `src/runtime/settings.ts` | 运行设置服务：从 SQLite 加载/保存 Provider、工作区、工具边界、MCP 和清理策略；更新后影响真实 runtime |
| `src/sandbox/command-executor.ts` | 命令/代码执行前置边界：策略、超时、输出上限、env allowlist；默认禁用，不暴露 shell |
| `src/store/db.ts` | SQLite 持久化。 `taskStore`：save/get/list/listByProject。 `traceStore`：append/list。 `projectStore`：CRUD/getByPath。 `memoryStore`(**P5**: +`nameSlug`/`why`/`howToApply` 列，`findByNameSlug` 查询)。 `settingsStore`；`toolSettingsStore` |

工程治理模块保持边界：轨迹日志落在 `store/`，沙箱执行器落在 `sandbox/`，评测脚本落在 `scripts/`。
Agent loop 只编排状态转换和写入审计点，不直接写平台特例或绕过安全策略。

### 4.3 契约层 `packages/shared`

`src/index.ts` 定义全部跨进程类型：领域模型（`Task`/`Message`/`PlanStep`/`Project`）、
工具（`ToolDescriptor`/`ToolCall`/`ToolResult`）、runtime 阶段（`TaskPhase`）、事件流（`AgentEvent`）、
API 请求响应、运行时常量（默认地址端口）。

## 5. 核心数据流：一次任务的生命周期

1. 用户在 UI 输入目标 → `POST /api/tasks {goal}`。
2. `server.ts` 调 `createTask()` 建 `Task` 存库 → 立即 `201` 返回 `{task, streamUrl}`；
   同时 `void runHarnessTask(task)` 异步执行（不阻塞响应）。
3. 前端拿到 `task.id` → `EventSource(streamUrl)` 订阅 SSE。
4. `runHarnessTask` 发布轻量计划和 scout 报告，随后委托 **Pi AgentHarness**，逐步 emit 事件到 `TaskEventBus`：
   - 每轮上下文通过 harness `context` hook 做 cache-aware Snip + Microcompact
   - 注入 **相关性评分记忆**（P5: 关键词+分类+置信度+时间衰减排序，`[[link]]` 引用展开，top-20）
   - `status(running)` → `phase(initializing/thinking)` →（每轮）流式 `token` →
   - 若模型请求工具则进入 **Pi 工具执行管线**：Pi 根据 executionPolicy 并行/顺序执行，Aurevoy 在 harness `tool_call` hook 套用 auto mode 策略
   - 未被当前 auto mode 放行的工具进入 `phase(waiting_approval)`，等待用户对单次调用审批；失败工具附加 **fallback 建议**（P6）
   - 写入类工具执行前 **捕获文件快照**（P6: Rewind 时回滚文件）
   - 把工具结果作为 `role:'tool'` 消息回灌、再请求 LLM →…直到模型给出最终答案 →
   - `phase(finalizing)` → `message` → `status(completed|failed|cancelled)` → `done`。
   - 工具成功推进 `plan`/`step_update`，创建 `checkpoint_created` 事件。
7. **多轮对话**：任务结束后 `POST /api/tasks/:id/messages` 经 `addUserTurn()` 追加 user 轮次。
8. **任务恢复**：启动时扫描 SQLite 中遗留任务标记为可恢复失败；`POST /api/tasks/:id/resume` 补齐悬空 tool result 后继续运行。
9. **编辑重跑（revert / unrevert）**：消息归档（soft-delete）→ 按 mode 清除 checkpoint/artifact/plan。 P6: `code_and_conv` 模式从文件快照回滚被截断消息关联的写入。
10. **会话分支（branch）**：克隆父任务到指定消息，ID 重映射，独立演进。
11. **上下文压缩（compact）**：手动 API 将消息范围压缩为 LLM 摘要。
12. `events.ts` 序列化为 SSE 推送；前端增量渲染。
13. `done` 事件后关闭 SSE；任务+轨迹落 SQLite 可回看。

## 6. 扩展边界（往哪里加东西）

| 想做的事 | 改哪里 | 不要碰 |
|---|---|---|
| 接真实大模型 | 扩展 Pi model/provider 映射，保持 `AUREVOY_LLM_*` 配置入口 | Agent 循环、前端 |
| 加一个工具 | 新工具放 `tool/tools/` 并注册到 `tool/builtins.ts` | Agent 循环内联逻辑 |
| 加自动模式规则 | `agent/approval.ts` 扩展 `decideToolPermission()`，保持 Pi `beforeToolCall` 为唯一门禁 | Agent 循环里新增工具特例 |
| 接 MCP server | 配置 `AUREVOY_MCP_SERVERS_JSON`，或扩展 `tools/mcp.ts` 的 transport 支持 | 工具调用协议 / Agent 循环 |
| 改网络抓取边界 | `tools/web-content.ts` 的 `web_fetch` 策略 + `config.network` + `docs/API.md` | 绕过 SSRF/重定向校验直接 fetch |
| 加轨迹日志/审计 | `store/` 新增结构化记录，`agent/` 在状态边界写入 | 前端临时数组、console-only 日志 |
| 加沙箱/命令执行 | 新增执行器模块和权限策略，默认关闭高风险能力 | 直接在工具里调用本机 shell |
| 加评测 | 新增可复现用例和脚本，覆盖工具/状态/安全路径 | 只靠手工试一次 |
| 加运行设置 | `runtime/settings.ts` + `store/db.ts` + `packages/shared` API 类型 | 前端静态表单、只改 `.env.example` |
| 改任务/事件结构 | 改 `packages/shared` 并 `build:shared` | 前后端各自重定义 |
| 加编辑重跑/分支 | `agent/harness-controller.ts` 的 `revertTask`/`branchTask`/`compactTask`，`store/db.ts` 加列，`shared` 加类型 | 前端直接操作消息数组 |
| 加子代理能力 | `agent/subagent.ts` 修改运行边界；`agent/subagent-profiles.ts` 修改角色；`tool/tools/delegate/` 修改工具契约 | 绕过父权限/上下文继承，或恢复第二套委托入口 |
| 加记忆引用/评分 | `agent/context.ts` 的 `scoreMemories`/`parseMemoryLinks`；`store/db.ts` 的 `findByNameSlug` | 直接改评分公式不跑回归 |
| 加 Diff 编辑 | `tool/tools/edit/` 的 `edit` 工具 | 绕过唯一性校验直接写文件 |
| 加记忆向量/RAG | `memory/` 或 `knowledge-base/` + `store/db.ts` 加表 + `embedding/` Provider | 混合评分参数不跑回归 |
| 加新 LLM Provider | 扩展 `llm/pi-provider.ts` 的 Pi model/provider 映射 | 在 Agent 循环里直接接厂商 SDK |
| 调上下文压缩策略 | `config.ts` 的 `contextTokenBudget`/`compactThreshold`/`compactKeepRecentTurns` | 把阈值设到 1.0 永不压缩 |
| 加界面 | `apps/desktop/src` | 后端业务逻辑 |
| 换存储/加表 | `store/db.ts` | 其它模块直接访问 DB |

## 7. 跨平台说明（macOS → Windows）

- **后端**：纯 Node，无平台专有依赖；`better-sqlite3` 为原生模块，Windows 上 `npm install` 会自动重编。
- **前端壳**：Tauri 跨平台，Windows 需安装 Microsoft Visual C++ Build Tools + WebView2。
- **引擎托管**：桌面壳使用 Rust `Command` 启动 Agent 子进程；开发期使用 `npm`/`npm.cmd`，
  生产期应指向平台对应的 sidecar 二进制，避免要求普通用户安装 Node。
- **约定**：路径用 `path` 模块拼接，不要硬编码 `/`；不要调用 macOS 专有命令。
