# 路线图 — ROADMAP

> 分阶段规划与任务清单。决定"接下来做什么"时读本文。每完成一项请勾选并更新状态。

## 阶段总览

| 阶段 | 主题 | 状态 |
|---|---|---|
| M0 | 骨架与全链路打通 | ✅ 完成 |
| M1 | 接入真实 LLM 与真正的 Agent 循环 | ⏳ 进行中/下一步 |
| M2 | 工具能力（MCP）与本地操作 | ⏳ 待启动 |
| M3 | 记忆与个性化 | ⏳ 待启动 |
| M4 | 产品化：多轮对话、任务历史、设置 | ⏳ 待启动 |
| M5 | 打包分发与 Windows 扩展 | ⏳ 待启动 |

---

## M0 — 骨架（✅ 已完成）

- [x] npm workspaces monorepo（desktop / agent / shared）
- [x] 前后端通信：HTTP + SSE，引擎监听 127.0.0.1:8787
- [x] 共享类型契约 `@aurevoy/shared`
- [x] Agent 引擎：Fastify + 事件总线 + Mock LLM + 工具注册表 + SQLite
- [x] 前端：Tauri + React，任务输入与流式输出 UI
- [x] 全链路验证：typecheck、后端冒烟、前端构建、Tauri `cargo check`

## M1 — 真实智能（下一步）

- [ ] 接入真实 LLM Provider（OpenAI / Anthropic / 本地 ollama 之一），保留 Mock 作回退
- [ ] Provider 配置与 Key 管理（`.env` + 设置界面），多 Provider 切换
- [ ] 真正的 Agent 循环：**规划 → 选择动作 → 执行 → 观察 → 反思** 的迭代，由 LLM 驱动
- [ ] 工具调用闭环：把 `ToolRegistry` 暴露给 LLM（function calling），emit `tool_call`/`tool_result`
- [ ] 流式与中断：支持取消任务（`cancelled`）、暂停/继续
- [ ] 错误与重试策略

## M2 — 工具与操作（MCP）

- [ ] 集成 MCP TypeScript SDK，启动期把 MCP server 工具注册进 `toolRegistry`
- [ ] 内置基础工具：文件读写、HTTP 抓取、shell（带权限确认）
- [ ] 工具权限模型：危险操作需用户确认（呼应桌面侧 Tauri capabilities）
- [ ] 工具调用可视化（前端展示调用与结果）

## M3 — 记忆与个性化

- [ ] 持久记忆：用户偏好、习惯、长期事实
- [ ] 向量检索（sqlite-vec / LanceDB）支撑 RAG 与相关记忆召回
- [ ] 会话级短期记忆 vs 跨会话长期记忆的分层

## M4 — 产品化

- [ ] 多轮对话（同一任务内继续追问/补充）
- [ ] 任务历史列表与详情回看（已有 `GET /api/tasks` 基础）
- [ ] 设置界面：模型、Key、工具开关、数据管理
- [ ] UI 打磨：计划/工具/思考过程的清晰呈现

## M5 — 分发与 Windows

- [ ] macOS 打包、签名、自动更新
- [ ] 引擎随桌面应用启动的进程管理（sidecar 或子进程托管）
- [ ] Windows 适配：WebView2、原生模块重编、路径与权限
- [ ] 跨平台 CI（mac + win 双平台构建与冒烟）

---

## 给协作智能体的取任务建议

1. 一次只推进一个有边界的小目标，完成即按 `CONVENTIONS.md` 验证。
2. 动 LLM/工具/存储能力时，保持抽象接口不变，新增实现而非改循环。
3. 接口/类型有变动，先改 `shared` 再联动两端。
4. 在本文勾选你完成的项，必要时拆出更细子任务。
