# Aurevoy

> 让每个人都拥有属于自己的 AI Agent。

Aurevoy 是一款面向个人用户的通用 AI Agent 桌面产品。它能理解目标、自主拆解任务、调用工具、执行操作，并持续推进直至完成。

本项目按**可交付产品**建设，而不是技术原型。所有能力必须接入真实运行链路：
模型、工具、审批、任务状态、持久化、错误恢复和用户可见反馈都要可验证；不使用 Mock 或占位行为冒充已完成功能。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 + UI（前端） | Tauri 2.0 + React + TypeScript + Vite |
| Agent 引擎（后端） | Node.js + TypeScript + Fastify |
| 前后端通信 | 本地 HTTP + SSE（流式任务输出） |
| 工具层 | 内置工具 + MCP (Model Context Protocol) |
| 本地存储 | SQLite |
| Monorepo | npm workspaces |

## 架构

前后端分离，便于从 macOS 扩展到 Windows（扩展时 Agent 引擎几乎不动，只重打包桌面壳）：

```
apps/
  desktop/   # Tauri + React 前端：界面、交互、任务可视化
  agent/     # Agent 引擎后端：任务规划、工具调用、记忆，独立本地进程
packages/
  shared/    # 前后端共享的 TypeScript 类型
```

桌面前端通过本地 HTTP + SSE 与 Agent 引擎通信，引擎默认监听 `http://127.0.0.1:8787`。

## 环境要求

- Node.js >= 20
- Rust (stable) — Tauri 构建所需
- macOS：Xcode Command Line Tools

## 开始

```bash
# 安装依赖
npm install

# 同时启动 Agent 引擎 + 桌面应用
npm run dev

# 仅启动后端引擎
npm run dev:agent

# 类型检查
npm run typecheck

# 构建全部
npm run build

# M3 Agent runtime 回归（需先 build）
npm run regression:m3

# M6 Agent 交付能力回归（追问、产物、预算、token、命令执行）
npm run regression:m6
```

## 目录约定

- 新增工具放到 `apps/agent/src/tools/`，通过工具注册表暴露给 Agent 循环。
- 前后端交互的数据结构统一定义在 `packages/shared/src/`，避免类型漂移。
- MCP server 通过 `AUREVOY_MCP_SERVERS_JSON` 可选接入；启动时发现工具并注册到同一工具注册表。
- Agent runtime 相关改动必须同步考虑工程治理：轨迹日志、权限/审批、沙箱边界、失败恢复和回归评测。
- Agent 交付能力从 M6 开始在 [`docs/ROADMAP_AGENT_DELIVERY.md`](./docs/ROADMAP_AGENT_DELIVERY.md) 维护：
  产物、追问、预算、token usage 和命令执行必须有真实链路与回归覆盖。

## 文档

参与开发（人或智能体）请先读 [`AGENTS.md`](./AGENTS.md)，再按需深入：

- [`AGENTS.md`](./AGENTS.md) — 协作入口与硬性规则
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — 系统架构与模块职责
- [`docs/TECH_STACK.md`](./docs/TECH_STACK.md) — 技术选型与取舍
- [`docs/API.md`](./docs/API.md) — HTTP API 与 SSE 事件契约
- [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md) — 代码规范与扩展指南
- [`docs/ENGINEERING_GOVERNANCE.md`](./docs/ENGINEERING_GOVERNANCE.md) — 工程治理与交付门槛
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — 分阶段规划
- [`docs/ROADMAP_AGENT_DELIVERY.md`](./docs/ROADMAP_AGENT_DELIVERY.md) — Agent 功能真实落地路线图
