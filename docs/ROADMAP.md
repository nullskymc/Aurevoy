# Aurevoy 路线图

> 新路线基线：v0.7.0。0.7 系列从“补齐能力”转向“收敛交互、稳定交付、建立可信扩展”。
> 完成标准：用户可理解、操作可撤销、失败可恢复、行为可评测、发布可复现。
> 状态约定：`[x]` 表示源码与当前定向回归已证明；`[ ]` 表示仍缺实现、真实桌面环境、性能基线或发布证据。

## 产品方向

Aurevoy 的近期定位是：**本地优先、可恢复、可审计的个人 AI 工作台**。

近期只围绕三类高频任务深化：

1. 本地资料研究：读取目录 / KB / 网页，交付带来源的报告或文件。
2. 工作区任务：理解项目，规划并修改文件，展示过程、差异与产物。
3. 重复任务自动化：保存配方，手动或定时运行，查看历史并恢复失败任务。

不以增加 Provider、堆叠工具数量或构建第二套 Agent loop 作为阶段成果。

## v0.6.15 能力继承

| 域 | 已具备能力 |
|---|---|
| Agent | Pi AgentHarness、Scout、计划、追问、审批、预算、暂停/恢复、分支、压缩 |
| 工具 | Effect 工具框架、文件/网络工具、MCP、Skill、子代理、浏览器兼容入口 |
| 上下文 | 长期记忆、Dreams、KB 索引与混合召回、多模态附件 |
| 桌面 | Tauri、系统托盘、最近任务、三平台构建、GitHub Releases updater |
| 交付 | 对话、Timeline、工作台、文件预览、产物、自动化控制台、诊断与数据管理 |
| 工程 | shared 契约、SQLite 轨迹、M3–M10 回归、跨平台 typecheck |

## 版本推进规则

0.7 系列按补丁版本小步发布：

1. 每个补丁版本只承载一个主要产品主题，并有独立验收门。
2. 未通过验收的功能不以“基本完成”进入 Release；可安全关闭的未完成项顺延到下个补丁版本。
3. 交互契约、组件测试、真实 UI smoke 和用户文档随同一个版本交付。
4. 实际发布时统一同步 package、桌面应用、运行时、锁文件和文档版本；路线图版本不提前改写当前应用版本。
5. 安全或数据损坏问题可插入紧急修复版本，其余需求保持既定顺序。

## 当前迭代证据

本轮已补齐并验证：版本化 SQLite 迁移与迁移前备份、离线备份/恢复与 `quick_check`、本地 API Bearer 鉴权与严格 Origin、Tauri CSP 与动态工作区 scope、SSE 序号幂等、失败分类、审批 pending/error 状态、焦点捕获与键盘导航、工作台 tab 复用、文件变更/产物元数据、远程 MCP 敏感字段隔离、自动化试跑与等待态、脱敏任务指标、确定性 Agent eval、依赖清单审计，以及统一测试入口和 CI 鉴权回归。SQLite 当前 schema v6 将重启恢复标记持久化；新增真实 Agent 子进程 `SIGKILL`/重启恢复回归通过 11/11。完成对话可一键带入自动化草稿，草稿显式展示当前继承的全局模型和审批边界，预算默认关闭且模型/权限/预算仍需重新确认；MCP 官方模板默认关闭并保留连接测试/工具差异门，stdio / Streamable HTTP 的连接、重载和独立故障恢复由 `regression:mcp` 固定回归；页面标题与返回聊天行为统一；shell、Skill 安装和 MCP 工具在 auto 模式也要求显式审批，并按配置收窄 shell 环境/超时/输出，shell 另有静态系统命令、嵌套转发、解释器内联代码和符号链接边界；Skill 安装要求路径 allowlist 与检查依据，并由本地 Git HTTP 回归验证来源元数据、幂等重装和未知路径拒绝；`server-routes/skills.ts`、`server-routes/automations.ts`、项目/自动化 repository 已按行为测试小步抽出；App 恢复门禁和 Timeline 取消分类已下沉为纯模块。文件树已改为可见节点扁平化 + 虚拟列表，目录按 `next` 游标渐进加载，大文件源码按行虚拟化；浏览器 Skill 页面现在显示 Playwright MCP 的未配置/禁用/异常/就绪状态、脱敏工具范围、安装说明和一次性连接测试；浏览器命名的 MCP 默认只注册只读工具，下载/登录/提交按 profile 逐级放开，审批摘要区分导航、读取、截图和提交且不回显表单值；浏览器失败卡片按登录态、页面变化、元素失效和下载失败提供恢复/人工交接入口；浏览器截图、DOM 摘要和下载 resource 会落入工作区并复用工作台；`regression:browser` 通过本地 Puppeteer 页面上的只读研究与 dangerous 表单审批；发布工作流新增完整回归与 updater 清单审计门。实际 UI 基线已在 `/tmp/aurevoy-ui-baseline-20260806-final` 生成六组截图和报告。

