# 路线图 — ROADMAP

> Aurevoy 唯一的主路线图。覆盖工程底座（M0-M5）、Agent 交付能力（M6-M8）、
> 编辑重跑（Rewind）、项目支持（Project）和 Agent 架构重构（P1-P7）。
>
> 完成标准：**真实链路跑通、失败路径明确、状态可恢复、用户可理解、验证可复现**。

## 阶段总览

| 阶段 | 主题 | 状态 |
|------|------|------|
| M0 | 产品底座与全链路通信 | ✅ |
| M1 | 真实 LLM 与单 Agent 工具循环 | ✅ |
| M2 | 工具能力、审批闭环与 MCP | ✅ |
| M3 | 工程治理：状态机、轨迹、评测、沙箱 | ✅ |
| M4 | 记忆、多轮对话与任务恢复 | ✅ |
| M5 | 设置、分发、Windows 与交付质量 | 🚧 |
| M6 | 产物、追问、预算与 token | ✅ |
| M7 | 工具扩展、安全加固、多步计划、UI 拆分 | ✅ |
| Rewind | 编辑重跑 / 撤销 / 分支 / 压缩 | ✅ |
| Project | 项目工作区与对话分组 | ✅ |
| P1-P7 | Agent 架构重构（以 Claude Code 为蓝本） | ✅ |
| M8 | 知识库、评测、浏览器与发布体验 | ⬜ |

## 验证口径

```bash
npm run typecheck
npm run build
npm run regression:m3   # 基础 Agent、安全、审批、取消
npm run regression:m4   # 多轮、记忆、恢复
npm run regression:m5   # 设置、工具管理、数据管理、MCP
npm run regression:m6   # 追问、产物、预算、token、命令执行
npm run regression:m7   # 文件工具、网络安全、schema、计划、checkpoint
```

---

## M0 — 产品底座 ✅

npm workspaces monorepo（desktop / agent / shared）；前后端 HTTP + SSE 通信；
共享类型契约 `@aurevoy/shared`；Agent 引擎 Fastify + 事件总线 + 工具注册表 + SQLite；
前端 Tauri + React。

---

## M1 — 真实 LLM 与单 Agent 工具循环 ✅

OpenAI 兼容 Provider（OpenAI/DeepSeek/Ollama）；ReAct 工具调用循环；
流式 tool_calls 累积器；指数退避重试；防死循环（指纹去重 + 上限）；
`AbortController` 取消贯穿全链路。

---

## M2 — 工具能力、审批闭环与 MCP ✅

内置基础工具（文件读写、目录列举、HTTP 抓取）；工作区路径 + symlink 校验；
三级风险模型（safe/caution/dangerous）；审批门（`approval_request` → 等待决策 →
执行/拒绝）；MCP stdio 工具发现与注册。

---

## M3 — 工程治理 ✅

显式 runtime phase（initializing/planning/thinking/calling_tool/waiting_approval/
waiting_clarification/finalizing/failed/cancelled）；SQLite 轨迹日志（LLM 轮次、
tool_call、tool_result、approval、error、done）；评测回归套件（M3-M7）；
沙箱边界（命令执行默认关闭，execFile 非 shell）。

---

## M4 — 记忆、多轮对话与任务恢复 ✅

多轮对话（`POST /api/tasks/:id/messages`）；短期记忆（上下文窗口压缩）；
长期记忆（SQLite `memories` 表，CRUD + 启停 + 来源追溯）；
任务恢复（启动期扫描遗留任务 → 可解释失败 → 显式 resume）。

---

## M5 — 设置、分发、Windows 🚧

- [x] 设置界面（Provider/Base URL/Model/API Key/工作区/工具开关/MCP servers）
- [x] 设置变更实时影响运行配置
- [x] 模型列表管理（手动获取 + 勾选启用）
- [x] 桌面 UI 密度与设置页统一
- [x] 工具管理（启停 + MCP 连接状态）
- [x] 数据管理（清理策略）
- [x] 引擎子进程托管（Tauri sidecar）
- [x] 跨平台 CI（macOS + Windows + Linux）
- [ ] macOS 打包、签名、自动更新
- [ ] Windows 适配（WebView2、原生模块、路径权限）

---

## M6 — 产物、追问、预算与 Token ✅

- **结构化追问**：`ask_user` 工具 → 暂停任务 → 等待回复/超时/取消 → 回灌结果
- **任务产物**：`create_artifact`（draft）→ 预览 → 确认 → `apply_artifact`（写入）
- **执行预算**：`maxIterations`/`maxToolCalls`/`maxWallTimeMs`/`maxOutputBytes`
- **Token 用量**：OpenAI-compatible usage 归一化，不支持的 Provider 明确为空
- **命令执行**：`execute_command`（`spawn` + `shell:false`），默认禁用

---

## M7 — 工具扩展、安全加固、多步计划、UI 拆分 ✅

- **文件工具**：`search_files`（glob + 内容搜索）、`copy_file`、`move_file`/`rename_file`、
  `delete_file`（→ `.aurevoy-trash`，默认禁用）；`read_file` 增强（大文件截断 + 编码诊断）
