# 技术栈 — TECH_STACK

> 记录 Aurevoy 的技术选型、版本与**取舍理由**。引入新依赖或做选型决策前请先读本文。

## 1. 总览

| 层 | 技术 | 版本（初始化时） | 角色 |
|---|---|---|---|
| 桌面壳 | Tauri | 2.x（cargo 解析到 tauri 2.11） | 跨平台窗口/打包/系统集成 |
| 壳语言 | Rust | stable（1.96） | Tauri 构建所需 |
| 前端框架 | React | 19.1 | UI（含独立 `@aurevoy/web-ui` 包）|
| 前端语言 | TypeScript | ~5.8 | 类型安全 |
| 前端构建 | Vite | 7.x | 开发服务器 + 打包 |
| 后端运行时 | Node.js | >= 20（开发机 25） | Agent 引擎进程 |
| 后端框架 | Fastify | 5.x | HTTP + SSE 服务 |
| 后端语言 | TypeScript | 5.7 | 全栈统一语言 |
| 开发热重载 | tsx | 4.x | 直接跑 TS，watch 模式 |
| 本地存储 | better-sqlite3 | 11.x → 12.x | 同步 SQLite，简单可靠 |
| 向量检索 | sqlite-vec | 0.1.x | SQLite 原生向量扩展，零额外服务 |
| Effect 框架 | effect | 3.21.x | 新工具系统类型安全、依赖注入、作用域管理 |
| 工具协议 | MCP TypeScript SDK | 1.29.0 | 标准化工具/数据源接入 |
| Monorepo | npm workspaces | npm 11 | 多包管理，零额外工具 |

## 2. 关键选型与理由

本项目的选型目标是交付个人桌面 Agent 产品，而不是训练基座模型或搭建企业推理平台。
因此 PyTorch、vLLM、KServe、Ray Serve 这类训练/Serving 栈不是当前主路径；
Aurevoy 的重点是本地 runtime、工具协议、状态恢复、安全治理和用户体验。

### 2.1 桌面壳：Tauri（而非 Electron）
- **更轻**：安装包 ~10MB 级、内存占用低（用系统 WebView，不自带 Chromium）。
  对"开箱即用"的消费级个人产品体验更友好。
- **更安全**：默认最小权限，能力通过 `capabilities/` 显式开启。
- **跨平台**：macOS / Windows 一流支持，契合 mac→win 路线。
- **取舍**：生态比 Electron 小；各 OS 的 WebView 行为有细微差异；壳层涉及 Rust。
  → 缓解：业务逻辑全在后端 Node，壳尽量保持"薄"。

### 2.2 Agent 引擎语言：TypeScript（而非 Python）
- 与前端**同一语言**，认知统一、契约可直接共享（`packages/shared`）。
- 打包分发简单，无需把 Python 运行时塞进桌面应用。
- **取舍**：AI/Agent 生态成熟度不如 Python（LangChain/LlamaIndex）。
  → 缓解：TS 侧有 Vercel AI SDK、官方各厂商 SDK、MCP TypeScript SDK，够用。

### 2.3 后端框架：Fastify（而非 Express）
- 性能好、内置 schema 校验与日志、对 TS 友好、插件体系清晰。
- SSE 用原生 `reply.raw` 写流，无需额外依赖。

### 2.4 存储：better-sqlite3（而非 sqlite3 / Prisma）
- **同步 API**，代码简单、无回调地狱，适合本地单用户场景。
- 零外部服务，纯文件，符合"本地优先"。
- **取舍**：原生模块，换 Node 大版本或换平台需 `npm rebuild`（Windows 上 install 自动重编）。
- M4 长期记忆当前不引入向量库：先用 SQLite 结构化字段、启停、来源和置信度保证用户可控。
  只有当记忆数量增长到人工列表/确定性筛选无法满足语义召回时，再加向量检索。

### 2.5 通信：HTTP + SSE（而非 WebSocket）
- 任务输出是**单向流式**（引擎→UI），SSE 最贴合、实现最简单、自动重连。
- 需要双向实时（如执行期向用户追问）时，再为特定场景引入 WebSocket。

### 2.6 Monorepo：npm workspaces（而非 pnpm / turbo）
- Node 自带，零额外安装；当前包数量少，够用。
- 包多了或构建变慢，再考虑 pnpm + turborepo。

### 2.7 Agent 循环 / 工具调用：原生 fetch（而非 SDK）

ReAct 工具调用循环继续用原生 `fetch` + 手写 SSE 解析自行实现，
已从单一的 OpenAI 兼容扩展到三种 Provider 协议（Chat Completions / Anthropic Messages / OpenAI Responses v2）：

- **已在用且够用**：`OpenAICompatibleProvider`、`AnthropicProvider`、`OpenAIResponseProvider` 均已基于原生 fetch 运行。
- **SSE 转发最直接**：需把上游 SSE 逐行解析后立刻转换为自有事件（`token`/`tool_call`/`tool_result`）推给前端；
  SDK 会把原始流抽象掉，反而要在 SDK 抽象层与自有事件层之间多做一次转换。
- **累积逻辑不复杂**：流式 `tool_calls` 累积器约 60 行（按 `index` 跨 chunk 拼接），不值得为此引入 34–67 kB 依赖。
- **保留非标准字段**：DeepSeek 的 `reasoning_content` 须原样透传与回传，SDK 可能会剥离。
- **Anthropic SSE 格式不同**：`content_block_start`/`content_block_delta`/`content_block_stop` 结构需自行解析，SDK 不提供优势。
- **零依赖原则**：符合本文「加依赖前自问」纪律。

