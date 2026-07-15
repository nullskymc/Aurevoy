# UI 设计

> 对话优先、克制留白的个人 Agent 桌面 UI。  
> 只反映真实后端能力；无假进度、假设置、不可执行控制。

## 目标

1. **对话主线**：目标 → 计划 → 执行 → 结果，过程细节按需展开。  
2. **克制视觉**：浅色、留白、弱边框；单一中性强调色。  
3. **可控**：停止、审批、编辑重试、分支等均调真实 API。  
4. **本地可信**：页脚展示引擎在线与模式；离线禁用发送。

## 信息架构

```
┌────────────┬──────────────────────────┬────────────────────┐
│ 侧栏历史    │ 对话流 + Composer         │ 编码工作台（可选）   │
│ 动作入口    │                          │ 文件树 + 预览页签    │
└────────────┴──────────────────────────┴────────────────────┘
```

| 区域 | 必须 | 不要 |
|---|---|---|
| 侧栏 | 新对话、历史（时间倒序）、设置/记忆/搜索等真入口 | 统计仪表盘、装饰卡片 |
| 主区空态 | 引导句 + 大 Composer | 教程墙 |
| 主区对话 | 用户气泡、Agent 交付正文、可折叠过程（计划/工具/子代理） | 常驻「运行详情」侧栏 |
| Composer | Enter 发送、模型 popover、auto/plan、引擎状态 | 未配置时仍假装可聊 |
| 工作台 | 固定文件树 + 打开文档/产物预览 | 把树做成页签；叫 inspector |

窄窗：侧栏可收；工作台可关。

## 状态展示

| `TaskStatus` | 文案倾向 |
|---|---|
| pending / planning / running | 等待 / 规划 / 执行 |
| paused | 等待确认（审批、追问、预算） |
| completed / failed / cancelled | 完成 / 失败 / 已取消 |

细粒度只用后端 `TaskPhase`（thinking、calling_tool、waiting_approval…），前端不猜。

## 核心流程

**启动：** `health` + `tasks`（+ 需要时 tools）。在线可发送；离线禁用。

**发任务：** `POST /api/tasks` → 订 `stream` → 按 `AgentEvent` 增量更新。  
迟到订阅：先任务快照（含 `subagentRuns` 等）再实时事件。

**续聊：** 同任务 `POST .../messages`；运行中可 steering/follow_up。

**控制：** 停止 cancel；工具/计划审批；追问回答；预算触顶后 resume / budget continue。

### 编辑重试（一步）

1. 用户消息铅笔 → 内联改文案 + 范围（对话+计划 / 仅对话）。  
2. 「修改并重试」= `revert` + 立刻 `messages`（编辑稿 + 原附件）。  
3. 取消只关卡片，不截断历史。  
4. 无 Composer「编辑模式」、不用 `removedContent` 覆盖稿。  
5. continue 失败时可用「撤销编辑」（`archivedMessages`）；成功 continue 后归档清空。

**分支：** `branch` 新任务并切换。**压缩：** `/compact` 或 API。

### 子代理工作组

- `delegate` 不重复成普通工具步骤；同轮多代理聚成工作组卡片。  
- 进度来自 `subagent_updated` / `Task.subagentRuns`；不刷子代理 token 进主正文。

### 多模态

- 拖拽/粘贴图片 → 上传 → 消息 attachments；由当前选择且支持图片输入的模型处理。
- 气泡内缩略图 + 查看器；`attach_content` / `present_ui` 进对话与工作台。

## 组件边界（web-ui）

| 组件 | 职责 |
|---|---|
| `App` | 视图切换、全局状态拼装 |
| `Conversation` / `Timeline` | 轮次、工具、子代理、失败卡 |
| `Composer` | 输入、附件、模型、auto/plan、斜杠命令 |
| `WorkbenchPanel` | 文件树与预览 |
| `SettingsPanel` | 真设置（LLM 槽位、工具、MCP、KB、搜索…） |
| hooks | SSE、任务控制、设置、附件 |

API 只经 `packages/web-ui/src/api/`。

## 视觉纪律

- 浅色优先；主列限宽；列表/气泡对齐一致。  
- 字号、间距、圆角用 CSS token；Composer / toast / 工具卡共用。  
- 动效克制：流式光标、折叠高度即可。

## 验收（产品）

- 离线/未配置模型不能「假聊」。  
- 审批与计划门禁可点且生效。  
- 编辑重试一步完成且可取消本地草稿。  
- 工作台能打开工作区文件与产物。  
- 无静态假工具列表、假记忆、假设置保存。
