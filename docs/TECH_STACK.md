# 技术栈 — TECH_STACK

> 记录 Aurevoy 的技术选型、版本与**取舍理由**。引入新依赖或做选型决策前请先读本文。

## 1. 总览

| 层 | 技术 | 版本（初始化时） | 角色 |
|---|---|---|---|
| 桌面壳 | Tauri | 2.x（cargo 解析到 tauri 2.11） | 跨平台窗口/打包/系统集成 |
| 壳语言 | Rust | stable（1.96） | Tauri 构建所需 |
| 前端框架 | React | 19.1 | UI |
| 前端语言 | TypeScript | ~5.8 | 类型安全 |
| 前端构建 | Vite | 7.x | 开发服务器 + 打包 |
| 后端运行时 | Node.js | >= 20（开发机 25） | Agent 引擎进程 |
| 后端框架 | Fastify | 5.x | HTTP + SSE 服务 |
| 后端语言 | TypeScript | 5.7 | 全栈统一语言 |
| 开发热重载 | tsx | 4.x | 直接跑 TS，watch 模式 |
| 本地存储 | better-sqlite3 | 11.x | 同步 SQLite，简单可靠 |
| 工具协议 | MCP | —（预留） | 标准化工具/数据源接入 |
| Monorepo | npm workspaces | npm 11 | 多包管理，零额外工具 |

## 2. 关键选型与理由

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
- 后续向量检索可加 `sqlite-vec` 扩展或独立向量库。

### 2.5 通信：HTTP + SSE（而非 WebSocket）
- 任务输出是**单向流式**（引擎→UI），SSE 最贴合、实现最简单、自动重连。
- 需要双向实时（如执行期向用户追问）时，再为特定场景引入 WebSocket。

### 2.6 Monorepo：npm workspaces（而非 pnpm / turbo）
- Node 自带，零额外安装；当前包数量少，够用。
- 包多了或构建变慢，再考虑 pnpm + turborepo。

## 3. 依赖管理纪律

- **锁版本**：优先精确或受控版本，避免无意的大版本跳跃。
- **加依赖前自问**：能否用标准库 / 现有依赖解决？是否活跃维护？包名是否可疑（防 typosquatting）？
- **秘钥**：API Key 等只走环境变量（`.env`，已 gitignore），禁止硬编码或提交。

## 4. 待定 / 未来可能引入

| 方向 | 候选 | 触发条件 |
|---|---|---|
| 真实 LLM | OpenAI / Anthropic / 本地(ollama) SDK | 进入"接真实模型"阶段 |
| 工具协议 | `@modelcontextprotocol/sdk` | 接第一个 MCP server |
| 向量检索/记忆 | sqlite-vec / LanceDB | 做长期记忆与 RAG |
| 前端状态管理 | Zustand / Jotai | 状态复杂到 useState 撑不住 |
| 前端 UI 库 | shadcn/ui 等 | 需要成体系组件 |
| 构建加速 | pnpm + turborepo | 包变多 / 构建变慢 |
| E2E 测试 | Vitest + Playwright | 进入稳定性保障阶段 |
