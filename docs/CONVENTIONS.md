# 开发约定 — CONVENTIONS

> 写任何代码前先读本文。目标：让人类与智能体产出风格一致、可维护、跨平台安全的代码。
> Aurevoy 以可交付产品为目标；不要用 Mock、占位 UI、静态数据或固定回复冒充真实能力。

## 1. 目录与命名

```
apps/
  desktop/src/          前端源码
    lib/                纯逻辑/客户端（如 api.ts），无 React
    components/         （建议）可复用 React 组件
    App.tsx, main.tsx   入口
  agent/src/
    index.ts            进程入口
    config.ts           配置
    server.ts           路由层（只做 HTTP/SSE，不写业务）
    agent/              Agent 循环与事件总线
    llm/                LLM Provider 抽象与实现
    tools/              工具与注册表
    sandbox/            高风险执行器边界（命令/代码执行默认关闭）
    store/              持久化
  scripts/              回归/冒烟脚本
packages/shared/src/    跨进程类型（契约）
```

- 文件名：`camelCase.ts`（模块）/ `PascalCase.tsx`（React 组件）。
- 类型/接口/类：`PascalCase`；变量/函数：`camelCase`；常量：`UPPER_SNAKE_CASE`。
- 包名统一 `@aurevoy/*`。

## 2. TypeScript 规范

- 全仓 `strict: true`，禁止 `any`（用 `unknown` + 收窄）。
- 后端模块用 **NodeNext**：相对导入要带 `.js` 后缀（如 `import { x } from './config.js'`）。
- 共享类型只从 `@aurevoy/shared` 导入，**不在前后端重复定义**。
- 导出优先具名导出；避免默认导出（React 组件除外）。

## 3. 后端规范

- `server.ts` 只负责路由与 I/O，**业务逻辑下沉**到 `agent/`、`tools/`、`store/`。
- 所有可变运行参数走 `config.ts`（读环境变量并给默认值），不要散落 `process.env`。
- Agent 执行中向前端传递的一切，必须经 `taskEvents.publish(event)` → SSE，不要另开通道。
- 错误处理：循环里 `try/catch`，失败时 emit `error` + `done(failed)`，不要让进程崩。
- 长任务用 `void runTask(task)` 异步触发，HTTP 请求立即返回。
- 禁止把 Mock LLM、固定工具结果或演示数据接入生产路径；测试替身只能放在测试代码或显式 smoke 脚本中。
- 新增工具必须走 `toolRegistry.register()`，声明 `riskLevel` 和 `inputSchema`，并说明失败路径。
- 新增高风险能力（写文件、网络、命令、系统操作）必须先接入审批和审计，再开放给 Agent。
- Agent 状态变化要可持久化、可恢复；不要只维护内存变量或前端临时状态。
- 轨迹日志写入 `traceStore`，不要只写 console；Provider 不支持 token/cost 时记录为 `null`。
- 命令/代码执行必须经过 `sandbox/command-executor.ts` 的策略边界；默认关闭，不允许工具直接调用本机 shell。

## 4. 前端规范

- UI 不持有"业务真相"，状态来自后端事件流；组件只渲染 + 交互。
- 访问后端统一走 `src/lib/api.ts`，不要在组件里散写 `fetch`。
- 用完的 `EventSource` 必须 `close()`（组件卸载、收到 `done`、重新提交时）。
- 后端地址用 `AGENT_DEFAULT_BASE_URL`，允许 `VITE_AGENT_BASE_URL` 覆盖。

## 5. 跨平台纪律（mac → win）

- 路径用 `node:path` 拼接，绝不硬编码分隔符或绝对路径。
- 不调用平台专有命令（`open`、`osascript` 等）；需要系统能力走 Tauri 插件。
- 换平台后原生模块（better-sqlite3）由 `npm install` 自动重编，CI 需覆盖两平台。

## 6. 扩展配方（Cookbook）

### 新增一个工具
```ts
// apps/agent/src/tools/myTool.ts
import { toolRegistry } from './registry.js';
toolRegistry.register({
  descriptor: { name: 'read_file', description: '读取文本文件',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  async execute(args) { /* ... */ return { content: '...' }; },
});
```
然后在引擎启动路径 import 一次该文件以触发注册。

### 新增一个 LLM Provider
```ts
// apps/agent/src/llm/openai.ts
import type { LLMProvider, LLMChunk } from './provider.js';
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  async *stream(messages): AsyncIterable<LLMChunk> { /* 调 SDK，逐 token yield */ }
}
// 在 provider.ts 的 getProvider() 里按 process.env.AUREVOY_LLM_PROVIDER 返回
```

### 改一个跨进程类型
1. 改 `packages/shared/src/index.ts`。
2. `npm run build:shared`。
3. 前后端按编译错误同步更新。

### 回归 M3 Agent runtime

```bash
npm run build
npm run regression:m3
```

`regression:m3` 会启动真实 Fastify 后端、临时 OpenAI-compatible fixture、临时 MCP stdio server、
临时 SQLite 和工作区，覆盖直接回答、读文件、写文件审批、HTTP 审批、MCP 工具、取消、
目录穿越、symlink 越界、审批拒绝/超时、非法 URL、未配置 Key、迟到 SSE 和历史轨迹回看。

### 回归 M6 Agent 交付能力

```bash
npm run build
npm run regression:m6
```

`regression:m6` 覆盖结构化追问、追问超时、artifact 草稿/确认/拒绝、预算超限、
Provider token usage、`execute_command` 成功执行和工作区 cwd 越界拒绝。

### 回归 M7 工具与安全治理

```bash
npm run build
npm run regression:m7
```

`regression:m7` 覆盖 `search_files`、文件复制/移动/删除、删除默认禁用、审批拒绝、
`http_fetch` SSRF/重定向策略、工具 schema validation、MCP 描述净化、本地风险覆盖、
多步计划和 checkpoint 恢复。

## 7. 提交前检查清单

- [ ] `npm run typecheck` 通过
- [ ] 改了 shared → 已 `npm run build:shared`
- [ ] 改了后端 → 跑过冒烟（health / 建任务 / SSE）
- [ ] 改了前端 → `npm run build -w @aurevoy/desktop` 通过
- [ ] 改了 Agent loop / 工具 / 审批 / 存储 → 有可复现的轨迹或回归用例
- [ ] 改了 Agent runtime / 工具 / 审批 / 安全边界 → `npm run regression:m3` 通过
- [ ] 改了 M6 交付链路（追问 / 产物 / 预算 / token / 命令执行）→ `npm run regression:m6` 通过
- [ ] 改了 M7 工具 / HTTP 安全 / schema / MCP / checkpoint / 工作台拆分 → `npm run regression:m7` 通过
- [ ] 新增工具 → 已声明风险等级、审批行为、错误路径和输入 schema
- [ ] 新增执行能力 → 已定义沙箱/权限边界、超时、输出上限和取消路径
- [ ] 无硬编码秘钥；无平台专有路径/命令
- [ ] 临时文件已清理

## 8. Git 约定

- 提交信息建议 Conventional Commits：`feat: …` / `fix: …` / `docs: …` / `refactor: …`。
- 只在用户明确要求时创建提交；优先暂存具体文件而非 `git add .`。
- `.env`、`*.sqlite`、`dist/`、`target/` 已 gitignore，勿提交。
