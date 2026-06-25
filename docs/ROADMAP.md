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
| Skill Evolution | Git 安装 skill + load_skill 工具加载 | ✅ |
| Python Runtime | 内置 python-build-standalone 运行时 | ✅ |
| Line-oriented File Tools | open_file/scroll/search_grep/replace_lines/create_file/append_file | ✅ |
| Timeline Format | planStepId 关联的 timeline 分组渲染 | ✅ |
| ThinkingCard | 替 ReasoningBlock，干净的思考过程卡片 | ✅ |
| Approval 3-way Partition | safe/approved-sequential/needs-approval 三分区 | ✅ |
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
npm workspaces monorepo；HTTP + SSE 通信；`@aurevoy/shared` 类型契约；Fastify + 事件总线 + 工具注册表 + SQLite；Tauri + React。

### M1 — 真实 LLM 与单 Agent 工具循环
OpenAI 兼容 Provider + ReAct 循环 + 流式 tool_calls + 指数退避重试 + 防死循环 + AbortController 取消贯穿。

### M2 — 工具能力、审批闭环与 MCP
内置基础工具 + 路径/symlink 校验 + 三级风险模型 + 审批门 + MCP stdio 发现与注册。

### M3 — 工程治理
显式 runtime phase + SQLite 轨迹日志 + M3-M7 回归套件 + 沙箱边界（execFile 非 shell）。

### M4 — 记忆、多轮对话与任务恢复
多轮对话 + 短期记忆(上下文压缩) + 长期记忆(SQLite memories, CRUD+启停) + 任务恢复(扫描遗留→显式 resume)。

### M6 — 产物、追问、预算与 Token
`ask_user`(追问) + `create_artifact`/`apply_artifact`(产物) + 执行预算(`maxIterations`/`maxWallTimeMs`) + Token 用量 + `execute_command`(spawn, shell:false, 默认禁用)。

### M7 — 工具扩展、安全加固、多步计划、UI 拆分
文件工具(`search_files`/`copy_file`/`move_file`/`delete_file` + 行级工具集 `open_file`/`scroll`/`search_grep`/`create_file`/`replace_lines`/`append_file`) +
网络安全(`http_fetch` SSRF 防护 + HTML 清洗) + 工具治理(schema validation + MCP 注入检测) +
多步计划(LLM 驱动 + checkpoint) + 前端工作台(PlanCard/ClarificationCard/ArtifactCard/BudgetBar)。

### Rewind / Edit & Regenerate
revert 截断 + 多模式(code_and_conv/conv_only) + 会话分支(branch) + 上下文压缩(compact, LLM 摘要) + 文件快照回滚。

### Project — 项目工作区与对话分组
导入文件夹作为项目 + 对话归属 + per-task workspace 隔离 + CRUD API + Tauri 文件夹选择器。

### Agent 架构重构 P1-P7
P1 侦查+LLM 规划 → P2 3 区并行执行 → P3 工具结果截断 → P4 Token 感知+语义压缩 → P5 Memory 评分+引用 → P6 Diff 编辑+文件快照 → P7 子代理委托。

### Skill — 技能系统
斜杠命令激活 → `load_skill` 工具加载 + `install_skill` 从 Git 安装。

### WebSearch — 网页搜索
`web_search` 工具(DuckDuckGo) + `web-search` 预装 skill。

### CI/CD — 跨平台自动构建
GitHub Actions 多平台(macOS/Windows/Linux) typecheck + tag 触发 DMG 构建。

### Multimodal — 多模态
图片/文件拖拽粘贴 + base64 注入视觉模型 + 可配置 vision sub-model + per-tool auto-approve。

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

### M8.1 知识库与 RAG ✅

已引入 `sqlite-vec` 向量扩展 + 混合评分（关键词+向量），支持记忆语义检索和知识库文件索引。

- [x] 评估并引入 `sqlite-vec`（已验证 better-sqlite3 兼容性、KNN 性能）
- [x] Embedding Provider 工厂（Ollama 本地 / OpenAI 远程 / @xenova 进程内降级）
- [x] 记忆向量化：`memory_vec` 表 + 混合评分（`α·keyword + (1-α)·vector`）
- [x] 知识库设置入口（`/api/knowledge-base/dirs` CRUD）
- [x] 索引状态表（`kb_dirs`/`kb_files`/`kb_chunks` + 变更检测）
- [x] `index_files` + `recall` 工具（增量索引 + KNN 语义召回）
- [x] 前端展示来源（MemoryPanel 向量化徽章、KB 结果文件路径+片段）
- [x] 禁用/删除知识库时索引自动清理（级联删除）
- [ ] 后端自动隐式 recall（Agent 自动对目标做 KB 检索注入上下文）
- [ ] 前端 KB 设置面板 UI（当前仅 API 可用）

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