- **网络安全**：`http_fetch` SSRF 防护（拒绝内网/私有地址、DNS 校验）、最多 3 次重定向、
  HTML 清洗（去 script/style/iframe）、二进制只返回元信息
- **工具治理**：运行时 schema validation；MCP 描述截断 + prompt injection 检测；
  本地 riskLevel 覆盖 MCP annotations
- **多步计划**：P1 升级为 LLM 驱动规划（侦查→结构化 JSON 计划），正则兜底；
  步骤完成创建 `checkpoint_created` 事件
- **前端工作台**：`App.tsx` 拆分 hooks；Markdown 渲染；`PlanCard`/`ClarificationCard`/
  `ArtifactCard`/`BudgetBar`；侧栏搜索 + 筛选

---

## Rewind / Edit & Regenerate ✅

三阶段完成：

- **Phase 1**：revert 截断（soft-delete 归档到 `archivedMessages`）→ Composer 回填 → 重新生成
- **Phase 2**：多模式（`code_and_conv` / `conv_only`）+ unrevert 撤销编辑
- **Phase 3**：会话分支（branch，ID 重映射，独立演进）+ 上下文压缩（compact，LLM 摘要）

P6 增强：`code_and_conv` 模式从文件快照回滚被截断消息关联的文件写入。

---

## Project — 项目支持 ✅

导入文件夹作为项目；对话归属项目；per-task workspace 隔离；
项目 CRUD API；Tauri 文件夹选择器；记忆管理移入设置页；
Composer 项目上下文显示与新对话项目继承。

---

## Agent 架构重构 P1-P7 ✅

> 以 Claude Code 的 Agent 架构为蓝本，对 Aurevoy 的 Agent 内核进行系统性重构。
> 目标：从"单层 ReAct 循环 + 正则计划 + 串行工具 + 字符截断"推进到
> "LLM 驱动规划 → 分层执行 → 工具并行 → 语义压缩 → 相关性检索"的现代 Agent。

### P1: LLM 驱动规划 + 侦查阶段

- **侦查阶段**（`runScoutPhase`）：最多 3 轮 LLM、仅 safe 只读工具（list_directory/read_file/search_files），
  产出 `ScoutReport`（关键文件、技术栈、约束）
- **LLM 规划**（`generatePlanViaLLM`）：基于侦查报告生成 JSON 结构化计划（2-8 步，
  含 `toolsExpected`/`dependsOn`/`verifiable`）
- **回退策略**：LLM 失败 → 正则启发式 `inferStructuredPlan` 兜底；
  `AUREVOY_LLM_PLANNING_ENABLED=false` 可完全关闭
- 新增 `scout_started`/`scout_report`/`plan_generated` SSE 事件

### P2: 并行工具执行

- **6 步执行管线**：预校验（指纹 + JSON + 风险）→ 批量发布事件 → ask_user 隔离 →
  分区（safe/risky）→ 并行执行 → 按原始顺序回填结果
- safe 工具：`Promise.all` 全并行，每个独立 `invokeWithTimeout`
- risky 工具：并发发送审批请求 → 各自独立等待 → 并行执行
- `ToolExecutionPolicy`：`parallelizable`（默认 true）+ `waitsFor` 依赖声明
- `AUREVOY_TOOL_TIMEOUT_MS`（默认 30s）：单个工具 hung 掉不影响同批次

### P3: 工具结果截断

- `truncateToolOutput()`：输出超过 `AUREVOY_TOOL_OUTPUT_MAX_CHARS`（默认 50K）时
  截断为 `{_truncated, _originalChars, _preview, _note}` 结构
- 在 `registry.invoke()` 层统一截断，所有工具调用受保护

### P4: Token 感知 + 自动语义压缩

- `estimateTokens()`：轻量 token 估算（CJK ~1.5 token/char，拉丁 ~0.25 token/char）
- `autoCompactIfNeeded()`：token 预算超 `AUREVOY_COMPACT_THRESHOLD`（默认 85%）时，
  LLM 语义摘要旧消息（跳过 user 约束 + 最近 N 轮 + tool 配对）
- `AUREVOY_CONTEXT_TOKEN_BUDGET`（默认 128K）替代旧的字符预算
- 在每轮 LLM 调用前自动触发

### P5: Memory 相关性评分 + `[[link]]` 引用 + 去重

- **相关性评分**（`scoreMemories`）：关键词命中 + 分类匹配加权 + 置信度加权 + 时间衰减（30 天半衰）
- **`[[link]]` 引用**：`parseMemoryLinks()` 解析内容中的 `[[name-slug]]`，
  `expandLinkedMemories()` 拉入被引用记忆（降权 score×0.5）
- **自动去重**：`remember` 工具写入前 Jaccard 相似度检测（>70% → 更新已有记忆）
- **增强字段**：`nameSlug`（URL slug）、`why`（为什么记录）、`howToApply`（何时使用）
- `buildMemorySystemMessage()` 按相关性评分排序注入 top-20