不选：`openai` SDK（抽象掉原始 SSE，自定义事件转发更繁）、Vercel AI SDK（依赖重、流协议为私有格式、与现有 SSE 契约不兼容）、LangChain.js（依赖与抽象过重）。

### 2.8 Agent Runtime：自研小核心 + 标准协议

当前继续保留自研 TypeScript runtime，而不是立即迁移到 LangGraph / ADK / OpenAI Agents SDK：

- **产品边界更小**：Aurevoy 是本地个人桌面应用，当前需要稳定的任务状态、SSE、SQLite、审批和 MCP，
  自研小核心更容易控制打包体积、跨平台行为和错误路径。
- **协议优先**：MCP、OpenAI-compatible API、HTTP/SSE、SQLite 轨迹记录比绑定某个编排框架更稳定。
- **避免过早多 Agent**：近期目标是把单 Agent 的状态机、沙箱、评测和恢复做扎实。
- **保留迁移可能**：当任务状态图复杂到现有 loop 难以维护时，再评估 LangGraph/ADK 这类显式图工作流。

### 2.9 工程治理：第一等能力

技术选择必须服务交付质量：

- 能力必须真实接入；禁止 Mock、固定回复或静态 UI 冒充完成。
- 新工具必须有风险等级、审批策略、失败路径和回归用例。
- 新执行能力必须先定义沙箱边界，再暴露给模型。
- 状态、轨迹、错误和审批要可持久化、可回看、可诊断。
- M3 回归使用 `scripts/m3-regression.mjs` 启动真实后端、临时 OpenAI-compatible fixture、
  临时 MCP stdio server 和临时 SQLite；测试替身只存在于回归脚本，不进入生产路径。

### 2.10 长期记忆检索：结构化 + 向量混合（已实现）

已引入 `sqlite-vec`（v0.1.x）并完成全链路集成：

- **选型理由**：与现有 better-sqlite3 共享同一 SQLite 文件，零额外服务、零新存储目录。
  同步 load/dump/备份策略不变。原生扩展在 macOS/Windows/Linux 可用（`npm install` 自动重编）。
- **混合评分**：`context.ts` 中的 `scoreMemoriesHybrid()` 将关键词命中、分类加权、
  置信度、时间衰减（关键词评分）与余弦相似度（向量评分）以权重 α 融合，默认 α=0.5。
- **降级路径**：无 embedding Provider 或 sqlite-vec 未加载时，静默降级为纯关键词评分。

**重要性能约束**：
- 必须使用 `MATCH ? AND k = N` 的 KNN 运算符，不可用 `vec_distance_cosine() ORDER BY distance`（慢 190×）。
- 向量维度需与 embedding Provider 输出一致（`memory_vec`/`kb_chunk_vec` 均使用 FLOAT[768]）。

Embedding 通过 OpenAI 兼容 API 接入（`/v1/embeddings`），`baseUrl` 指向任一兼容后端即可：
- **Ollama**：`http://127.0.0.1:11434/v1`，模型 `nomic-embed-text`（768 维）
- **OpenAI**：`https://api.openai.com/v1`，模型 `text-embedding-3-small`（1536 维）
- **LiteLLM / OpenRouter** 等：任意 OpenAI 兼容端点

## 3. 依赖管理纪律

- **锁版本**：优先精确或受控版本，避免无意的大版本跳跃。
- **加依赖前自问**：能否用标准库 / 现有依赖解决？是否活跃维护？包名是否可疑（防 typosquatting）？
- **秘钥**：API Key 等只走环境变量（`.env`，已 gitignore），禁止硬编码或提交。

## 4. 待定 / 未来可能引入

| 方向 | 候选 | 触发条件 |
|---|---|---|
| 真实 LLM | 原生 fetch（OpenAI 兼容 + Anthropic Messages + OpenAI Responses）——**已采用，不引 SDK**（见 2.7） | ✅ 已落地三协议 |
| 工具协议 | `@modelcontextprotocol/sdk` | ✅ 已接入 stdio client；未来扩展 Streamable HTTP / SSE |
| 新工具框架 | **Effect-TS** (`effect` 3.21.x) —— Schema 驱动工具定义、作用域注册、执行管线 | ✅ 已落地 P0-P4 |
| 向量检索 | **sqlite-vec** —— SQLite 原生扩展，零额外服务 | ✅ 已实现混合评分 + KB RAG + Dreams 管道 |
| 显式状态机/图工作流 | 自研状态机；必要时评估 LangGraph/ADK | Agent 阶段和恢复逻辑复杂到当前 loop 不可维护 |
| 可观测性 | SQLite 轨迹日志；后续 OpenTelemetry | ✅ 已接入任务级轨迹；跨任务指标或外部面板时再扩展 |
| 评测 | 脚本化 M3 回归；后续 Vitest/Playwright | ✅ `npm run regression:m3` 覆盖 Agent/安全/恢复最小集 |
| 沙箱 | `sandbox/command-executor.ts`；后续独立进程/容器 | ✅ 已定义默认关闭边界；加 shell/代码执行时替换为隔离实现 |
| 向量检索/记忆 | 当前 SQLite 结构化记忆；候选 sqlite-vec / LanceDB | M4 已评估暂缓引入；当长期记忆需要语义召回、RAG 文档库或跨任务相似度检索时再引入 |
| 前端状态管理 | Zustand / Jotai | 状态复杂到 useState 撑不住 |
| 前端 UI 库 | shadcn/ui 等 | 需要成体系组件 |
| 构建加速 | pnpm + turborepo | 包变多 / 构建变慢 |
| E2E 测试 | Vitest + Playwright | 进入稳定性保障阶段 |