当前工作树已同步为 v0.7.0 的代码/包元数据，但尚未打 tag 或推送 Release。不能宣称 v0.7.0 Release 完成的项目包括：真实 macOS/Windows WebView smoke、低性能设备和 Windows 缩放报告、系统休眠/时区验证、完整三平台发布产物核验，以及条件性的 Windows 签名；`regression:browser` 是本地真实 Agent/MCP/Puppeteer smoke，不替代真实 Playwright 依赖环境与发行版 WebView 验证。

2026-08-07 最终质量门已运行 `npm run regression:full` 并通过：单测 87 个文件 / 419 个测试、全仓类型检查、构建、M3–M10、认证、长循环、进程恢复、MCP、Skill、shell/browser/UI E2E、异步动作审计、Agent 可用性评测、文档构建和发布审计全部通过；发布审计为 16 项检查、0 failure、0 warning。该结果仍不替代上段列出的真实发行环境证据。

平台门的执行入口已固化：`regression:tauri-webview:strict` 可写入机器可读的成功/失败报告，macOS/Windows CI 与 Release job 会上传报告；`.github/workflows/windows-install-smoke.yml` 和 `windows-install-smoke.ps1` 负责在真实 Windows runner 上验证旧版安装、升级、启动和卸载，并把 SmartScreen 明确留给普通用户桌面会话观察。

## 交互原则

以下规则是所有前端里程碑的共同约束，细节以 [UI_DESIGN](./UI_DESIGN.md) 为准。

1. **对话是主线**：目标、执行状态、门禁和结果保持在同一轮次中，不让用户在多个面板寻找任务真相。
2. **运行中只显示当前状态**：单行状态流表达正在做什么；完整工具活动在完成后折叠展示。
3. **门禁就地发生**：工具审批贴近 Composer，Agent 追问留在对话流；不使用脱离上下文的全局弹窗。
4. **右侧只保留一个上下文面板**：计划、产物和工作台共享同一列位，禁止相互叠层或同时挤压主对话。
5. **失败必须给下一步**：失败、预算耗尽、连接中断都要提供继续、编辑重试、撤销或诊断入口。
6. **键盘和窄窗是一等场景**：所有 Dialog/Popover 可用键盘完成，焦点可见且关闭后返回触发点；最小窗口 840×560 可完成核心流程。
7. **外观服从现有设计语言**：沿用 Mist Teal、CSS token、浅色优先和克制动效，不引入第二套样式系统。

## 0.7 系列非功能性基线

非功能性改动不是独立的“以后再优化”，而是随每个小版本一起验收。优先记录当前基线，再用可复现数据判断是否退化；没有测量结果时不宣称性能提升。

### 性能与资源

- [x] 使用既有 Performance Timeline 标记记录任务请求、SSE 建连、首事件和首 token；任务快照与 token usage 按 Provider / 模型关联。
- [x] 对 Conversation、Timeline、文件树和设置页建立渲染边界与 UI 基线；流式期间使用虚拟会话列表和 rAF 限频，避免与 token 数量线性增长的整树重渲染。
- [x] 前端基线覆盖长任务、横向溢出、24px 目标和窄窗布局，并有长对话/流式回归；低性能设备与 Windows WebView2 的实机验收仍见下方平台门。
- [x] 大消息、长 Timeline、大目录和大文件使用限量、虚拟化或渐进读取；read、上传、产物和工作台预览均有大小上限与截断/失败说明。
- [x] 每个版本对比冷启动、引擎就绪、任务首响应和 UI 交互基线；`ui:baseline --no-screenshots --baseline` 已与 2026-08-06 六组报告比较，当前 12 个可比指标无超过 10% 的退化。

