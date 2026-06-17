# Aurevoy

> 让每个人都拥有属于自己的 AI Agent。

Aurevoy 是一款面向个人用户的通用 AI Agent 桌面应用。用户用自然语言表达目标，
Aurevoy 自主拆解任务、调用工具、执行操作，持续推进直至完成。

**从"会聊天的工具"到"真正能做事的伙伴"。**

## 功能特性

- **LLM 驱动规划** — 侦查工作区 → 生成结构化计划 → 并行工具执行
- **ReAct 工具循环** — 完整的 observe→think→act 循环，支持流式输出
- **内置工具集** — 文件读写/搜索/编辑（diff 精确替换）/复制/移动、HTTP 抓取（SSRF 防护）、网页搜索、命令执行（默认禁用）
- **三级风险审批** — safe/caution/dangerous 风险模型，高危操作需用户确认
- **MCP 协议** — 接入外部工具服务器（如 Playwright 浏览器自动化），工具自动发现与注册
- **Skill 系统** — 斜杠命令激活专业技能（web-search/browser/自定义），动态注入 system prompt + 工具白名单
- **长期记忆** — 跨会话记忆 CRUD，相关性评分排序，`[[link]]` 引用与自动去重
- **多轮对话** — 任务恢复、追问与澄清、编辑重跑（Rewind）、会话分支（branch）、上下文压缩（compact）
- **项目工作区** — 导入文件夹作为项目，对话按项目分组，per-task 沙箱隔离
- **任务产物** — draft → 预览 → 确认 → apply，支持文件/diff/URL 类型
- **Token 管理** — 用量追踪、预算控制、自动语义压缩
- **工程治理** — SQLite 轨迹日志、runtime phase 状态机、可回放审计

## 架构

```
apps/desktop  (Tauri 2 + React + TS) ──HTTP + SSE──▶ apps/agent (Node + Fastify)
   桌面壳 + UI                                              Agent 引擎
                                                              │
                              ┌────────────┬────────────┬─────┴─────┬────────────┐
                          LLM Provider  Tool Registry   SQLite    MCP Client   Skills
                          (OpenAI 兼容)  (内置 + MCP)  (本地存储)  (外部工具)  (预装/自定义)

packages/shared — 前后端共享类型契约
```

Agent 引擎监听 `127.0.0.1:8787`，桌面前端通过本地 HTTP + SSE 通信。

## 快速开始

### 环境要求

- **Node.js** >= 20
- **Rust** (stable) — Tauri 桌面壳构建所需
- **macOS** — 当前仅支持 macOS（ARM64）；需 Xcode Command Line Tools

### 开发

```bash
# 安装依赖
npm install

# 启动开发模式（Agent 引擎 + 桌面应用）
npm run dev

# 仅启动后端引擎（热重载）
npm run dev:agent

# 类型检查
npm run typecheck

# 构建全部
npm run build

# 运行回归测试
npm run regression:m3
npm run regression:m4
npm run regression:m5
npm run regression:m6
npm run regression:m7
```

### 配置

创建 `apps/agent/.env`（或设置环境变量）：

```bash
# LLM Provider（OpenAI 兼容协议）
AUREVOY_LLM_PROVIDER=openai
AUREVOY_LLM_BASE_URL=https://api.openai.com/v1
AUREVOY_LLM_MODEL=gpt-4o-mini
AUREVOY_LLM_API_KEY=sk-xxxx

# 可选：MCP 工具服务器
AUREVOY_MCP_SERVERS_JSON={"mcpServers":{"playwright":{"command":"npx","args":["-y","@anthropic/mcp-server-playwright"],"enabled":true}}}
```

### 打包

```bash
npm run build
npm run tauri:build -w @aurevoy/desktop -- --bundles dmg
```

DMG 输出在 `apps/desktop/src-tauri/target/release/bundle/dmg/`。

## 项目结构

```
Aurevoy/
├── apps/
│   ├── agent/          # Agent 引擎（Node + Fastify）
│   │   ├── src/
│   │   │   ├── agent/      # ReAct 循环、上下文、子代理、事件
│   │   │   ├── tools/      # 内置工具 + MCP 客户端 + Skill 工具
│   │   │   ├── skills/     # Skill 注册表 + 预装 skill
│   │   │   ├── llm/        # LLM Provider 抽象
│   │   │   ├── store/      # SQLite 持久化
│   │   │   ├── sandbox/    # 命令执行沙箱
│   │   │   └── runtime/    # 设置管理
│   │   └── skills/builtin/ # 预装 skill 文件
│   └── desktop/        # Tauri + React 前端
│       └── src/
│           ├── components/ # UI 组件
│           ├── hooks/      # React hooks
│           └── lib/        # API 客户端
├── packages/
│   └── shared/         # 共享 TypeScript 类型契约
├── docs/               # 架构、API、路线图等文档
└── scripts/            # 回归测试脚本
```

## 文档

| 文档 | 内容 |
|------|------|
| [AGENTS.md](AGENTS.md) | 协作入口、架构速览、规则（AI 协作必读） |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 系统架构、模块职责、数据流 |
| [docs/API.md](docs/API.md) | HTTP API 与 SSE 事件契约 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 分阶段开发路线图 |
| [docs/ROADMAP_AGENT_DELIVERY.md](docs/ROADMAP_AGENT_DELIVERY.md) | Agent 功能真实落地路线图 |
| [docs/CONVENTIONS.md](docs/CONVENTIONS.md) | 代码规范与扩展指南 |
| [docs/ENGINEERING_GOVERNANCE.md](docs/ENGINEERING_GOVERNANCE.md) | 工程治理与交付门槛 |
| [docs/TECH_STACK.md](docs/TECH_STACK.md) | 技术选型与取舍 |
| [docs/UI_DESIGN.md](docs/UI_DESIGN.md) | 前端界面设计 |

## CI/CD

GitHub Actions 在每次 push/PR 到 main 时自动执行：
- TypeScript 类型检查
- 全 workspace 构建
- M3-M7 回归测试
- macOS ARM64 DMG 打包

详见 [`.github/workflows/build.yml`](.github/workflows/build.yml)。

## 许可

MIT
