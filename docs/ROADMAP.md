# 路线图 — ROADMAP

> Aurevoy 唯一路线图。
> 完成标准：**真实链路跑通、失败路径明确、状态可恢复、用户可理解、验证可复现**。

## 阶段总览

| 阶段 | 主题 | 状态 |
|------|------|------|
| M0 | 产品底座与全链路通信 | ✅ |
| M1 | 真实 LLM 与单 Agent 工具循环 | ✅ |
| M2 | 工具能力、审批闭环与 MCP | ✅ |
| M3 | 工程治理：状态机、轨迹、评测、沙箱 | ✅ |
| M4 | 记忆、多轮对话与任务恢复 | ✅ |
| M5 | 设置、分发与跨平台 | 🚧 |
| M6 | 产物、追问、预算与 token | ✅ |
| M7 | 工具扩展、安全加固、多步计划、UI 拆分 | ✅ |
| Rewind | 编辑重跑 / 撤销 / 分支 / 压缩 | ✅ |
| Project | 项目工作区与对话分组 | ✅ |
| P1-P7 | Agent 架构重构（以 Claude Code 为蓝本） | ✅ |
| Skill | 技能系统（斜杠命令、工具白名单、预装 skill） | ✅ |
| WebSearch | 网页搜索工具与 web-search 预装 skill | ✅ |
| CI/CD | GitHub Actions 跨平台自动构建 | ✅ |
| Multimodal | 多模态图片/文件拖拽粘贴、视觉模型、图片查看器 | ✅ |
| M8 | 知识库、评测、浏览器与发布体验 | 🚧 |

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

## 已完成阶段

### M0 — 产品底座

npm workspaces monorepo（desktop / agent / shared）；前后端 HTTP + SSE 通信；
共享类型契约 `@aurevoy/shared`；Agent 引擎 Fastify + 事件总线 + 工具注册表 + SQLite；
前端 Tauri + React。

### M1 — 真实 LLM 与单 Agent 工具循环

OpenAI 兼容 Provider（OpenAI/DeepSeek/Ollama）；ReAct 工具调用循环；
流式 tool_calls 累积器；指数退避重试；防死循环（指纹去重 + 上限）；
`AbortController` 取消贯穿全链路。

### M2 — 工具能力、审批闭环与 MCP

内置基础工具（文件读写、目录列举、HTTP 抓取）；工作区路径 + symlink 校验；
三级风险模型（safe/caution/dangerous）；审批门（`approval_request` → 等待决策 →
执行/拒绝）；MCP stdio 工具发现与注册。

### M3 — 工程治理

显式 runtime phase（initializing/planning/thinking/calling_tool/waiting_approval/
waiting_clarification/finalizing/failed/cancelled）；SQLite 轨迹日志（LLM 轮次、
tool_call、tool_result、approval、error、done）；评测回归套件（M3-M7）；
沙箱边界（命令执行默认关闭，execFile 非 shell）。

### M4 — 记忆、多轮对话与任务恢复

多轮对话（`POST /api/tasks/:id/messages`）；短期记忆（上下文窗口压缩）；
长期记忆（SQLite `memories` 表，CRUD + 启停 + 来源追溯）；
任务恢复（启动期扫描遗留任务 → 可解释失败 → 显式 resume）。

### M6 — 产物、追问、预算与 Token

- **结构化追问**：`ask_user` 工具 → 暂停任务 → 等待回复/超时/取消 → 回灌结果
- **任务产物**：`create_artifact`（draft）→ 预览 → 确认 → `apply_artifact`（写入）
- **执行预算**：`maxIterations`/`maxToolCalls`/`maxWallTimeMs`/`maxOutputBytes`
- **Token 用量**：OpenAI-compatible usage 归一化，不支持的 Provider 明确为空
- **命令执行**：`execute_command`（`spawn` + `shell:false`），默认禁用

已知边界：artifact content 直接保存在任务 JSON 中（适合文本草稿）；`apply_artifact`
覆盖前只有文本预览和审批；`execute_command` 是基础进程执行边界，不是完整容器沙箱。

### M7 — 工具扩展、安全加固、多步计划、UI 拆分

- **文件工具**：`search_files`（glob + 内容搜索）、`copy_file`、`move_file`/`rename_file`、
  `delete_file`（→ `.aurevoy-trash`，默认禁用）；`read_file` 增强（大文件截断 + 编码诊断）
- **网络安全**：`http_fetch` SSRF 防护（拒绝内网/私有地址、DNS 校验）、最多 3 次重定向、
  HTML 清洗（去 script/style/iframe）、二进制只返回元信息
- **工具治理**：运行时 schema validation；MCP 描述截断 + prompt injection 检测；
  本地 riskLevel 覆盖 MCP annotations