### 可靠性与数据完整性

- [x] SQLite schema 变更使用有版本号的迁移和事务；迁移失败不得留下半升级数据库。
- [x] 不兼容迁移前生成可恢复备份，并验证备份、恢复、`quick_check` 和磁盘空间不足路径。
- [x] running / paused / waiting approval / waiting clarification 状态经过真实 Agent 子进程 `SIGKILL`、重启和轨迹核验（`npm run regression:process-recovery`，11/11）。
- [x] SSE 断线重连、迟到订阅和事件重放保证幂等；同一消息、工具结果和产物不能重复落库或重复展示。
- [x] 自动化调度使用持久化 claim、waiting/missed 状态、孤儿 claim 恢复和重复触发门禁；系统休眠与时区变化的真实设备验证仍待平台门。

### 安全与隐私

- [x] 本地 Agent API 使用每次启动生成的访问令牌，并收紧 CORS / Origin；不能把“只监听 localhost”视为完整鉴权。
- [x] Tauri 启用受限 CSP，asset protocol、open path 和 URL opener 只开放产品实际需要的目录与协议。
- [x] shell、Skill 和本地 MCP 继续执行显式同意、最小环境变量、工作区边界、超时和输出上限；当前已补齐显式审批、shell 环境 allowlist、设置驱动的超时/输出上限、命令预览、静态路径/符号链接边界、系统级命令与动态嵌套 shell 拦截、Unix 进程组超时回收，以及 stdio / Streamable HTTP MCP 连接重载和故障恢复回归。Skill 安装现在要求检查路径与依据，并由 `regression:skill-install` 通过本地 git HTTP 真实验证；shell runner 已接入 macOS seatbelt、Linux bubblewrap 和 Windows Job Object 的能力探测、工作区可写与越界写入回归（`regression:shell-isolation`），缺失时仅显式回退为 `process`，`required` 会失败闭环；Windows strict 回归已纳入平台 CI，仍需真实 Windows 发布产物门验证。
- [x] 远程 MCP 的敏感 header / stdio env 进入本地凭证表并以脱敏 placeholder 注入；日志、轨迹、诊断导出和错误摘要不保存明文凭证。
- [x] 网页、文件和 MCP 返回内容按不可信输入处理，UI 标记外部来源并记录可疑 prompt injection 轨迹；审批、权限、预算和工作区边界仍由原有门禁执行。
- [x] 发布审计检查 lockfile、许可证、依赖清单和敏感文件规则；安装包/签名文件的最终核验仍由发布产物门执行。

### 可维护性与架构

- [x] `server.ts` 按路由域拆分，`db.ts` 按 repository / migration 拆分，`packages/shared` 按契约域组织导出；路由已覆盖 auth、health、workspace、automation、project、skill、settings、data、memory、knowledge-base、task read/write 与 SSE，存储已拆为 task/trace、Pi session tree、project、automation、settings、memory、memory-summary、sqlite-vec repository，`db.ts` 只负责连接、迁移和组装；shared 继续通过 `@aurevoy/shared/contracts` 提供渐进式契约域入口。
- [x] `App`、`Conversation`、`Timeline` 的状态计算下沉到 hooks、store 和纯函数；App shell/task controller 使用独立 hooks，Conversation 派生视图使用 `useConversationViewModel`，Timeline round 使用 `useTimelineRoundViewModel`，过程数据集中在 `timelineProcessData.ts`，既有行为测试与组件回归覆盖这些边界。
- [x] 拆分采用“先补行为测试、再迁移、最后删除旧路径”的小步方式；本轮按 M4/M6/M7/M8/M9、auth 和 Web UI 行为门迁移并删除 `server.ts`/`db.ts` 旧实现，未进行一次性全仓重写。
- [x] 跨进程类型继续只来自 `packages/shared`；新增工具只进入 registry，Provider 只扩展 Pi 映射。
- [x] 第三方 Pi 补丁可重复应用、可检测上游不兼容，且移除条件记录在 `docs/dev/pi-hosted-tools-patch.md`。

### 可观测性与问题诊断

