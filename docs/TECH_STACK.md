# 技术栈

> 选型服务于**本地个人 Agent 桌面产品**，不是训练平台或企业 Serving。

## 总览

| 层 | 技术 | 说明 |
|---|---|---|
| 桌面壳 | Tauri 2 + Rust | 轻量、系统 WebView |
| UI | React 19 + TS + Vite | `@aurevoy/web-ui` 库模式 |
| 引擎 | Node ≥ 22.19 + Fastify 5 | 独立进程 |
| Agent 循环 | `@earendil-works/pi-agent-core` | 主任务与子代理 |
| 工具 | Effect 3 + 自研 framework + MCP SDK | Schema 工具、MCP 扩展 |
| 存储 | better-sqlite3 + sqlite-vec | 任务/轨迹/记忆/KB 一文件 |
| 通信 | HTTP + SSE | 本机回环 |
| Monorepo | npm workspaces | 零额外编排工具 |

## 为何这样选

| 决策 | 理由 | 取舍 |
|---|---|---|
| Tauri 非 Electron | 包体与内存更小，权限可控 | WebView 差异；壳层 Rust |
| TS 全栈 | 与 shared 契约同构，分发无需塞 Python | AI 生态偏 Python → 用 Pi + MCP 补 |
| Fastify | 性能与 TS 友好，SSE 用原生流 | — |
| better-sqlite3 | 同步 API、本地单用户 | 原生模块需按 Node/平台 rebuild |
| sqlite-vec | 同库向量，零额外服务 | 需 embedding；失败降级关键词 |
| SSE 非 WS | 任务输出单向流式 | 双向场景仍用 HTTP 追问/审批 |
| Pi 非自研 ReAct | 统一主循环与工具执行策略 | 控制面（审批/沙箱/轨迹）仍在 Aurevoy |
| Effect 工具 | Schema I/O、作用域注册、可测 | 学习曲线；旧路径逐步收敛 |

不选：LangChain 重量级编排、Vercel AI SDK 私有流协议、Prisma 对本地同步路径过重。

## 记忆与 KB

- 记忆：结构化字段 + 向量混合评分（α·关键词 + (1-α)·向量）；无 embedding 时纯关键词。  
- KB：目录索引、分块、KNN `recall`；KNN 用 `MATCH ? AND k = N`，避免全表距离排序。  
- Embedding：OpenAI 兼容 `/v1/embeddings`（Ollama / OpenAI / 兼容网关）。

## 纪律

- 加依赖前问：标准库能否搞定？维护是否活跃？  
- 锁可控版本；密钥只走 env / 设置库。  
- 已落地的不在「待定」重复：Pi、MCP、Effect 工具、sqlite-vec、任务轨迹、命令沙箱边界。

## 仍可评估

| 方向 | 触发条件 |
|---|---|
| 图工作流框架 | 当前 harness 无法维护复杂阶段/恢复 |
| OTel 等外部观测 | 需要跨任务/跨机面板 |
| pnpm/turbo | 包数与构建时间明显上升 |
| Playwright E2E | 发布门槛需要 UI 级回归 |
| 更强沙箱（进程/容器） | 开放高风险 shell/代码执行时 |
