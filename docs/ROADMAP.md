# 路线图 — ROADMAP

> 本路线图以“交付可用”为目标。完成一项能力的标准不是 UI 上有入口，
> 也不是代码里留了字段，而是**真实链路跑通、失败路径明确、状态可恢复、用户可理解、验证可复现**。

## 阶段总览

| 阶段 | 主题 | 状态 |
|---|---|---|
| M0 | 产品底座与全链路通信 | ✅ 完成 |
| M1 | 真实 LLM 与单 Agent 工具循环 | ✅ 完成 |
| M2 | 工具能力、审批闭环与 MCP | ✅ 完成 |
| M3 | 工程治理：状态机、轨迹、评测、沙箱边界 | ✅ 完成 |
| M4 | 记忆、多轮对话与任务恢复 | ⏳ 当前重点 |
| M5 | 设置、分发、Windows 与交付质量 | ⏳ 待启动 |

---

## M0 — 产品底座（✅ 已完成）

- [x] npm workspaces monorepo（desktop / agent / shared）
- [x] 前后端通信：HTTP + SSE，引擎监听 127.0.0.1:8787
- [x] 共享类型契约 `@aurevoy/shared`
- [x] Agent 引擎：Fastify + 事件总线 + 工具注册表 + SQLite
- [x] 前端：Tauri + React，任务输入、流式输出、对话历史
- [x] 全链路验证：typecheck、后端冒烟、前端构建、Tauri `cargo check`

交付要求：
- 不再引入 Mock LLM 或固定回复。未配置真实 Provider 必须明确失败。
- 前端展示的状态必须来自后端任务和事件流，不做假进度。

## M1 — 真实 LLM 与单 Agent 工具循环（✅ 已完成）

- [x] 接入真实 LLM Provider（OpenAI 兼容，覆盖 OpenAI/DeepSeek/Ollama 等）；未配置 Key 明确报错
- [x] ReAct 工具调用循环：模型自主决定调用工具或输出最终答案
- [x] 流式 tool_calls 累积器：按 `index` 跨 chunk 拼接，处理并行/截断
- [x] `LLMProvider` 支持 tools/toolChoice/signal
- [x] OpenAI-compatible streaming：支持工具调用、`reasoning_content` 透传、单轮超时
- [x] 指数退避重试；AbortError/4xx 不重试
- [x] 防死循环：同工具+同参数重复调用限制、单轮工具调用上限、最大轮次
- [x] 取消：`AbortController` 贯穿 fetch
- [x] Ollama 降级：带 tools 时关闭 streaming；模型不支持 tools 时直接问答
- [x] 前端展示 `tool_call` / `tool_result`

未完的交付强化：
- [ ] 自动化覆盖：并行工具、Ollama 降级、工具失败后自我修正、最大轮次兜底
- [ ] Provider 运行时配置与 Key 管理进入真实设置界面

## M2 — 工具能力、审批闭环与 MCP（✅ 已完成）

- [x] 内置基础工具：文件读写、目录列举、HTTP 抓取
- [x] 文件类工具限定 `config.workspaceDir`，并校验 symlink 真实路径
- [x] 工具风险模型：`safe | caution | dangerous`
- [x] 非 safe 工具执行前发 `approval_request`，等待 `POST /api/tasks/:id/approvals`
- [x] 审批超时、拒绝、取消都进入明确工具结果
- [x] 前端审批按钮和工具调用可视化
- [x] MCP TypeScript SDK：启动期连接 stdio MCP servers，发现 tools 并注册进 `toolRegistry`

交付要求：
- 新工具必须声明风险等级和输入 JSON Schema。
- 不允许绕过 `toolRegistry` 在 Agent loop 内直接执行工具逻辑。
- 新 MCP transport 支持前，必须说明连接失败、重连和权限策略。

## M3 — 工程治理（✅ 已完成）

目标：把 Agent runtime 从“能执行”推进到“可诊断、可恢复、可评测、可安全控制”。

### M3.1 显式状态机

- [x] 将 `runTask()` 的隐式流程整理为显式阶段：initializing / thinking / calling_tool / waiting_approval / finalizing / failed / cancelled
- [x] 在 `packages/shared` 中补充 `TaskPhase`、`Task.phase` 和 `phase` 事件，避免前后端各自猜状态
- [x] `pause` / `resume` 不作为 UI 文案先行；当前只暴露真实的 cancel 与 approval 能力

### M3.2 轨迹日志与审计

- [x] SQLite 增加任务轨迹记录：LLM 轮次、tool_call、tool_result、approval、error、done
- [x] 每条轨迹记录 `taskId`、时间、阶段、耗时、成功/失败、错误分类
- [x] 运行详情抽屉从事件流升级为可回看的轨迹视图
- [x] Provider 支持时记录 token 用量和估算成本；不支持时明确为空