### P6: Diff 编辑 + 文件快照 + 回退策略

- **`edit_file`**：精确替换（`oldString` 唯一匹配校验，支持 `replaceAll`），
  比 `write_file` 更安全不丢文件其余部分
- **文件快照**：写入类工具执行前自动捕获 → Rewind `code_and_conv` 时从快照回滚文件
- **回退策略**：`ToolDescriptor.fallback`（推荐替代工具 + 建议消息）；
  工具失败时 `fallbackFor()` 附加到 tool result 给 LLM 参考

### P7: 子代理委托

- **`delegate_task`**：主 Agent 委托独立子任务给受限子代理（`subagent.ts`）
- 约束：仅 safe 只读工具、max 5 轮、60s 总超时、不写 memory、结果 20KB 截断
- 可同时发起多个 `delegate_task` 实现并行子代理（依附 P2 并行执行）

### 重构改动清单

| 文件 | 涉及 Phase |
|------|-----------|
| `packages/shared/src/index.ts` | P1-P7（`ScoutReport`/`GeneratedPlan`/`ToolExecutionPolicy`/`FileSnapshot`/`ToolDescriptor.fallback`/`MemoryEntry` 扩展/`Task.fileSnapshots` 等） |
| `apps/agent/src/config.ts` | P1-P4（`maxScoutRounds`/`llmPlanningEnabled`/`toolTimeoutMs`/`toolOutputMaxChars`/`contextTokenBudget`/`compactThreshold`/`compactKeepRecentTurns`） |
| `apps/agent/src/agent/loop.ts` | P1-P2, P4, P6（侦查→规划→并行执行→自动压缩→快照→fallback） |
| `apps/agent/src/agent/context.ts` | P4-P5（`estimateTokens`/`autoCompactIfNeeded`/`scoreMemories`/`parseMemoryLinks`/`expandLinkedMemories`） |
| `apps/agent/src/agent/subagent.ts` | P7（子代理执行引擎，新文件） |
| `apps/agent/src/tools/registry.ts` | P2-P3, P6（`invokeWithTimeout`/`executionPolicyOf`/`truncateToolOutput`/`fallbackFor`） |
| `apps/agent/src/tools/builtins.ts` | P5-P7（`edit_file`/`findDuplicateMemory`/Jaccard 去重/`delegate_task`） |
| `apps/agent/src/store/db.ts` | P5（`name_slug`/`why`/`how_to_apply` 列迁移 + `findByNameSlug`） |
| `apps/desktop/src/components/AgentEventFeed.tsx` | P1（`scout_started`/`scout_report`/`plan_generated` 事件渲染） |
| `scripts/m4-regression.mjs` | P1（`AUREVOY_LLM_PLANNING_ENABLED=false` 适配 LLM fixture） |

---

## M8 — 知识库、评测、浏览器与交付体验 ⬜

### M8.1 知识库与 RAG

短期不直接上向量库，先做文件搜索；满足触发条件后再引入语义召回。

- [ ] 知识库设置入口（明确哪些目录被索引）
- [ ] 索引状态表（文件路径、hash/mtime、chunk 数、索引时间）
- [ ] 评估并引入 `sqlite-vec`
- [ ] `index_files` + `recall` 工具
- [ ] 前端展示来源（文件、片段、更新时间、置信度）
- [ ] 禁用/删除知识库时索引必须可清理

### M8.2 Agent 评测

- [ ] `scripts/evals/` 目录 + 20+ 真实任务样例
- [ ] 规则评分器（工具正确性、参数正确性、越权、审批、产物生成）
- [ ] 可选 LLM Judge（仅质量评分，不用于安全门禁）
- [ ] `npm run eval:agent-usability`（30 分钟级，发布门槛）
- [ ] 安全合规率 100%；任务完成率 ≥ 70%

### M8.3 浏览器自动化

- [ ] Playwright MCP Server 接入
- [ ] 推荐 MCP 配置模板（不自动启用高风险浏览器动作）
- [ ] 截图、DOM 摘要、控制台错误进入 artifact

### M8.4 发布体验

- [ ] macOS 打包、签名、公证、自动更新
- [ ] Windows WebView2、原生模块重编、路径权限验证
- [ ] 首次启动向导（Provider/Key/工作区/数据目录/工具权限/MCP）
- [ ] 运行健康页（Provider 连通性、模型列表、MCP 状态、沙箱状态）
- [ ] 数据导出和清理

---

## 工程原则

1. 一次只推进一个有边界的小目标，完成即按 `CONVENTIONS.md` 验证。
2. 所有功能真实接入后端链路；禁止 Mock、占位 UI 或静态配置冒充完成。
3. 动 LLM/工具/存储/审批/任务状态时，保持抽象接口清晰。
4. 接口/类型变动 → 先改 `packages/shared` → 再联动 agent 与 desktop。
5. 多 Agent、后训练、复杂推理框架不是近期目标；先把单 Agent 做扎实。
6. **不做大重构**——现有 ReAct loop、ToolRegistry、SQLite、HTTP+SSE 继续作为主线。
