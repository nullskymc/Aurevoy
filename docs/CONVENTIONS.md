# 开发约定

> 写代码前读本文。目标：风格一致、可维护、跨平台、真实能力。

## 目录

```
apps/desktop/          Tauri 壳 + 平台适配
apps/agent/src/        引擎（server / agent / tool / store / …）
packages/web-ui/src/   UI 与 api 客户端
packages/shared/src/   跨进程类型
scripts/               回归
```

命名：模块 `camelCase.ts`，组件 `PascalCase.tsx`，包 `@aurevoy/*`。

## TypeScript

- `strict`；禁止裸 `any`（用 `unknown` 收窄）。  
- 后端 NodeNext：相对导入带 `.js`。  
- 跨进程类型只从 `@aurevoy/shared` 导入。  
- 优先具名导出。

## 后端

- `server.ts` 只做路由/I/O；业务在 `agent/`、`tool/`、`store/`。  
- 运维配置经 env（`HOST`/`PORT`/`DB_PATH`/日志等）；产品配置经 runtime settings / SQLite，不散落 `process.env`。  
- 任务状态变更写 SQLite + 发 `AgentEvent`；轨迹写 `traceStore`。  
- 命令/代码执行只经 `sandbox/`；默认关闭。  
- 工具：Effect `tool/tools/*` + `register()`；不在 loop 内联工具逻辑。

## 前端

- 业务真相来自任务快照 + SSE，组件只渲染与交互。  
- HTTP 统一走 `packages/web-ui/src/api/`。  
- `EventSource` 在卸载 / `done` / 重开任务时 `close()`。  
- Base URL：`AGENT_DEFAULT_BASE_URL`，可用 `VITE_AGENT_BASE_URL` 覆盖。

## 跨平台

- 路径用 `node:path`，无硬编码分隔符/绝对路径。  
- 无 macOS 专用 shell（`open`/`osascript` 等）；系统能力走 Tauri。  
- 原生模块换平台后 rebuild。

## 交付要求（摘要）

| 能力 | 必须 | 禁止 |
|---|---|---|
| 状态 | 显式 `TaskStatus`/`TaskPhase` 持久化 | 仅前端猜状态 |
| 失败 | 可分类错误 + 用户可读信息 | 静默吞错 |
| 审批 | 非 safe 工具真实门禁 | UI 假按钮 |
| 恢复 | 中断/失败可 resume 或可解释 | 丢历史硬重启 |
| 观测 | 轨迹/关键事件落库 | 只 console |
| 配置 | 设置页读写真配置 | 静态表单冒充 |

## 扩展速查

**新工具：** `tool/tools/<name>/` 定义 Schema → registry → 必要时 shared 事件/描述；相关回归在准备提交时执行。

**新 Provider：** 扩展 `llm/pi-provider` 映射与设置槽位（不新增产品向 env）。  

**改契约：** 改 shared；在涉及 shared 改动的单个任务完成时执行 `npm run build:shared`，再修 agent/web-ui 编译。

**回归：** 行为相关改动优先补 `scripts/m*-regression.mjs` 或现有 vitest；仅在准备提交时执行相关回归。

## 提交前

- [ ] `npm run typecheck`  
- [ ] 相关 `build` / 回归  
- [ ] 无密钥、无假能力、无未联动的 shared 类型  
- [ ] 文档：契约或用户可见行为变了才改 `docs/`（保持短，不贴大段实现）

## Git

- 信息：`type: summary`（feat/fix/docs/refactor/chore…）  
- 小步提交；不 force push 共享分支除非团队约定。