- [x] 任务、SSE、工具、子代理、自动化和更新日志使用稳定关联 ID，能从用户错误定位到对应轨迹。
- [x] 健康诊断覆盖数据库、工作区、Node/Python、Provider、代理、MCP 和 updater，但不探测或导出明文凭证。
- [x] 在本地记录并汇总任务完成、失败阶段、恢复、介入次数、重试、耗时和 token usage；任务指标 API 与设置页只返回脱敏汇总，默认不上传任务内容、文件路径和提示词。
- [x] 用户可一键导出经过脱敏的最小诊断包；导出前显示包含内容，并允许取消。

### 小版本分配

| 版本 | 必须同步完成的非功能性重点 |
|---|---|
| v0.7.0 | 前端渲染/流式性能基线、无障碍、组件状态下沉、统一 UI 测试入口 |
| v0.7.1 | SQLite 迁移与备份、文件读取边界、产物幂等、工作台大数据性能 |
| v0.7.2 | 本地 API 鉴权、Tauri CSP/路径 scope、MCP/Skill/browser 安全与自动化恢复 |
| v0.7.3 | Agent eval、完整 CI、依赖与打包审计、诊断指标、条件性 Windows 签名 |

## v0.7.0 — 对话交互收敛

目标：用户不阅读轨迹、不理解 Agent 内部概念，也能判断“现在发生了什么、是否需要我、下一步能做什么”。

### 信息架构

- [x] 固定四区语义：左侧导航 / 顶部上下文 / 中央对话 / 可选右侧工作台。
- [x] 统一聊天、搜索、Skill、自动化、设置的页面标题、返回聊天行为与选中状态；标题随当前任务和 locale 更新。
- [x] 合并计划浮层、产物浮层和工作台的列位管理；任何时刻右侧最多打开一个主面板。
- [x] 明确临时层级：Context Menu < Popover < Drawer < Modal；Esc 只关闭最上层。
- [x] 保存侧栏折叠、面板宽度和工作台开关，但切换项目/任务时不保留失效选中项。

### 单轮任务语法

- [x] 发送前：附件、模型、Agent/Plan 模式和不可发送原因在 Composer 内可见。
- [x] 运行中：只展示一个稳定的 live status；SSE 高频事件不造成列表跳动和重复状态。
- [x] Steering / follow-up 明确区分“本轮立即引导”和“排队到下一轮”，消息进入模型上下文前可在状态 Dock 中清空队列。
- [x] 审批：展示工具、目标、风险和关键参数；批准/拒绝后就地更新，不残留失效按钮。
- [x] 追问：回答后保留问题与答案，刷新或恢复任务后状态一致。
- [x] 完成：最终 Markdown 为主交付，“已处理”过程默认折叠；产物和来源作为正文后的轻量操作区。
- [x] 失败：区分模型、工具、权限、预算、网络和引擎错误，并给出可执行的恢复动作。
- [x] 取消：与失败视觉和语义分离；保留已完成步骤，允许基于现有上下文继续。

### 滚动、流式与反馈

- [x] 用户停留在底部时自动跟随；主动上滚后停止抢滚，并显示“回到最新”。
- [x] 流式正文、状态行、工具进度分别限频更新，避免整棵 Conversation 重渲染。
- [x] 迟到订阅、应用切后台后恢复、任务切换回来均不重复消息或丢失当前状态。
- [x] 所有异步操作具有 pending / success / error 反馈；`npm run audit:async-actions` 固定审计设置、MCP、记忆/知识库、数据、OAuth、自动化、Skill、会话树、文件树、文件预览、侧栏删除和 App toast 边界共 15 项动作契约，行为时序由组件测试与回归覆盖。
- [x] Toast 只承载短暂反馈，需用户处理的错误留在当前任务/设置页的持久错误区；App 动作错误提供关闭入口，工作台文件操作和会话树错误保留在组件上下文，并由异步动作审计覆盖。

### 键盘、无障碍与窄窗

- [x] `Cmd/Ctrl+K` 搜索、`Cmd/Ctrl+N` 新对话、`Cmd/Ctrl+,` 设置；快捷键不抢占输入法组合状态。
- [x] Dialog 打开后捕获焦点，Tab 在内部循环，Esc 关闭，关闭后焦点返回触发点。
- [x] 菜单、会话列表、模型选择和文件树支持方向键导航与清晰的 focus-visible。
- [x] 非行内点击目标达到至少 24×24 CSS px；基线脚本对六种 viewport/主题扫描无小目标，危险动作继续使用确认或独立状态。
- [x] 840×560 下侧栏和输出栏自动收起，工作台切换为可关闭覆盖式 Drawer；Composer、审批和停止入口保持在主列。
- [x] 125% / 150% Windows 缩放下无文字截断、遮挡或横向页面滚动；`npm run audit:ui-scale -- --strict` 固定 1280×800 物理视口，检查两档 CSS viewport、横向溢出和可交互文本裁切。
- [x] 尊重 `prefers-reduced-motion`，状态变化不只依赖颜色表达。

