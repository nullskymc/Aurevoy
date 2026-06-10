# AGENTS.md — Aurevoy 协作指南（智能体优先）

> 本文件是任何参与 Aurevoy 开发的智能体（或人类）的**第一入口**。
> 开始任何任务前，先读完本文件，再按需深入 `docs/` 下的专题文档。

## 1. 这个项目是什么

Aurevoy 是一款**面向个人用户的通用 AI Agent 桌面产品**。用户用自然语言表达目标，
Aurevoy 负责理解目标、拆解任务、调用工具、执行操作并持续推进直至完成。

- 产品愿景与理念见 [`start.md`](./start.md)。
- 当前阶段：已完成真实 LLM、ReAct 工具循环、内置工具、审批闭环与 MCP 接入；
  后续开发目标不是技术原型，而是**可交付、可恢复、可审计、可评测的个人 Agent 产品**。

## 2. 30 秒架构速览

前后端分离，先 macOS 后 Windows（扩展时后端几乎不动，只重打包桌面壳）：

```
apps/desktop  (Tauri 2.0 + React + TS)   ──HTTP + SSE──▶  apps/agent (Node + Fastify)
   桌面壳 + UI（前端）                                        Agent 引擎（后端，独立进程）
                                                                  │
                                              ┌───────────────────┼───────────────────┐
                                          LLM Provider        Tool Registry        SQLite
                                          (OpenAI 兼容)        (内置 + MCP)         (本地存储)
packages/shared (TS 类型)  ← 前后端共享契约，跨进程数据结构唯一来源
```

引擎默认监听 `http://127.0.0.1:8787`。详见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

## 3. 文档地图

| 文档 | 内容 | 何时读 |
|---|---|---|
| `AGENTS.md`（本文） | 协作总则、速览、规则 | 永远先读 |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | 系统架构、模块职责、数据流 | 理解全局 / 改动跨模块 |
| [`docs/TECH_STACK.md`](./docs/TECH_STACK.md) | 技术选型与取舍理由 | 引入新依赖 / 选型决策 |
| [`docs/API.md`](./docs/API.md) | HTTP API + SSE 事件契约 | 改前后端接口 |
| [`docs/UI_DESIGN.md`](./docs/UI_DESIGN.md) | 人机交互、信息架构、前端界面设计 | 改桌面 UI / 设计 Agent 工作台 |
| [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md) | 代码规范、目录约定、扩展指南 | 写任何代码前 |
| [`docs/ENGINEERING_GOVERNANCE.md`](./docs/ENGINEERING_GOVERNANCE.md) | 工程治理、可观测性、安全、评测与交付门槛 | 改 Agent runtime / 工具 / 存储 / 发布流程 |
| [`docs/ROADMAP.md`](./docs/ROADMAP.md) | 分阶段规划与任务清单 | 决定"做什么" |
| [`docs/ROADMAP_AGENT_DELIVERY.md`](./docs/ROADMAP_AGENT_DELIVERY.md) | Agent 功能真实落地路线图 | 规划从技术底座到可用任务执行能力 |

## 4. 给协作智能体的硬性规则

1. **契约唯一来源**：任何跨进程（前端↔后端）的数据结构，必须定义在 `packages/shared/src/`。
   不要在前端或后端各自重复定义，避免类型漂移。
2. **改契约要联动**：改了 `@aurevoy/shared` 的类型后，必须 `npm run build:shared`，
   否则前后端拿到的是旧的 `dist`。
3. **新增工具**：放到 `apps/agent/src/tools/`，并通过 `toolRegistry.register()` 注册。
   不要把工具逻辑写进 Agent 循环里。
4. **新增 LLM Provider**：实现 `apps/agent/src/llm/provider.ts` 的 `LLMProvider` 接口，
   在 `getProvider()` 里按配置返回。Agent 循环不感知具体厂商。
5. **跨平台意识**：后端不要依赖 macOS 专有路径/命令；前端不要假设 Tauri 之外的运行环境。
   目标是 macOS → Windows 平滑扩展。
