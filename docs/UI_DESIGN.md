# 人机交互与前端界面设计 — UI_DESIGN

> 本文描述 Aurevoy 的智能体产品形态、桌面端信息架构、核心交互流与前端落地边界。
> 目标是把 Aurevoy 做成一个**对话优先、克制留白的个人 Agent 桌面应用**：
> 用户像聊天一样表达目标，Agent 的计划、执行与透明度信息按需呈现，不喧宾夺主。
> 前端设计必须反映真实后端能力；不做静态入口、假进度、假设置或不可执行的控制按钮。

> **方向说明（2026-06 修订，2026-07 工作台修订）**：界面以**对话为主线**，左侧为历史与动作。
> 过程透明度（计划、工具调用）优先在对话流内联呈现。
> 右侧是**编码工作台**（可开关、可拖宽）：固定文件树 + 打开文档预览/产物，不是运行详情抽屉。

## 1. 设计目标

Aurevoy 以对话为主线组织界面：用户用自然语言描述目标，界面以对话流的方式呈现
"用户目标 → Agent 计划 → 执行 → 结果"，并在用户需要时才展开过程细节。

核心体验原则：

1. **对话优先**：首屏是一句友好的引导问句加一个大输入框，主视觉留给对话本身，
   不堆砌提示词技巧、模型参数或统计仪表盘。
2. **克制留白**：浅色为主、大量留白、单一中性强调色，弱化边框与卡片，降低视觉噪音。
3. **过程透明（按需）**：规划、步骤状态、工具调用在对话流内联呈现（可折叠）；
   不单独占一个「运行详情」常驻栏。
4. **用户可控**：提供新对话、停止、重试、审批等入口；所有控制必须调用真实 API 并反馈结果。
5. **本地可信**：在输入框页脚轻量展示本地引擎在线状态与运行模式。
6. **交付真实**：设置、工具、记忆、搜索等入口只有在接入真实能力后才标记为可用；
   未完成能力要隐藏、禁用或明确说明不可用，不能用静态界面冒充。

## 2. 产品形态

### 2.1 Aurevoy 是对话优先的个人 Agent

Agent 的核心职责仍是推动任务完成，但交互入口是对话。界面围绕一条对话主线组织，
过程信息按需展开：

1. 用户在大输入框里用自然语言描述目标。
2. Agent 创建任务并进入规划。
3. 对话流中以内联可折叠卡片展示计划步骤。
4. Agent 按步骤执行，必要时调用工具。
5. Agent 以流式文本在对话流中输出结果，并保存到对话历史。
6. 用户可在侧栏回看历史对话、重试，或开新对话继续。
7. 需要浏览工作区文件或任务产物时，从顶栏打开右侧编码工作台。

### 2.2 Agent 状态模型

界面应使用用户可理解的状态标签映射 `TaskStatus`：

| 契约状态 | 展示文案 | UI 含义 |
|---|---|---|
| `pending` | 等待中 | 任务已创建，等待执行事件 |
| `planning` | 正在规划 | Agent 正在理解目标和拆解计划 |
| `running` | 执行中 | Agent 正在生成输出或调用工具 |
| `paused` | 等待确认 | Agent 需要用户输入或权限确认 |
| `completed` | 已完成 | 任务成功结束 |
| `failed` | 失败 | 执行出错，需要重试或调整 |
| `cancelled` | 已取消 | 用户主动终止任务 |

`TaskStatus` 只表达生命周期大状态。运行中的细粒度解释必须使用后端发布并持久化的
`TaskPhase`，不能由前端根据文案猜测：

| 运行阶段 | 展示文案 | UI 含义 |
|---|---|---|
| `initializing` | 初始化 | 后端已接收任务，正在准备运行 |
| `thinking` | 模型思考 | 正在调用模型或等待模型输出 |
| `calling_tool` | 调用工具 | 正在执行工具调用 |
| `waiting_approval` | 等待确认 | 非 safe 工具等待用户审批 |
| `finalizing` | 整理结果 | 正在保存最终回复或收尾 |
| `failed` | 失败 | 已进入失败收尾 |
| `cancelled` | 已取消 | 已进入取消收尾 |

