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
    agent/              Pi harness 控制器、事件总线、审批引擎
    llm/                LLM Provider 抽象与实现（三协议）
    tool/               新一代 Effect-TS 工具系统（推荐）
      framework/        工具框架（定义/注册/执行/权限）
      tools/            领域工具（read/write/edit/grep/...）
      filesystem/       Effect 文件系统服务
    skills/             技能系统
    memory/             长期记忆（向量检索 + Dreams）
    knowledge-base/     知识库 RAG（索引 + 语义召回）
    embedding/          Embedding Provider
    sandbox/            高风险执行器边界（命令/代码执行默认关闭）
    store/              持久化
  scripts/              回归/冒烟脚本
packages/
  shared/src/           跨进程类型（契约）
  web-ui/               独立 React 组件库（Vite 构建）
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
- 长任务用 `void runHarnessTask(task)` 异步触发，HTTP 请求立即返回。
- 禁止把 Mock LLM、固定工具结果或演示数据接入生产路径；测试替身只能放在测试代码或显式 smoke 脚本中。
- 新增工具必须走统一工具注册表，声明 `riskLevel` 和 `inputSchema`，并说明失败路径。
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

## 6. 交付级 Agent Runtime 要求

| 能力 | 最低要求 | 不可接受 |
|---|---|---|
| 模型调用 | 真实 Provider；未配置 Key 明确失败；记录 provider/model | 回退到 Mock 答案或固定回复 |
| 工具调用 | 工具统一注册；riskLevel 生效；非 safe 工具需审批 | 在 Agent loop 内写工具特例；绕过审批 |
| MCP | 启动期发现工具；连接失败可诊断；工具名稳定 | MCP server 失败导致整个引擎不可用 |
| 状态 | 任务、消息、计划、工具结果持久化 | 刷新或重启后任务状态不可恢复 |
| 产物 | 先生成 draft artifact；用户确认/审批后才写真实文件 | 直接覆盖用户文件或只给口头"已完成" |
| 追问 | 信息不足时进入 `waiting_clarification` 并等待真实用户回复 | 编造用户意图或新建任务丢历史 |
| 预算 | 轮次、工具调用、耗时、输出量可配置且超限可诊断 | 无限循环、无限输出或只靠 prompt 限制 |
| 取消/超时 | LLM 和等待审批可取消；超时进入失败/拒绝路径 | 用户点停止但后端继续不可见执行 |
| 错误 | 错误进入 `error` + `done(failed)`；UI 可见 | 后端吞错、前端卡在运行中 |

### 可观测性与审计

新增 runtime 能力时，应确保以下结构化记录落入 SQLite `traceStore`：

- `taskId`、`iteration`、`provider`、`model`、开始/结束时间、最终状态。
- 每次 LLM 请求的轮次、finish reason、重试次数、超时/取消原因。
- 每次工具调用的工具名、参数摘要、riskLevel、审批结果、耗时、成功/失败。
- 用户审批决策：批准/拒绝、时间、关联 callId。
- 错误分类：配置错误、模型错误、工具错误、权限错误、超时、取消、解析错误。
- 成本指标：token 用量在 Provider 支持时记录；不支持时明确为空。
- 交付产物：artifact id、类型、状态、来源 callId、确认/拒绝/写入路径。
- 人机交互：clarification id、问题、用户回复、超时/取消状态。

后续再考虑 OpenTelemetry/Prometheus/LangSmith 等外部观测系统。

### 沙箱与权限

当前已具备文件路径限制和工具审批，引入 shell、代码执行、浏览器控制或系统操作前，必须满足：

- 默认关闭高风险工具，用户显式开启。
- 文件访问限定工作区，真实路径校验要跟随 symlink。
- 写入、删除、网络访问、执行命令必须进入审批流。
- 命令执行必须有工作目录、超时、输出大小、环境变量 allowlist 和可终止进程。
- 对真实用户目录、系统目录、密钥文件和仓库外路径默认拒绝。
- 高风险执行优先放入独立沙箱进程/容器；不能直接把本机 shell 暴露给模型。

## 7. 扩展配方（Cookbook）

### 新增一个工具

**新框架（推荐）**——使用 Effect-TS `make()` + Schema：