- **多步计划**：LLM 驱动规划（侦查→结构化 JSON 计划），正则兜底；
  步骤完成创建 `checkpoint_created` 事件
- **前端工作台**：`App.tsx` 拆分 hooks；Markdown 渲染；`PlanCard`/`ClarificationCard`/
  `ArtifactCard`/`BudgetBar`；侧栏搜索 + 筛选

已知边界：`delete_file` 使用工作区 `.aurevoy-trash` 而非系统回收站；`search_files`
是确定性搜索，不做语义索引；`http_fetch` 是轻量 HTML 清洗，不等同浏览器 DOM 解析。

### Rewind / Edit & Regenerate

三阶段完成：

- **Phase 1**：revert 截断（soft-delete 归档到 `archivedMessages`）→ Composer 回填 → 重新生成
- **Phase 2**：多模式（`code_and_conv` / `conv_only`）+ unrevert 撤销编辑
- **Phase 3**：会话分支（branch，ID 重映射，独立演进）+ 上下文压缩（compact，LLM 摘要）

P6 增强：`code_and_conv` 模式从文件快照回滚被截断消息关联的文件写入。

### Project — 项目工作区与对话分组

导入文件夹作为项目；对话归属项目；per-task workspace 隔离；
项目 CRUD API；Tauri 文件夹选择器；记忆管理移入设置页；
Composer 项目上下文显示与新对话项目继承。

### Agent 架构重构 P1-P7

以 Claude Code 的 Agent 架构为蓝本，从"单层 ReAct 循环 + 正则计划 + 串行工具 + 字符截断"
推进到"LLM 驱动规划 → 分层执行 → 工具并行 → 语义压缩 → 相关性检索"的现代 Agent。

- **P1 侦查 + LLM 规划**：`runScoutPhase`（最多 3 轮，仅 safe 只读工具）产出 `ScoutReport`；
  `generatePlanViaLLM` 生成结构化 JSON 计划（2-8 步）；LLM 失败回退正则启发式。
- **P2 并行工具执行**：6 步管线（预校验→批量事件→ask_user 隔离→分区→并行执行→顺序回填）；
  safe 工具 `Promise.all` 并行；risky 工具各自独立审批后并行执行。
- **P3 工具结果截断**：`truncateToolOutput()` 在 `registry.invoke()` 层统一截断。
- **P4 Token 感知 + 自动语义压缩**：`estimateTokens()` 轻量估算；`autoCompactIfNeeded()`
  超阈值时 LLM 语义摘要旧消息；替代旧的字符预算。
- **P5 Memory 相关性评分 + `[[link]]` 引用 + 去重**：关键词/分类/置信度/时间衰减加权评分；
  `[[name-slug]]` 解析拉入被引用记忆；Jaccard 相似度自动去重；top-20 注入上下文。
- **P6 Diff 编辑 + 文件快照 + 回退策略**：`edit_file` 精确替换（唯一匹配校验）；
  写入类工具自动捕获快照；工具失败时 `fallbackFor` 附加替代建议。
- **P7 子代理委托**：`delegate_task` 委托受限子代理（仅 safe 只读、max 5 轮、60s 超时、
  不写 memory、结果 20KB 截断）；支持并行子代理。

### Skill — 技能系统

斜杠命令激活；预装 skill（web-search / browser）；工具白名单控制；
Agent Skills 标准接口。

### WebSearch — 网页搜索

`web_search` 工具（DuckDuckGo，可配置搜索后端）；`web-search` 预装 skill。

### CI/CD — 跨平台自动构建

GitHub Actions macOS + Windows + Linux 多平台 typecheck；tag 触发 DMG 构建。

### Multimodal — 多模态

图片/文件拖拽粘贴（Finder → Composer）；图片 base64 编码注入视觉模型；
用户可配置 vision sub-model；per-tool auto-approve；审批 UX 重设计（once/session/reject）。

---

## M5 — 设置、分发与跨平台 🚧

已完成：

- 设置界面（Provider/Base URL/Model/API Key/工作区/工具开关/MCP servers）
- 设置变更实时影响运行配置
- 模型列表管理（手动获取 + 勾选启用）
- 工具管理（启停 + MCP 连接状态）
- 数据管理（清理策略）
- 引擎子进程托管（Tauri sidecar）
- 跨平台 CI（macOS + Windows + Linux）
- macOS 红绿灯与窗口一体化整合
- i18n（英文默认 + 中文/日文/韩文）

待完成：

- [ ] macOS 打包、签名、公证、自动更新（需 Apple Developer 账号）
- [ ] Windows 适配（WebView2、原生模块、路径权限）

---

## M8 — 知识库、评测、浏览器与发布体验 🚧

> 浏览器自动化已通过 browser 预装 skill + Playwright MCP 提供基础能力。
> 网页搜索已通过 web_search 工具 + web-search 预装 skill 落地。

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