## 3. 信息架构

桌面端采用**两栏 + 可选编码工作台**结构：

```text
┌───────────────┬─────────────────────────────────┬──────────────────────────────┐
│ 左侧栏         │ 主区                              │ 右侧工作台（可开关 / 可拖宽）   │
│ 动作/对话历史   │ 空状态 hero / 对话流 + 输入框       │ 打开文档预览 | 固定文件树       │
└───────────────┴─────────────────────────────────┴──────────────────────────────┘
                                              顶栏「文件工作台」按钮切换 ▲
```

### 3.1 左侧栏：动作与对话历史

极简浅灰侧栏，建立"可持续工作的个人 Agent"心智，避免装饰与统计卡片。

必须包含：

- 顶部动作组（带图标）：新对话、搜索、工具、记忆。未接入真实能力的动作必须禁用或隐藏。
- "对话"分区：对话历史列表，按更新时间倒序。
- 每条历史展示目标摘要（单行截断）与相对时间。
- 当前选中项有低对比度的高亮底色。
- 底部：设置入口。

窄窗口下侧栏可整体隐藏，主区单列显示。

### 3.2 主区：空状态与对话

主区有两种形态，根据是否有当前对话切换：

**空状态（hero，无当前对话）**

- 垂直居中的一句友好引导问句（如"我们应该在 Aurevoy 中构建什么？"）。
- 下方一个大圆角输入框（Composer）。

**对话状态（有当前对话）**

- 顶栏：当前任务状态标签、重试、停止、工作台开关按钮。
- 居中对话流（限制最大宽度，独立滚动）：
  - 用户目标气泡（右对齐）。
  - Agent 回复：内联可折叠的"执行计划"卡片 + 流式输出文本 + 状态标签。
  - 执行中显示思考态（动效）与流式光标。
- 底部停靠输入框，用于追加目标或开新一轮。

### 3.3 Composer：输入框

对话的主入口，hero 与 docked 两种形态共用一个组件。

必须包含：

- 大圆角输入框，占位文案引导用户随心输入。
- Enter 提交，Shift+Enter 换行。
- 底部工具条：附加、Provider，以及右侧的本地引擎在线状态与圆形发送按钮。
- 输入框页脚：项目（Aurevoy）、运行模式（本地模式）、**自动模式等级切换**等轻量上下文。
- 引擎离线或内容为空时禁用发送。
- Provider 未配置或后端返回 `unconfigured` 时，输入区必须明确提示需要配置模型，不能允许提交后再给假回复。
- Provider/模型入口是轻量 popover，不跳转设置页、不占用右侧工作台；仅在用户点击
  "管理模型列表" 时切换到设置页的"模型配置"。
- 模型 popover 按 Provider 分组展示各槽位勾选的 `enabledModels`，支持跨 provider 一键切换
  （同时激活对应 API Key / Base URL）；列表过长时内部滚动；点击空白处或按 Escape 关闭，
  不放额外的"关闭"按钮。

### 3.4 右侧编码工作台（可开关）

面向「Agent 改代码 / 读工作区 / 看产物」的场景，是可拖宽的网格列（不是遮罩抽屉）。
由顶栏按钮切换；设置/搜索/技能等全页视图下隐藏。

结构（**固定探索器 + 编辑区**，文件树不是页签）：

```text
┌──────────────────────────────┬─────────────┐
│ [file.ts] [readme.md] [×]    │ Workspace   │  ← 文件树在最右侧
│ Aurevoy › path/to/file.ts    │  文件树      │
├──────────────────────────────┤  …          │
│ 文本 / Markdown / 图片预览      │ Artifacts   │
│                              │  产物列表    │
└──────────────────────────────┴─────────────┘
```

必须包含：