### v0.7.0 验收门

- [x] 为创建任务、审批、追问、取消、编辑重试、继续任务补齐组件测试。
- [x] 已建立 840×560、1280×800、1600×1000 的浅色/深色截图基线，报告位于 `/tmp/aurevoy-ui-baseline-20260806-final/report.json`。
- [ ] 在 macOS WebView 与 Windows WebView2 各完成一次真实 UI smoke；`regression:tauri-webview:strict` 已覆盖 macOS Accessibility 与 Windows UI Automation/WebView2 子进程检查并可上传报告，但本机 macOS 桌面会话仍未暴露可见窗口，Windows runner 也仍需实际执行并保留成功报告，不能以此标记通过。
- [x] `npm run typecheck`、Web UI 测试、`regression:long-loop` 通过。
- [x] `App`、`Conversation`、`Timeline` 的新增逻辑优先下沉到 hooks / store / 纯函数，不继续扩大单文件职责。
- [x] 已提供可复现的流式渲染、长对话和任务首响应采样脚本；本轮报告无长任务、横向溢出或目标尺寸退化，历史对比仍需后续版本保留报告后执行。

## v0.7.1 — 工作台与交付闭环

目标：Agent 的结果不只是一段回复，而是可定位、可检查、可继续处理的本地产物。

### 文件与产物

- [x] 对话中的本地路径统一渲染为文件 chip，可预览、在系统中打开或定位到目录。
- [x] 工作台统一文本、Markdown、代码、图片、HTML/Canvas 和未知文件的加载/失败状态。
- [x] 文件修改任务提供变更摘要和增删统计；有基线时展示统计，不能获得时明确说明。
- [x] 产物展示名称、类型、来源任务、更新时间、大小和工作区位置；覆盖前返回影响信息并要求确认。
- [x] 从最终回复、过程活动、Output rail 打开同一产物时复用现有 tab，不重复创建。

### 来源与上下文解释

- [x] 研究结果可展开查看网页、KB 片段和本地文件来源，并能跳回工作区路径或来源链接。
- [x] 显示本轮是否使用记忆/KB，并展示召回摘要与来源；逐条纠正/禁用召回内容仍需独立的记忆管理交互。
- [x] 明确区分“模型生成内容”“工具读取内容”“用户文件”和外部不可信文本，避免把外部文本表现为系统指令。
- [x] 浏览器截图、DOM 摘要、下载文件可直接进入工作台，而不是只停留在工具结果 JSON；浏览器 MCP content/resource 块会按大小上限写入 `.aurevoy/browser-artifacts`，以不可信文件/图片块挂回当前助手消息。

### 工作台布局

- [x] 文件树、tab、预览和产物列表共享一致的选中、关闭、空态和错误语法。
- [x] 面板 resize 有最小/最大宽度、双击复位和键盘替代操作。
- [x] 窄窗切换为覆盖式 Drawer；关闭后主对话列宽保持，工作台 tab 状态不重复创建。
- [x] 打开大文件或大量目录时使用虚拟化/渐进加载，不阻塞对话流式输出；文件树分页/虚拟化已通过本地 UI smoke，大文件源码行虚拟化已通过组件测试与构建门。

### v0.7.1 验收门

- [x] 建立“研究报告”“多文件修改”“图片/HTML 产物”三条真实 E2E 轨迹；`npm run regression:ui-e2e` 启动真实 Agent、Vite 页面和确定性 LLM fixture，通过 UI 输入、审批、文件链接、图片与隔离 HTML 预览验证。
- [x] 工作区越界、文件不存在、二进制文件、超大文件均有明确失败状态，并由 M3/文件边界测试覆盖。
- [x] 文件链接、工作台 tab 和产物恢复经过刷新/重启测试；同一回归会刷新页面、重新选择任务、重启 Agent，再验证 `report.md` tab 与 Markdown 预览。
- [x] `npm run typecheck`、相关组件测试、M3、M4、M7、M8 通过。
- [x] 数据库迁移/备份恢复、磁盘空间不足、产物重复事件、文件边界和大目录/大文件工作台性能已通过定向回归。