```ts
// apps/agent/src/tool/tools/myTool/myTool.ts
import { Schema } from 'effect';
import { make } from '../../framework/definition.js';

const Input = Schema.Struct({ path: Schema.String, limit: Schema.optional(Schema.Number) });
const Output = Schema.Union(/* typed output variants */);

export const myTool = make({
  name: 'my_tool',
  description: '…',
  input: Input,
  output: Output,
  execute: async (input) => { /* raw logic */ },
  toModelOutput: (input, output) => [{ type: 'text', text: '…' }],
});
```

然后在 `apps/agent/src/tool/builtins.ts` 中注册，让统一工具框架暴露给 Pi AgentHarness。

### 新增一个 LLM Provider

主 Agent loop 固定使用 `@earendil-works/pi-agent-core`。新增模型或 Provider 时，优先扩展
`apps/agent/src/llm/pi-provider.ts` 的 Pi model/provider 映射，并继续复用 `AUREVOY_LLM_*`
配置入口；不要恢复旧 `LLMProvider` / ReAct stream 抽象。

### 改一个跨进程类型
1. 改 `packages/shared/src/index.ts`。
2. `npm run build:shared`。
3. 前后端按编译错误同步更新。

### 回归测试

```bash
npm run build                 # 构建 shared → agent → desktop
npm run regression:m3         # 基础 Agent、安全、审批、取消
npm run regression:m4         # 多轮、记忆、恢复
npm run regression:m5         # 设置、工具管理、数据管理、MCP
npm run regression:m6         # 追问、产物、预算、token、命令执行
npm run regression:m7         # 文件工具、网络安全、schema、计划、checkpoint
```

各回归覆盖范围：

- **m3**：直接回答、读文件、写文件审批、HTTP 审批、MCP 工具、取消、目录穿越、symlink 越界、审批拒绝/超时、非法 URL、未配置 Key、迟到 SSE、历史轨迹回看。
- **m4**：多轮上下文、上下文压缩、长期记忆 CRUD、Agent 写入记忆、记忆注入/禁用、启动期中断任务恢复扫描。
- **m5**：运行设置生效、Provider 缓存失效、工作区切换、工具启停影响模型可见工具、MCP 配置校验/状态、数据清理。
- **m6**：`ask_user` 追问与恢复、追问超时、artifact 草稿/确认/拒绝、预算超限、token usage、`execute_command` 审批后执行、cwd 越界拒绝。
- **m7**：文件搜索/复制/移动/删除、删除默认禁用与审批、`web_fetch` SSRF/重定向/HTML 正文提取、工具 schema validation、MCP 描述净化、本地风险覆盖、多步计划、checkpoint 恢复。

## 8. 提交前检查清单

- [ ] `npm run typecheck` 通过
- [ ] 改了 shared → 已 `npm run build:shared`
- [ ] 改了后端 → 跑过冒烟（health / 建任务 / SSE）
- [ ] 改了前端 → `npm run build -w @aurevoy/desktop` 通过
- [ ] 改了 Agent loop / 工具 / 审批 / 存储 → 有可复现的轨迹或回归用例
- [ ] 改了 Agent runtime / 工具 / 审批 / 安全边界 → `npm run regression:m3` 通过
- [ ] 改了记忆 / 多轮对话 / 恢复 → `npm run regression:m4` 通过
- [ ] 改了设置 / 工具管理 / MCP / 数据管理 → `npm run regression:m5` 通过
- [ ] 改了追问 / 产物 / 预算 / token / 命令执行 → `npm run regression:m6` 通过
- [ ] 改了文件工具 / HTTP 安全 / schema / MCP / checkpoint → `npm run regression:m7` 通过
- [ ] 新增工具 → 已声明风险等级、审批行为、错误路径和输入 schema
- [ ] 新增执行能力 → 已定义沙箱/权限边界、超时、输出上限和取消路径
- [ ] 无硬编码秘钥；无平台专有路径/命令
- [ ] 临时文件已清理

## 9. Git 约定

- 提交信息建议 Conventional Commits：`feat: …` / `fix: …` / `docs: …` / `refactor: …`。
- 只在用户明确要求时创建提交；优先暂存具体文件而非 `git add .`。
- `.env`、`*.sqlite`、`dist/`、`target/` 已 gitignore，勿提交。