- **工作区文件树**：`GET /api/workspace/read`，按当前 `projectId` / `taskId` 解析根目录；支持筛选、展开、刷新、右键（打开/复制/附件/重命名/删除）。
- **对话产物列表**：来自当前任务 `Task.artifacts`；点击后在编辑区打开内容（`GET /api/tasks/:id/artifacts/:id/content`）。
- **打开文档页签**：只表示已打开的 workspace 文件或 artifact；按 project（优先）或 task 作用域持久化，任务切换时丢弃跨任务 artifact 页签。
- **预览**：文本、JSON 格式化、Markdown 渲染、图片；目录不可预览。
- **不要**把文件树做成与文档平级的页签；**不要**再用 `inspector` 命名指代本面板。

## 4. 核心工作流

### 4.1 引擎探测

应用启动时并行请求：

- `GET /api/health`
- `GET /api/tasks`
- `GET /api/tools`

成功后：

- Composer 页脚显示本地引擎"在线"，发送按钮可用。
- 侧栏对话历史按更新时间倒序填充；应用启动停留在空状态 hero，由用户选择历史或开新对话。

失败后：

- Composer 页脚显示"引擎离线"。
- 发送按钮禁用。
- 抽屉内工具数与运行时长显示离线状态。

### 4.2 创建任务

用户提交目标时：

1. 前端调用 `POST /api/tasks { goal }`。
2. 立即清空上一任务的临时计划、输出和事件流。
3. 将返回的 `Task` 插入任务历史顶部。
4. 通过 `EventSource` 订阅 `/api/tasks/:id/stream`。
5. 按事件增量更新 UI。

### 4.3 事件消费

前端必须完整消费现有 `AgentEvent`：

| 事件 | 前端行为 |
|---|---|
| `task_created` | 设置当前任务，刷新历史与快照 |
| `status` | 更新状态标签 |
| `phase` | 更新运行阶段标签，并写入当前任务快照 |
| `plan` | 渲染完整计划 |
| `step_update` | 更新单个计划步骤 |
| `token` | 追加到结果区 |
| `message` | 合并消息，避免按 id 重复插入 |
| `tool_call` | 写入事件流与工具调用区；在对话流中以「调用工具：<name>」轻量卡片就地呈现 |
| `tool_result` | 写入事件流与工具调用区；更新对应 `tool_call` 卡片为结果（成功/失败） |
| `subagent_updated` | 按 `run.id` upsert 子代理运行快照，并按 `parentCallId` 归入触发委托的 assistant 轮次 |
| `approval_request` | 展示审批卡片；用户批准/拒绝后调用 `POST /api/tasks/:id/approvals` |
| `done` | 设置最终状态，关闭 EventSource，刷新历史 |
| `error` | 展示错误文案，停止忙碌态 |

> **Pi 工具调用循环的呈现约定**（详见 `docs/API.md` 事件序列）：
> - **隐式计划**：后端不强制先规划，而是用工具调用轨迹更新 `plan`/`step_update`。
>   前端的计划卡片应能接受"执行中 → 使用工具 X → 完成"这类动态步骤，不要假设计划在开头一次给全。
> - **工具轨迹**：一轮可能并行多个 `tool_call`（各带独立 `id`），需按 `id` 关联到对应 `tool_result`。
> - **思考内容**：assistant 的 `reasoningContent`（DeepSeek 思考模式）默认不在主对话区展示，
>   可在对话卡片内以可选折叠区呈现，避免干扰主回复。
> - **最简实现**：工具事件以对话流内联卡片呈现即满足「过程透明」；无需单独运行详情栏。

#### 子代理协作工作组

`delegate` 不作为普通工具步骤重复展示，而是在触发它的主 Agent 轮次内聚合成一个“协作工作组”：