## v0.7.2 — 浏览器、Skill 与自动化体验

目标：把现有扩展能力从“配置后可用”推进到“用户知道为何启用、能安全试跑、出错后能处理”。

### 浏览器

- [x] 提供浏览器运行时检测、安装说明和连接测试，不要求用户从日志判断是否可用；Skill 页面通过 `/api/browser/status` 与一次性 `/api/browser/test` 展示脱敏状态，未配置时明确提示安装与 MCP 配置。
- [x] 提供只读研究、允许下载、允许登录、允许提交四级权限模板；浏览器命名的 MCP 默认只注册只读工具，设置页可逐级放开并显示被 profile 拦截的工具数。
- [x] 导航、读取、截图与表单提交使用不同的审批摘要；摘要只展示站点/定位字段，不回显表单值，且所有浏览器 MCP 调用仍要求显式审批。
- [x] 登录态缺失、页面变化、元素失效、下载失败均提供重试或转人工操作入口；失败卡片按类型给出重试、脱敏页面和人工摘要动作，并由 browser recovery 单测覆盖分类/URL/秘密字段脱敏。
- [x] 外部网页内容按不可信输入处理，在 UI 中标记来源并保留 prompt injection 轨迹。

### Skill / MCP

- [x] Skill 详情展示来源、版本、实际目录、启用状态、allowed tools、许可证、兼容性和最近加载错误。
- [x] 安装前展示仓库与实际安装路径；本地 MCP 展示完整 command / args / cwd / env 名称。
- [x] MCP 设置使用结构化表单覆盖 stdio / Streamable HTTP 常用场景，高级 JSON 作为补充入口。
- [x] 提供 filesystem、everything 和 Streamable HTTP 三个官方/协议参考模板；模板只预填配置、默认关闭并标注风险，保存后仍经连接测试与工具差异预览。
- [x] 更新或重新加载后说明新增、移除和风险等级变化的工具。

### 自动化

- [x] 创建流程收敛为：任务目标 → 调度 → 模型/预算 → 权限 → 测试运行 → 保存；弹窗显式展示继承的全局模型/审批边界，并要求确认后才能试跑或保存。
- [x] 保存前可执行真实任务试跑；失败通过设置页通知反馈，草稿仍保留在弹窗中且不写入配方运行历史。
- [x] 运行历史展示触发方式、耗时、状态、结果任务、失败阶段和重跑入口。
- [x] 对连续失败、等待审批、等待追问、预算耗尽和错过调度给出独立持久化状态与文案，不用单一红点概括。
- [x] 从一次成功对话创建自动化时继承目标、项目和可辨识名称；自动化保持关闭，权限/模型/预算仍需在草稿中重新确认。

### v0.7.2 验收门

- [x] 浏览器只读研究和一次需审批的表单流程完成真实 smoke；`npm run regression:browser` 启动真实 Agent、两组 stdio MCP 与 Puppeteer 本地页面，验证只读过滤、DOM 读取、dangerous `browser_click` 审批和实际表单提交。
- [x] stdio / Streamable HTTP MCP 各完成连接配置/测试、重载、失败恢复测试；本地 fixture 覆盖独立故障不拖垮其他 transport，并由 `npm run regression:mcp` 固定执行。
- [x] 自动化创建、测试运行、定时 due/missed、等待态和重跑通过 M10（19/19）。
- [x] 新增外部能力不绕过原有审批、预算、沙箱与轨迹。
- [x] 本地 API 鉴权、严格 Origin、Tauri CSP/路径 scope、MCP 凭证脱敏和 prompt injection 边界已由 auth/M7/定向测试覆盖。

## v0.7.3 — 可评测与可信分发

目标：版本是否可发布由数据和发布门决定，而不是由功能列表决定。

### Agent 评测

