# AGENTS.md — Aurevoy 协作指南（智能体优先）

> 本文件是任何参与 Aurevoy 开发的智能体（或人类）的**第一入口**。
> 开始任何任务前，先读完本文件，再按需深入 `docs/` 下的专题文档。

## 1. 这个项目是什么

Aurevoy 是一款**面向个人用户的通用 AI Agent 桌面产品**。用户用自然语言表达目标，
Aurevoy 负责理解目标、拆解任务、调用工具、执行操作并持续推进直至完成。

- 产品愿景与理念见 [`start.md`](./start.md)。
- 当前阶段：**项目骨架已搭好并验证通过**，处于"接入真实能力"阶段。

## 2. 30 秒架构速览

前后端分离，先 macOS 后 Windows（扩展时后端几乎不动，只重打包桌面壳）：

```
apps/desktop  (Tauri 2.0 + React + TS)   ──HTTP + SSE──▶  apps/agent (Node + Fastify)
   桌面壳 + UI（前端）                                        Agent 引擎（后端，独立进程）
                                                                  │
                                              ┌───────────────────┼───────────────────┐
                                          LLM Provider        Tool Registry        SQLite
                                          (现 Mock)            (MCP 接入点预留)      (本地存储)
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
| [`docs/ROADMAP.md`](./docs/ROADMAP.md) | 分阶段规划与任务清单 | 决定"做什么" |

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
6. **完成即验证**：任何改动后至少跑 `npm run typecheck`；动了后端跑冒烟测试；动了前端跑 `vite build`。
7. **秘钥安全**：API Key 等只能走环境变量（`.env`，已 gitignore），禁止硬编码或提交。

## 5. 常用命令

```bash
npm install            # 安装全部 workspace 依赖
npm run dev            # 同时启动 Agent 引擎 + 桌面应用（会先构建 shared）
npm run dev:agent      # 仅后端引擎（tsx watch 热重载）
npm run typecheck      # 全 workspace 类型检查
npm run build          # 构建 shared → agent → desktop
npm run build:shared   # 仅构建共享类型（改完 shared 必做）
```

环境要求：Node >= 20、Rust (stable)、macOS Xcode CLT。详见 README。

## 6. 当前进度与下一步

- ✅ Monorepo 骨架、前后端通信、SSE 流式、SQLite、Mock 引擎全链路跑通。
- ⏳ 待接入：真实 LLM Provider、真实 Agent 规划/反思循环、MCP 工具、前端任务历史与多轮对话。
- 详细任务拆解见 [`docs/ROADMAP.md`](./docs/ROADMAP.md)。