- 同一轮并行发起的多个子代理展示为同组列表，每个运行独立显示角色、目标和状态。
- 默认层只展示用户可理解的信息：排队/执行/完成/失败、实时耗时、轮次和工具调用次数。
- 运行中和失败项默认展开；成功项完成后自动收起，用户仍可展开查看内部工具活动与返回摘要。
- 子代理的原始 token 不混入主对话正文；只显示 runtime 提供的结构化进度和最终返回结果。
- `Task.subagentRuns` 是历史回放真相源，通过 `parentCallId` 与 assistant 的 delegate tool call 关联。
- 刷新或迟到订阅时，`task_created.task.subagentRuns` 恢复完整工作组；实时更新使用 `subagent_updated`。
- 窄窗口隐藏次要统计列，但保留角色、目标、状态与展开能力。

### 4.4 SSE 快照回放

引擎执行很快，前端可能在订阅前错过早期事件。后端 SSE 端点应在新订阅建立后先补发数据库快照：

1. `task_created`
2. `status`
3. `phase`（如已有）
4. `plan`（如已有）
5. 已保存 `message`
6. 若任务已结束，补发 `done`

这样前端刷新、迟到订阅或历史回看时都能恢复任务状态。

### 4.5 用户控制

当前阶段前端提供：

- **重试**：用当前目标创建一个新任务。
- **恢复**：调用 `POST /api/tasks/:id/resume`，基于持久消息历史继续失败/取消/中断任务。
- **停止**：调用 `POST /api/tasks/:id/cancel`；只有接口返回后才更新取消/停止状态。
- **新对话**：清空当前对话状态，回到空状态 hero。
- **审批**：对 `approval_request` 调用 `POST /api/tasks/:id/approvals`，并展示投递是否成功。
- **设置**：作为主区页面切换展示，并隐藏左右栏；读取 `/api/settings`、`/api/tools`、
  `/api/mcp/status`、`/api/data`；保存 Provider、工作区、工具启停、MCP、模型列表和清理策略时
  必须调用后端接口，不能只改前端状态。
- **模型管理**：设置页可为多个 Provider 分别保存 Key/Base URL/模型列表；手动获取当前激活
  Provider 的模型后写入该槽位的 `availableModels`，用户勾选后写入 `enabledModels`。
  主界面模型菜单读取全部槽位的 `enabledModels`（`RuntimeSettings.llm.providers`），不会每次打开都请求后端。
- **自动模式**：Composer 切换 **auto | plan** 两档，实时生效并通过 `PATCH /api/settings` 持久化。
  （旧 4 级 off/auto-edit/full 已淘汰，启动时迁移为 auto。）
- **安全暂停恢复**：auto mode 连续自动批准达到阈值后自动暂停，UI 显示暂停横幅 +
  "恢复自动模式"按钮，调用 `POST /api/tasks/:id/auto-mode-resume`。
- **知识库管理**：设置 → 知识库子页面；添加/删除索引目录、查看索引状态、配置 Embedding Provider。
  目录添加调用 `POST /api/knowledge-base/dirs`，Embedding 可继承 LLM Base URL/API Key。

后续控制能力应按契约优先原则新增；没有后端真实行为前，不能在 UI 上提供可点击假入口：

- `POST /api/tasks/:id/pause`

对应请求/响应类型必须先定义在 `packages/shared/src/`。

### 4.6 编辑重跑与会话控制

用户可以对历史消息进行回溯、编辑、分支和压缩，所有操作基于后端真实能力，不做假入口。

**编辑重跑（Revert）**：
- 每条用户消息（`UserBubble`）旁有编辑按钮（铅笔图标）
- 点击后进入内联编辑模式，用户修改文本后点击确认
- 确认后出现模式选择面板：
  - **恢复对话 + 代码**（`code_and_conv`）：截断对话历史，清除 revert 点之后的 checkpoint、artifact 和 plan
  - **仅恢复对话**（`conv_only`）：仅截断对话，保留 checkpoint、artifact 和 plan
- 选择后调用 `POST /api/tasks/:id/revert`，Composer 回填被移除消息的原始内容
- 用户编辑后提交 → `POST /api/tasks/:id/messages` 以截断后的历史重新生成