- [x] 建立 `scripts/evals/`，覆盖资料研究、文件修改、恢复、浏览器、KB 和自动化任务。
- [x] 评测优先使用规则、文件状态和轨迹评分；当前不依赖 LLM Judge，保留可扩展接口。
- [x] 评测结果记录任务通过率、危险副作用、用户介入次数、重试次数、耗时和 token usage。
- [x] 提供 `npm run eval:agent-usability`，固定 fixture 后结果可复现；当前 6 个正向场景通过，1 个危险副作用反例按预期被拦截。
- [x] `run-evals.mjs --baseline` 对固定 fixture 检查得分下降、正向场景失败和危险副作用增加，不接受只展示成功样例。

建议发布阈值：

| 指标 | v0.7.3 目标 |
|---|---:|
| 核心任务通过率 | ≥ 85% |
| 不可逆错误副作用 | 0 |
| 中断后状态恢复率 | ≥ 95% |
| 首次配置后完成首个任务 | ≤ 5 分钟 |
| UI smoke 阻断问题 | 0 |

### CI 与发布门

- [x] 根脚本提供统一 `test`，CI 自动运行 unit、typecheck、build 和关键回归。
- [x] PR 由 CI 跑快速门；tag 发布 job 通过 `release-gate` 运行 `npm run regression:full`，覆盖完整 M3–M10、Agent eval、文档构建和发布审计，并在 `create-release` 前阻断。
- [x] `create-release` 先要求三平台产物与 updater platform key，再由 `audit:release --updater-manifest` 核对清单版本、URL、签名和平台完整性，缺任一平台即停止 Release。
- [x] 依赖升级、Pi 补丁应用和 SQLite 原生模块打包有独立脚本/构建验证。
- [x] 发布审计可生成依赖清单，并检查敏感文件、开发配置、source map 和非运行时依赖；本轮源码/锁文件与 `apps/desktop/dist`（70 文件）共 16 项检查无 failure/warning。
- [x] 脱敏诊断包可关联任务、工具和更新失败，同时不包含提示词、文件正文、明文凭证和完整本地路径。

### Windows 签名（条件性推进）

Windows 代码签名纳入评估，但不阻塞 v0.7.0–v0.7.2。若 Aurevoy 进入公开 Windows 分发，则升级为 v0.7.3 发布项：

- [x] 比较标准代码签名证书、EV 证书和云签名服务的成本、CI 接入与密钥托管方式；预审文档见 [Windows 分发与代码签名预审](./dev/windows-signing.md)。
- [ ] 在 Windows runner 签名 NSIS 安装包及主可执行文件，私钥只进入受保护的 CI Secret / 签名服务。
- [ ] 发布任务使用 `signtool verify`（或供应商等价工具）校验签名、时间戳和证书链。
- [ ] 在干净 Windows 环境验证安装、启动、卸载、更新与 SmartScreen 表现；执行入口为 `windows-install-smoke.ps1` / `windows-install-smoke.yml`，真实报告仍待 Windows runner 和普通用户桌面会话。
- [x] 编写证书续期、轮换和紧急撤销文档，已纳入 [Windows 分发与代码签名预审](./dev/windows-signing.md)。

## 明确不纳入路线图

- **macOS Apple Developer 签名、公证及相关 key 管理不再作为计划项或发布门。** 现有 macOS 构建和 updater 可继续维护，但不围绕 Gatekeeper 提示追加开发任务。
- 暂不建设第二套 Agent loop、图工作流框架或更复杂的多 Agent 组织层。
- 暂不进行模型后训练、自建推理服务、移动端和多人协作。
- 暂不建设开放 Skill/MCP 市场；先完成来源、权限和更新信任模型。
- 暂不以新增 Provider 数量作为版本目标。

## 路线优先级

当需求冲突时按以下顺序取舍：

1. 数据安全、权限边界和不可逆副作用。
2. 当前任务能否完成、恢复和解释。
3. 对话主线与核心交互的一致性。
4. 工作台交付、浏览器和自动化体验。
5. 新工具、新 Provider 和装饰性界面。

## 参考标准

- Dialog / Popover 的焦点、Tab 循环与 Esc 行为参考 [WAI-ARIA Dialog Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)。
- 非行内点击目标参考 [WCAG 2.2 Target Size Minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)。
- Windows 安装与签名策略参考 [Tauri Distribution](https://v2.tauri.app/distribute/) 与 [Windows Installer](https://v2.tauri.app/distribute/windows-installer/)。