### M3.3 评测与回归

- [x] 增加最小 Agent 回归集：直接回答、读文件、写文件审批、HTTP 审批、MCP 工具发现、取消
- [x] 增加安全回归：目录穿越、symlink 越界、审批拒绝、审批超时、非法 URL、未配置 Key
- [x] 增加状态恢复回归：迟到 SSE 订阅、历史回看、失败任务回看
- [x] 将回归命令写入 `CONVENTIONS.md` 和提交前检查清单

### M3.4 沙箱边界

- [x] 在加入 shell/代码执行前，先定义命令执行器接口、权限模型、超时、输出上限和环境变量 allowlist
- [x] 高风险执行默认关闭，必须通过设置显式启用
- [x] 命令执行优先使用隔离进程/容器，不直接暴露本机 shell

完成标准：
- 任意任务失败后，用户能看到原因；开发者能从轨迹定位到模型、工具、审批或配置层。
- 任意高风险工具都有可审计的审批记录。
- 行为改动能用固定用例回归，不靠手感判断。

## M4 — 记忆、多轮对话与任务恢复（⏳ 待启动）

目标：让 Aurevoy 能持续理解用户和任务上下文，但保持用户可控和来源可解释。

- [x] 多轮对话：同一任务内继续追问/补充，后端真实保留上下文
      （`POST /api/tasks/:id/messages` 追加 user 轮次后带完整历史重跑循环；
      前端改为以 `task.messages` 为真源的多轮线程渲染，运行中走实时流式尾巴）
- [x] 会话级短期记忆：当前任务内的文件、工具结果、用户约束和中间结论
      （`agent/context.ts` 确定性上下文窗口：用户约束与最近窗口逐字保留，
      超预算时就地压缩旧 assistant/tool 内容为摘要，不破坏 tool 配对契约；
      压缩留可审计轨迹。预算见 `AUREVOY_CONTEXT_CHAR_BUDGET` 等）
- [x] 长期记忆：用户偏好、常用目录、模型偏好、工作习惯
      （SQLite `memories` 表 + `memoryStore`；启用的记忆作为 system 消息注入每轮上下文）
- [x] 记忆 CRUD：查看、编辑、删除、禁用；不能只写入不可见黑盒
      （`/api/memories` CRUD + 前端记忆面板;禁用即不注入但仍可见可恢复）
- [x] 记忆来源：每条长期记忆记录来源任务、时间和置信度
      （`MemorySource{origin,taskId,taskGoal,createdAt}` + `confidence`；
      agent 经 `remember` 内置工具写入并自动记录来源任务，留工具轨迹可审计）
- [ ] 向量检索：评估 sqlite-vec / LanceDB，仅在需要语义召回时引入
- [ ] 任务恢复：进程重启后能恢复未完成/失败任务的可解释状态

完成标准：
- 用户能知道 Aurevoy 记住了什么、为什么记住、如何删除。
- 多轮不是简单拼接历史消息，而是有上下文压缩、来源和边界。

## M5 — 设置、分发、Windows 与交付质量（⏳ 待启动）

目标：把本地开发应用推进到普通用户可安装、可配置、可维护。

- [ ] 设置界面：Provider、Base URL、Model、API Key、工作区目录、工具开关、MCP servers
- [ ] 设置变更必须影响真实运行配置；不能只做静态表单
- [ ] 工具管理：查看工具、风险等级、启用/禁用、MCP 连接状态
- [ ] 数据管理：任务历史、轨迹日志、记忆、SQLite 文件位置、清理策略
- [ ] macOS 打包、签名、自动更新
- [ ] 引擎随桌面应用启动的进程管理（sidecar 或子进程托管）
- [ ] Windows 适配：WebView2、原生模块重编、路径与权限
- [ ] 跨平台 CI：macOS + Windows build/typecheck/冒烟

完成标准：
- 用户无需命令行即可配置 Provider 和工作区。
- 应用启动、停止、升级和崩溃恢复路径明确。
- 发布包不包含密钥、临时数据或开发数据库。

---

## 取任务原则

1. 一次只推进一个有边界的小目标，完成即按 `CONVENTIONS.md` 和 `ENGINEERING_GOVERNANCE.md` 验证。
2. 所有功能必须真实接入后端链路；禁止用 Mock、占位 UI 或静态配置假装完成。
3. 动 LLM/工具/存储/审批/任务状态时，保持抽象接口清晰，新增实现而不是把特例塞进循环。
4. 接口/类型有变动，先改 `packages/shared`，再联动 agent 与 desktop。
5. 多 Agent、后训练、复杂推理框架不是近期目标；先把单 Agent 的治理、记忆和恢复做扎实。