**撤销编辑（Unrevert）**：
- revert 后、尚未提交新的 continue 时，turn-actions 区出现"撤销编辑"按钮
- 调用 `POST /api/tasks/:id/unrevert`，从 `archivedMessages` 恢复被截断的消息

**会话分支（Branch）**：
- 每条用户消息旁有分支按钮（fork 图标）
- 点击后调用 `POST /api/tasks/:id/branch`，创建新任务并自动切换
- 新任务独立演进，原任务不受影响（`parentTaskId` 指向父任务）

**上下文压缩（Compact）**：
- 当对话消息超过 4 条时，turn-actions 区出现"压缩上下文"按钮
- 调用 `POST /api/tasks/:id/compact`，将旧消息替换为 LLM 生成的摘要
- 压缩后对话继续，但上下文窗口空间得到释放

**Composer 编辑模式**：
- revert 后 Composer 进入编辑模式，边框高亮，顶部显示"编辑模式"横幅和取消按钮
- 提交时走 `continueGoal` 路径（而非创建新任务），保留截断后的上下文

## 5. 视觉系统

### 5.1 方向

视觉方向采用"克制留白"的现代桌面对话应用风格（参考 Claude / 现代 IDE 助手）：

- 浅色优先，深色跟随系统。
- 大量留白，弱化边框与分隔线，减少卡片堆叠。
- 中性色为主，单一深灰作为强调（发送按钮、头像、当前选中）。
- 绿色仅用于在线/完成状态，红色仅用于错误/失败/取消。
- 允许居中 hero 空状态与较大圆角的输入框，营造轻盈、友好的第一印象。

### 5.2 布局纪律

- 页面固定占满窗口高度。
- 侧栏、对话流、抽屉各自独立滚动。
- 对话流限制最大宽度（约 760px）并水平居中，避免长行难读。
- 流式输出在对话流内增长，配合自动滚动到底部。
- 输入框圆角约 16px，侧栏条目与卡片圆角约 8–12px。
- 文本必须在容器内截断或换行，不允许溢出覆盖邻近内容。
- 不堆砌无意义的统计指标（如"输出长度"），主区只承载对话。
- 全局密度由 CSS tokens 控制，基础字号约 14px，常规控件高度约 34-38px；侧栏、设置页、
  Composer、toast、工具卡和模型 popover 必须复用同一套字号、间距、圆角和控制高度 token。
- 用户可通过"外观 / 字体比例"调整 `--font-scale`；新增样式应优先走语义 token，
  不应在局部组件继续堆散落的裸字号和裸行高。
- 设置页边栏必须复用主界面的 `.sidebar`、`.sidebar-action`、`.sidebar-scroll` 容器样式，
  保持用户感知为同一套导航系统。

### 5.3 响应式

| 宽度 | 行为 |
|---|---|
| 常规窗口 | 显示左侧栏 + 主区；编码工作台可开关 |
| 窄窗口 | 左侧栏与工作台隐藏，主区单列显示 |

## 6. 前端组件边界

推荐组件拆分：

| 组件 | 职责 |
|---|---|---|
| `App` | 应用状态编排、健康检查、SSE 生命周期、对话历史、空状态/对话切换、抽屉开关 |
| `TaskHistorySidebar` | 左侧动作组、对话历史列表、新对话与抽屉入口 |
| `Composer` | 大输入框，hero 与 docked 两种形态，Enter 提交、Provider/引擎状态/发送 |
| `ModelSelectorDrawer` | Composer 模型 popover：只展示 `enabledModels`、支持空白/Escape 关闭和滚动 |
| `Conversation` | 居中对话流：用户目标气泡、内联计划卡片、流式输出、状态 |
| `Timeline` / `ThinkingTimeline` | 思考时间线卡片：planStepId 关联分组、流式更新、工具活动（tool_call/tool_result）、思考消息 |
| `WorkbenchPanel` | 右侧编码工作台：固定 FileTree（工作区+产物）+ 打开文档页签 + FileViewer |
| `FileTree` / `FileViewer` | 工作区浏览与文件/产物预览 |
| `useWorkbenchTabs` | 按 project/task 作用域管理打开的文档页签 |
| `StatusPill` | 任务状态标签 |
| `ContextMenu` | 自定义右键菜单：对话消息与文件树上的操作 |
| `ImageViewer` | 图片全屏 lightbox：ESC/✕/点击背景关闭 |
| `SettingsPanel` / `MemoryPanel` | 设置页与记忆管理面板 |