6. **不做假能力**：禁止用 Mock、占位回复、演示数据或“看起来能用”的前端状态冒充真实能力。
   外部能力不可用时必须明确失败、降级或提示配置缺失，并留下可诊断信息。
7. **完成即验证**：任何改动后至少跑 `npm run typecheck`；动了后端跑冒烟测试；动了前端跑 `vite build`。
   影响 Agent 行为、工具、安全或存储的改动还要补充可复现的轨迹/用例。
8. **秘钥安全**：API Key 等只能走环境变量（`.env`，已 gitignore），禁止硬编码或提交。
9. **工程治理优先**：新增工具、执行器、记忆、设置或任务控制时，必须同步考虑日志、审批、
   权限边界、失败恢复、回归评测与用户可解释性。

## 5. 常用命令

```bash
npm install            # 安装全部 workspace 依赖
npm run dev            # 同时启动 Agent 引擎 + 桌面应用（会先构建 shared）
npm run dev:agent      # 仅后端引擎（tsx watch 热重载）
npm run typecheck      # 全 workspace 类型检查
npm run build          # 构建 shared → agent → desktop
npm run build:shared   # 仅构建共享类型（改完 shared 必做）
npm run regression:m6  # M6 交付能力回归（追问/产物/预算/token/命令）
```

环境要求：Node >= 20、Rust (stable)、macOS Xcode CLT。详见 README。

## 6. 当前进度与交付方向

- ✅ Monorepo、前后端通信、SSE 流式、SQLite、全链路跑通。
- ✅ 真实 LLM Provider（OpenAI 兼容，`.env` 配置，未配置即报错）；前端对话式界面重做。
- ✅ M1：ReAct 工具调用循环（防死循环/重试/取消）+ 前端工具调用可视化。
- ✅ M2：已落地**内置工具**（文件读写/目录/HTTP 抓取，限定工作区）+
  **工具风险模型与审批闭环**（`riskLevel` / `approval_request` / `POST …/approvals`，前端审批按钮）+
  **MCP TypeScript SDK 接入**（启动期连接 `AUREVOY_MCP_SERVERS_JSON` 配置的 stdio servers 并注册工具）。
- ✅ M3：工程治理已落地：显式 runtime phase、SQLite 轨迹日志、运行详情轨迹回看、
  `npm run regression:m3` 回归集、命令执行器沙箱边界（默认关闭）。
- ✅ M4：记忆、多轮对话与任务恢复已落地：上下文压缩、长期记忆 CRUD/来源/置信度、
  向量检索选型评估、启动期中断扫描与 `POST /api/tasks/:id/resume` 真实恢复。
- ✅ M6：Agent 交付能力已落地：结构化追问、任务产物、执行预算、token usage、
  `create_artifact`/`apply_artifact`/`execute_command` 工具、前端产物与追问展示、
  `npm run regression:m6` 回归集。
- ✅ M7：工具扩展与安全加固已落地：文件工具（搜索/复制/移动/删除）、`http_fetch` SSRF 防护、
  工具 schema validation、MCP 描述净化、多步计划与 checkpoint、前端工作台拆分、
  `npm run regression:m7` 回归集。
- ✅ 编辑重跑（Rewind / Edit & Regenerate）三阶段已完成：
  revert 截断 + 多模式选择（`code_and_conv`/`conv_only`）+ unrevert 撤销 +
  会话分支（branch）+ 上下文压缩（compact）。
  新增 4 个端点（`revert`/`unrevert`/`branch`/`compact`）、4 个 SSE 事件、2 个 SQLite 列。
- 当前重点：M5 设置、分发、Windows 与交付质量（macOS 打包签名、Windows 适配）。
  Agent 功能路线进入 M8：知识库/RAG、Agent usability eval、浏览器 MCP、发布体验。
  详见 [`docs/ROADMAP.md`](./docs/ROADMAP.md)、[`docs/ROADMAP_AGENT_DELIVERY.md`](./docs/ROADMAP_AGENT_DELIVERY.md)
  与 [`docs/ENGINEERING_GOVERNANCE.md`](./docs/ENGINEERING_GOVERNANCE.md)。
