# AGENTS.md — Aurevoy 协作指南（智能体优先）

> 本文件是任何参与 Aurevoy 开发的智能体（或人类）的**第一入口**。
> 开始任何任务前，先读完本文件，再按需深入 `docs/` 下的专题文档。

## 1. 这个项目是什么

Aurevoy 是一款**面向个人用户的通用 AI Agent 桌面产品**。用户用自然语言表达目标，
Aurevoy 负责理解目标、拆解任务、调用工具、执行操作并持续推进直至完成。

- 当前阶段：已完成 LLM 驱动规划、并行工具执行、Skill 系统、网页搜索、浏览器自动化（MCP）、
  子代理委托、Diff 编辑、Token 感知压缩、长期记忆相关性检索等全套 Agent 能力。
  开发目标是**可交付、可恢复、可审计、可评测的个人 Agent 产品**。

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
| [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md) | 代码规范、目录约定、工程治理、扩展指南 | 写任何代码前 |
| [`docs/ROADMAP.md`](./docs/ROADMAP.md) | 分阶段规划与任务清单 | 决定"做什么" |
| [`.github/workflows/build.yml`](./.github/workflows/build.yml) | CI/CD 自动构建与回归 | 了解构建流程 |

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
npm install              # 安装全部 workspace 依赖
npm run dev              # 同时启动 Agent 引擎 + 桌面应用
npm run dev:agent        # 仅后端引擎（tsx watch 热重载）
npm run typecheck        # 全 workspace 类型检查
npm run build            # 构建 shared → agent → desktop
npm run build:shared     # 仅构建共享类型（改完 shared 必做）
npm run regression:m3    # M3 基础 Agent、安全、审批、取消
npm run regression:m4    # M4 多轮、记忆、恢复
npm run regression:m5    # M5 设置、工具管理、数据管理、MCP
npm run regression:m6    # M6 追问、产物、预算、token、命令执行
npm run regression:m7    # M7 文件工具、网络安全、schema、计划、checkpoint
```

环境要求：Node >= 20、Rust (stable)、macOS Xcode CLT。详见 README。

## 6. 当前进度与交付方向

- ✅ M0-M2：Monorepo、前后端通信、SSE、LLM Provider、ReAct 循环、内置工具、审批、MCP
- ✅ M3：工程治理（runtime phase、轨迹日志、`m3` 回归集、沙箱边界）
- ✅ M4：多轮对话、长期记忆、任务恢复
- ✅ M5：设置界面、工具管理、数据管理、跨平台 CI
- ✅ M6：追问、产物、预算、token usage、命令执行
- ✅ M7：文件工具、网络安全、多步计划、checkpoint、前端工作台
- ✅ Rewind：编辑重跑/撤销/分支/压缩
- ✅ Project：项目工作区与对话分组
- ✅ P1-P7：Agent 架构重构（LLM 规划→并行执行→截断→语义压缩→记忆评分→Diff 编辑→子代理）
- ✅ Skill 系统：load_skill 工具激活、install_skill 从 Git 安装、预装 skill（web-search/browser）、工具白名单
- ✅ 网页搜索：`web_search` 工具，DuckDuckGo 免费搜索
- ✅ CI/CD：GitHub Actions macOS ARM64 自动构建 + M3-M7 回归
- ✅ Multimodal：图片/文件拖拽粘贴、视觉模型、图片查看器
- ✅ 其他：Python 运行时、行级文件工具、审批三分区 + 命令前缀审批、planStepId 时间线分组
- 🚧 M5 打包签名：macOS 签名公证、自动更新（需 Apple Developer 账号）
- ⬜ M8：知识库/RAG、Agent usability eval、浏览器自动化（Playwright MCP）、发布体验

详见 [`docs/ROADMAP.md`](./docs/ROADMAP.md)。