`App` 可以持有 UI 编排状态，但业务真相仍来自后端 `Task` 和 `AgentEvent`。

## 7. 多模态交互

Aurevoy 支持用户拖拽、粘贴或手动选择图片/文件，Agent 可读取内容、查看图片，
视觉模型可"看见"图片内容。

### 7.1 视觉模型配置

Aurevoy 使用**主模型 + 视觉子模型**架构：

- **主模型**（Settings → Provider → Model）：处理纯文本对话。
- **视觉子模型**（Settings → Provider → 视觉模型）：消息包含图片时自动切换。
- 视觉子模型留空时，图片以文字引用形式注入（`[用户附带了图片: xxx]`），
  纯文本模型无法"看到"图片像素内容。

### 7.2 Composer 附件

| 方式 | 操作 | 说明 |
|------|------|------|
| **从 Finder 拖入** | 拖文件/文件夹到输入框 | 文件夹导入为项目；文件作为附件 |
| **粘贴** | Cmd+V 在输入框 | 系统剪贴板中的图片自动提取 |
| **附件按钮** | 点击输入框左侧 + 按钮 | 清除当前附件 |

附件 chip 出现在输入框上方。输入文字描述后发送，Agent 会：

1. 读取文本文件内容（≤30KB），注入上下文；超大文件截断并提示 LLM 用 `read_file`。
2. 检测到图片 → 切换视觉子模型 → 以 base64 多模态格式发送。
3. 用户拖入的文件路径被标记为"受信任外部路径"，工具可跳过工作区沙箱检查直接读写。
4. 文件夹拖入 → 自动导入为项目。

### 7.3 图片展示

- 聊天历史中的图片显示缩略图（横排，点击可全屏查看）。
- 图片查看器：点击缩略图 → 全屏 lightbox → ESC/✕/点击背景关闭。
- 支持格式：PNG、JPG、GIF、WebP 等（取决于模型），单张最大 20MB。

### 7.4 审批系统

高风险工具（写文件、执行命令等）调用前需要用户确认。审批卡片内嵌在聊天界面内：

| 按钮 | 行为 | 有效期 |
|------|------|--------|
| **允许本次** | 仅本次调用通过 | — |
| **拒绝** | 拒绝本次调用 | — |

auto mode 是主要放行机制：`auto` 自动放行工具；`plan` 先确认计划，批准后执行期与 auto 相同；
审批卡片处理未被当前 mode 放行的单次调用。

### 7.5 Agent 主动文件输出

Agent 可以将生成的文件（如图表、报告、数据文件）作为消息附件主动推送到对话中。
前端通过 `content_blocks_added` SSE 事件接收文件对象，在对话流中以文件卡片（缩略图 +
文件名）内联展示，并**默认在右侧工作台打开预览**：Markdown 渲染、HTML 沙箱预览、图片预览等。
点击对话内文件卡也会在工作台打开。

Agent 还可通过 `present_ui` 推送**限定交互组件**（`ContentBlock.type === 'ui'`）：
白名单 kind（`data_table` / `stat_row` / `choice` / `calculator` / `stack`）+ schema 校验后
由前端 React 组件渲染；**禁止**在对话中执行模型生成的 JSX/HTML。同 `id` 再次 present
会走 `content_blocks_upserted` 原地更新。表格排序/筛选仅本地；`choice` 提交会作为用户消息续聊。
复杂版式报告仍走工作区 HTML / report-design + `attach_content`。

### 7.6 技术架构

```
[Composer 图片/文件] → [App attachment state]
  → POST /api/tasks { goal, attachments }
  → Agent createTask/addUserTurn 存储 Message.attachments

[Agent Loop runTask]
  ├── collectExternalPaths() → ToolContext.externalPaths → 工具沙箱放行
  ├── buildAttachmentSystemMessage() → 文本文件注入 system context
  └── Provider.stream(messages)
      ├── needsVision? → effectiveModel = visionModel
      ├── toOpenAIMessage(msg, includeImages)
      │   ├── includeImages=true → content: [{text}, {image_url: base64}]
      │   └── includeImages=false → content: "text\n[图片: xxx]"
      └── FETCH /chat/completions { model: effectiveModel, messages }
```

相关组件：

| 组件 | 职责 |
|------|------|
| `Composer` | 拖拽/粘贴处理、附件 chip、缩略图 |
| `Conversation` | 聊天历史图片展示 |
| `ImageViewer` | 全屏 lightbox 查看器 |
| `Provider` (后端) | 多模态 content blocks、视觉模型切换 |
| `loop.ts` (后端) | 附件上下文注入、externalPaths、session auto-approve |

## 8. 接口与契约边界

必须遵守：

- 跨进程数据结构只从 `@aurevoy/shared` 导入。
- 前端请求只通过 `apps/desktop/src/lib/api.ts`。
- 新增任务控制类 API 时，先改 `packages/shared/src/`，再联动 agent 与 desktop。
- 工具展示必须来自 `GET /api/tools`，不要在前端硬编码工具目录。
- API Key、Provider 配置等敏感信息不得硬编码到前端。
- 设置界面必须读取/写入真实配置；只展示静态表单不能算完成。
- 模型清单必须区分 Provider 返回的 `availableModels` 和用户启用的 `enabledModels`；
  当前 active model 不能被隐藏。
- 工具、记忆、搜索入口必须连接真实 API；否则禁用或隐藏。

## 9. 验收标准

基础验收：

- `npm run typecheck` 通过。
- 前端改动后 `npm run build -w @aurevoy/desktop` 通过。
- 引擎离线时，Composer 显示离线并禁用发送。
- Provider 未配置时，Composer 明确提示配置模型，不产生假回复。
- 创建任务后对话流展示计划、状态、流式结果与工具卡片。
- 非 safe 工具出现审批卡片，批准/拒绝都能反映真实后端结果。
- 点击停止会调用后端 cancel API，并在任务进入 cancelled/done 后关闭 EventSource。
- 收到 `done` 后关闭 EventSource，并刷新对话历史。
- 历史对话可在侧栏选中回看。
- 编码工作台可浏览工作区文件树；打开文件出现在编辑区页签；产物列表可打开预览。

界面验收：

- 应用启动停留在居中空状态 hero（引导问句 + 大输入框）。
- 提交目标后切换为对话流，输入框停靠底部。
- 编码工作台为「文档预览 | 固定文件树」分栏（文件树在最右侧）；文件树不是页签；顶栏可开关工作台。
- 窄窗口隐藏左侧栏与工作台，主区单列显示且不出现横向溢出。
- 长结果输出在对话流内滚动，不破坏布局。
- 模型 popover 点击空白处或按 Escape 能关闭；列表过长时内部滚动，且没有单独"关闭"按钮。
- 设置页手动获取模型后显示可勾选列表；主界面模型菜单只出现已启用模型。

## 10. 参考依据

- `docs/ARCHITECTURE.md`：前后端分离、本地 HTTP + SSE、契约集中。
- `docs/API.md`：`Task`、`AgentEvent`、HTTP API 与 SSE 事件流。
- `docs/CONVENTIONS.md`：开发约定、工程治理与交付门槛。
- `docs/ROADMAP.md`：里程碑与阶段规划。
- NN/g 可用性启发式：强调系统状态可见性、用户控制、错误恢复。
- AI 透明度 HCI 研究：强调 Agent 过程、能力边界和不确定性的可解释呈现。
