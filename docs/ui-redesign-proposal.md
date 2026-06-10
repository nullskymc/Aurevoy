## Aurevoy Agent UI 改进设计文档

### 一、现状分析与核心问题

Aurevoy 的桌面端 UI 基于 React + 纯 CSS（App.css ~2900 行）构建，采用 5 列 CSS Grid 布局（sidebar / resize / main / resize / inspector）。设计 token 体系完整，暗色模式支持到位。但主对话区域存在以下结构性问题：

**问题 A：对话与执行过程混杂。** 用户指令、Agent 自然语言回复、工具调用卡片（`ToolActivityCard`）平铺在同一个 `conversation-thread` 流中，仅靠 28px 的 `padding-left` 区分。工具卡片（border-radius 14px，min-height 40px + body）在视觉体量上远大于 Agent 的文本段落，破坏了阅读节奏。

**问题 B：主区域只有一种模式。** 当前 `activeView` 是 `"chat" | "search" | "tools" | "memory" | "settings"` 的扁平枚举，没有任何"文档/产物"视图。当 Agent 创建了文件后，用户只能在对话流中读一句"已经创建好了"，无法直接查看产物。

**问题 C：顶部信息密度失控。** `RunSummaryPanel` 把 `StatusPill`、`BudgetBar`（工具调用数 + 输出字节数）、`PlanCard` 全部平铺在主对话区顶部，加上 topbar 的标题、状态、消息数、操作按钮，信息维度过多。

**问题 D：侧边栏缺少上下文。** `conv-item` 只展示任务标题 + 状态点 + 相对时间，没有产物摘要、工具使用概况等关键信息。

**问题 E：Markdown 渲染器能力不足。** 手写的 `MarkdownRenderer.tsx` 不支持有序列表、表格、引用块、嵌套格式，heading 不跟随 `--font-scale`，代码块无语法高亮。

---

### 二、改进方案总览

方案分三个层面，按优先级排列：

| 优先级 | 层面 | 改动范围 | 预期效果 |
|--------|------|---------|---------|
| P0 | 视觉层次重构 | Conversation.tsx + App.css | 工具执行与对话内容在视觉上拉开主次 |
| P0 | 多模式内容区 | App.tsx + 新增 ArtifactView.tsx | 主区域支持"对话"和"产物"两种视图 |
| P1 | 侧边栏增强 | TaskHistorySidebar.tsx + App.css | 任务项展示产物摘要和工具概况 |
| P1 | 顶部信息精简 | App.tsx + Conversation.tsx | 开发向信息迁至 Inspector，主区只留核心状态 |
| P2 | Markdown 升级 | MarkdownRenderer.tsx | 接入 marked 库，支持完整 GFM |
| P2 | 无障碍补全 | App.css 全局 | focus-visible、键盘导航、ARIA |

---

### 三、P0-1：视觉层次重构——工具执行降级为内联摘要

#### 3.1 设计思路

当前 `ToolActivityCard` 是一个完整的可折叠卡片（border-radius 14px、header + body + approval 区域），即使折叠状态也有 ~40px 高。对比 Agent 的文本段落（约 20-30px），工具卡片在视觉体量上"反客为主"。

改造目标：

- **已完成/已失败的工具调用** → 折叠为单行 chip（图标 + 工具名 + 状态），视觉体量约等于一行文本
- **正在执行/待确认的工具调用** → 保留完整卡片形态，但视觉权重低于对话文本
- **参数和结果详情** → 默认隐藏，点击 chip 展开（保留现有行为）

这样对话流的阅读节奏变为：用户指令（醒目）→ Agent 回复（主体）→ 工具摘要（辅助，一行扫过）。

#### 3.2 Conversation.tsx 改动

将 `ToolActivityCard` 拆分为两种形态：`ToolChip`（紧凑态）和 `ToolCard`（完整态）。默认用紧凑态，只在 `running` 或 `awaiting` 状态时自动升级为完整态。

```tsx
// Conversation.tsx 新增组件
function ToolChip({
  item,
  onDecision,
}: {
  item: ToolActivity;
  onDecision: (callId: string, approved: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(item.status === "awaiting" || item.status === "running");

  // 状态变为 awaiting 时自动展开
  useEffect(() => {
    if (item.status === "awaiting" || item.status === "running") setExpanded(true);
  }, [item.status]);

  // 如果展开，升级为完整卡片
  if (expanded) {
    return <ToolActivityCard item={item} onDecision={onDecision} onCollapse={() => setExpanded(false)} />;
  }

  const statusIcon = toolStatusIcon(item.status);
  return (
    <button
      type="button"
      className="tool-chip"
      data-status={item.status}
      onClick={() => setExpanded(true)}
      aria-label={`查看工具 ${item.name} 详情`}
    >
      <span className="tool-chip-icon" aria-hidden="true">{statusIcon}</span>
      <span className="tool-chip-name">{item.name}</span>
      {item.riskLevel && item.riskLevel !== "safe" && (
        <span className="tool-chip-risk" data-risk={item.riskLevel}>
          {item.riskLevel === "dangerous" ? "高" : "需确认"}
        </span>
      )}
    </button>
  );
}
```

对应的 `ToolActivityList` 改造为自动选择形态：

```tsx
function ToolActivityList({
  items,
  onDecision,
}: {
  items: ToolActivity[];
  onDecision: (callId: string, approved: boolean) => void;
}) {
  return (
    <div className="tool-activity">
      {items.map((item) => {
        // running 和 awaiting 状态始终展示完整卡片
        if (item.status === "running" || item.status === "awaiting") {
          return <ToolActivityCard key={item.id} item={item} onDecision={onDecision} />;
        }
        // 已完成/已失败折叠为 chip
        return <ToolChip key={item.id} item={item} onDecision={onDecision} />;
      })}
    </div>
  );
}
```

需要同时修改现有的 `ToolActivityCard`，增加 `onCollapse` 可选 prop，使展开态卡片可以被手动收起回到 chip：

```tsx
// ToolActivityCard 的 props 接口扩展
function ToolActivityCard({
  item,
  onDecision,
  onCollapse, // 新增：当从 chip 展开时，允许收起
}: {
  item: ToolActivity;
  onDecision: (callId: string, approved: boolean) => void;
  onCollapse?: () => void; // 新增
}) {
  const [open, setOpen] = useState(item.status === "awaiting");
  const [decided, setDecided] = useState(false);

  useEffect(() => {
    if (item.status === "awaiting") setOpen(true);
  }, [item.status]);

  // ... 现有逻辑保持不变 ...

  return (
    <section className="tool-card" data-open={open} data-status={item.status} aria-label={`${kindLabel}调用 ${item.name}`}>
      <button type="button" className="tool-card-head" onClick={() => {
        if (open && onCollapse) {
          onCollapse(); // 如果有 onCollapse 回调，调用它回到 chip
        } else {
          setOpen((v) => !v);
        }
      }}>
        {/* ... 现有 head 内容不变 ... */}
      </button>
      {/* ... 现有 body 和 approval 区域不变 ... */}
    </section>
  );
}
```

#### 3.3 对应 CSS

```css
/* 工具调用 chip（紧凑态） */
.tool-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--ui-space-1);
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--text-secondary);
  font-size: calc(12.5px * var(--font-scale));
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.tool-chip:hover {
  background: var(--hover);
  border-color: var(--border-strong);
}

.tool-chip-icon {
  font-size: 11px;
}

.tool-chip[data-status="ok"] .tool-chip-icon {
  color: var(--online);
}

.tool-chip[data-status="error"] .tool-chip-icon {
  color: var(--offline);
}

.tool-chip-name {
  overflow: hidden;
  max-width: 200px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-chip-risk {
  font-size: 11px;
  font-weight: 600;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--warn-soft-bg);
  color: var(--warn-soft-fg);
}

.tool-chip-risk[data-risk="dangerous"] {
  background: var(--danger-soft-bg);
  color: var(--danger-soft-fg);
}

/* tool-activity 改为 flex wrap，让多个 chip 自然排列 */
.tool-activity {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
```

这个改动的核心效果是：对话流中连续调用 3-4 个工具时，它们会折叠成一行紧凑的 chip 序列，而非占据 160-200px 的纵向空间。用户只需点击感兴趣的 chip 即可查看详情。

---

### 四、P0-2：多模式内容区——引入产物视图

#### 4.1 设计思路

在主对话区域增加一个"内容模式切换器"，让用户可以在"对话"和"产物"两种视图间切换。对话视图保持现有行为；产物视图以文档浏览器的方式展示 Agent 创建的文件、生成的内容。

#### 4.2 新增 ContentMode 类型

```tsx
// App.tsx 类型扩展
type ContentMode = "conversation" | "artifacts";
```

在 `App` 组件中增加状态：

```tsx
const [contentMode, setContentMode] = useState<ContentMode>("conversation");
```

#### 4.3 新增 ArtifactView 组件

```tsx
// components/ArtifactView.tsx
import { useState } from "react";
import type { TaskArtifact } from "@aurevoy/shared";
import { MarkdownRenderer } from "./MarkdownRenderer";

interface ArtifactViewProps {
  artifacts: TaskArtifact[];
  onDecision: (artifactId: string, status: "confirmed" | "rejected") => void;
}

export function ArtifactView({ artifacts, onDecision }: ArtifactViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(
    artifacts.length > 0 ? artifacts[0].id : null
  );
  const selected = artifacts.find((a) => a.id === selectedId) ?? null;

  if (artifacts.length === 0) {
    return (
      <div className="artifact-view-empty">
        <p>暂无产物</p>
        <small>Agent 创建的文件和生成的内容会出现在这里</small>
      </div>
    );
  }

  return (
    <div className="artifact-view">
      <nav className="artifact-nav" aria-label="产物列表">
        {artifacts.map((artifact) => (
          <button
            key={artifact.id}
            type="button"
            className="artifact-nav-item"
            data-active={artifact.id === selectedId}
            data-status={artifact.status}
            onClick={() => setSelectedId(artifact.id)}
          >
            <span className="artifact-nav-icon" aria-hidden="true">
              {artifact.type === "file" ? "📄" : artifact.type === "diff" ? "📋" : artifact.type === "url" ? "🔗" : "📝"}
            </span>
            <span className="artifact-nav-copy">
              <strong>{artifact.name}</strong>
              <small>{artifact.appliedPath || artifact.type}</small>
            </span>
            <span className="artifact-nav-status" data-status={artifact.status}>
              {artifact.status}
            </span>
          </button>
        ))}
      </nav>

      {selected && (
        <article className="artifact-doc">
          <header className="artifact-doc-head">
            <h1>{selected.name}</h1>
            {selected.appliedPath && <span className="artifact-doc-path">{selected.appliedPath}</span>}
            {selected.status === "draft" && (
              <div className="artifact-doc-actions">
                <button type="button" className="ghost-btn" onClick={() => onDecision(selected.id, "rejected")}>
                  拒绝
                </button>
                <button type="button" className="primary-btn" onClick={() => onDecision(selected.id, "confirmed")}>
                  确认
                </button>
              </div>
            )}
          </header>
          <div className="artifact-doc-body">
            <MarkdownRenderer content={selected.content} />
          </div>
        </article>
      )}
    </div>
  );
}
```

#### 4.4 主区域的模式切换 UI

在 topbar 中（当 `showConversation` 时）加入模式切换按钮：

```tsx
// App.tsx topbar 区域，在 topbar-context 后增加
<div className="content-mode-switcher">
  <button
    type="button"
    className="mode-btn"
    data-active={contentMode === "conversation"}
    onClick={() => setContentMode("conversation")}
  >
    对话
  </button>
  <button
    type="button"
    className="mode-btn"
    data-active={contentMode === "artifacts"}
    onClick={() => setContentMode("artifacts")}
  >
    产物
    {(currentTask?.artifacts?.length ?? 0) > 0 && (
      <span className="mode-badge">{currentTask?.artifacts?.length}</span>
    )}
  </button>
</div>
```

主区域渲染根据 `contentMode` 切换：

```tsx
// App.tsx 主内容区域
{showConversation ? (
  contentMode === "conversation" ? (
    <>
      <div className="main-scroll" ref={mainScrollRef}>
        <Conversation ... />
      </div>
      <div className="composer-dock">
        <Composer ... />
      </div>
    </>
  ) : (
    <div className="main-scroll">
      <ArtifactView
        artifacts={currentTask?.artifacts ?? []}
        onDecision={handleArtifactDecision}
      />
    </div>
  )
) : ( ... )}
```

#### 4.5 对应 CSS

```css
/* 内容模式切换器 */
.content-mode-switcher {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--ui-radius-md);
  background: var(--surface);
}

.mode-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--ui-space-1);
  height: 28px;
  padding: 0 12px;
  border: none;
  border-radius: var(--ui-radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--ui-font-sm);
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.mode-btn:hover {
  color: var(--text);
}

.mode-btn[data-active="true"] {
  background: var(--card-bg);
  color: var(--text);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.mode-badge {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--accent-soft-bg);
  color: var(--accent-soft-fg);
  font-size: 11px;
  font-weight: 700;
}

/* 产物视图布局 */
.artifact-view {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 0;
  height: 100%;
  max-width: 960px;
  margin: 0 auto;
}

.artifact-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--ui-space-4) var(--ui-space-3);
  border-right: 1px solid var(--border);
  overflow-y: auto;
}

.artifact-nav-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--ui-space-2);
  padding: var(--ui-space-2) var(--ui-space-3);
  border: none;
  border-radius: var(--ui-radius-md);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s;
}

.artifact-nav-item:hover {
  background: var(--hover);
}

.artifact-nav-item[data-active="true"] {
  background: var(--active);
}

.artifact-nav-item strong {
  display: block;
  font-size: var(--ui-font-sm);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-nav-item small {
  display: block;
  color: var(--text-tertiary);
  font-size: var(--ui-font-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-nav-status {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
}

.artifact-nav-status[data-status="confirmed"] {
  background: var(--success-soft-bg);
  color: var(--success-soft-fg);
}

.artifact-nav-status[data-status="applied"] {
  background: var(--success-soft-bg);
  color: var(--success-soft-fg);
}

.artifact-nav-status[data-status="draft"] {
  background: var(--accent-soft-bg);
  color: var(--accent-soft-fg);
}

.artifact-nav-status[data-status="rejected"] {
  background: var(--danger-soft-bg);
  color: var(--danger-soft-fg);
}

/* 产物文档区域 */
.artifact-doc {
  padding: var(--ui-space-6) var(--ui-space-5);
  overflow-y: auto;
}

.artifact-doc-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--ui-space-3);
  margin-bottom: var(--ui-space-5);
  padding-bottom: var(--ui-space-4);
  border-bottom: 1px solid var(--border);
}

.artifact-doc-head h1 {
  margin: 0;
  font-size: calc(20px * var(--font-scale));
  font-weight: 700;
}

.artifact-doc-path {
  color: var(--text-tertiary);
  font-size: var(--ui-font-sm);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.artifact-doc-actions {
  display: flex;
  gap: var(--ui-space-2);
  margin-left: auto;
}

.artifact-doc-body {
  max-width: 720px;
  line-height: 1.7;
}

.artifact-view-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--ui-space-2);
  height: 100%;
  color: var(--text-tertiary);
}

.artifact-view-empty p {
  margin: 0;
  font-size: var(--ui-font-md);
  font-weight: 600;
}

.artifact-view-empty small {
  color: var(--text-tertiary);
}
```

---

### 五、P1-1：侧边栏增强——任务项展示上下文摘要

#### 5.1 设计思路

参考业界做法（侧边栏每个分类下直接内联展示活动条目），在 `conv-item` 中增加一行上下文摘要：展示任务的关键产物名、工具调用数和简短状态描述。

#### 5.2 TaskHistorySidebar.tsx 改动

在 `conv-copy` 区域增加摘要行：

```tsx
// TaskHistorySidebar.tsx 中 conv-item 改造
<button
  type="button"
  className="conv-item"
  data-active={task.id === activeTaskId}
  onClick={() => onSelectTask(task)}
  title={task.goal}
>
  <span className="conv-status-dot" data-status={task.status} aria-hidden="true" />
  <span className="conv-copy">
    <span className="conv-title">{task.goal}</span>
    {/* 新增：上下文摘要 */}
    {(task.artifacts?.length || task.budgetUsage?.toolCalls) ? (
      <span className="conv-summary">
        {task.artifacts?.length ? (
          <span className="conv-summary-chip">
            📄 {task.artifacts.length} 产物
          </span>
        ) : null}
        {task.budgetUsage?.toolCalls ? (
          <span className="conv-summary-chip">
            ⚙ {task.budgetUsage.toolCalls} 工具
          </span>
        ) : null}
      </span>
    ) : null}
    <span className="conv-meta">
      <span>{getStatusLabel(task.status)}</span>
      <span>{getRelativeTime(task.updatedAt)}</span>
    </span>
  </span>
</button>
```

#### 5.3 对应 CSS

```css
.conv-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.conv-summary {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.conv-summary-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--text-tertiary);
  font-size: calc(11px * var(--font-scale));
  font-weight: 500;
}
```

---

### 六、P1-2：顶部信息精简——开发向信息迁至 Inspector

#### 6.1 设计思路

当前主对话区顶部（`RunSummaryPanel`）展示的信息维度太多：

- Agent 工作流标签 + 执行轨迹标题 → 保留但简化
- 进度条 → 保留
- `BudgetBar`（工具调用数 + 输出字节数）→ 迁移到 Inspector
- `PlanCard` → 保留但默认折叠

Topbar 中的消息数（"8 条消息"）→ 迁移到 Inspector 的任务上下文 section。

#### 6.2 Conversation.tsx 改动

`RunSummaryPanel` 移除 `BudgetBar`：

```tsx
function RunSummaryPanel({
  task,
  plan,
  status,
  phase,
}: {
  task: Task;
  plan: PlanStep[];
  status: TaskStatus | null;
  phase: TaskPhase | null;
}) {
  const done = plan.filter((step) => step.status === "completed").length;

  return (
    <section className="run-summary" aria-label="Agent 执行摘要">
      <div className="run-summary-head">
        <div>
          <p className="run-summary-eyebrow">执行完成</p>
          <h2>{done}/{plan.length} 步骤</h2>
        </div>
        <StatusPill status={status} phase={phase} />
      </div>
      <div className="run-summary-progress" aria-label={`已完成 ${done} / ${plan.length}`}>
        <span style={{ width: `${plan.length ? (done / plan.length) * 100 : 0}%` }} />
      </div>
      {/* BudgetBar 已迁至 Inspector */}
      <PlanCard plan={plan} defaultOpen={false} />
    </section>
  );
}
```

#### 6.3 InspectorPanel.tsx 增强

在"任务上下文" section 中增加 `BudgetBar` 和消息数：

```tsx
// InspectorPanel.tsx 任务上下文 section 扩展
<section className="inspector-section">
  <p className="inspector-label">任务上下文</p>
  <dl className="meta-list">
    <div>
      <dt>当前任务</dt>
      <dd>{task ? task.goal : "未选择"}</dd>
    </div>
    <div>
      <dt>消息数</dt>
      <dd>{task?.messages.length ?? 0}</dd>
    </div>
    <div>
      <dt>当前阶段</dt>
      <dd>{getPhaseLabel(phase ?? task?.phase ?? null) || "未开始"}</dd>
    </div>
    <div>
      <dt>Token</dt>
      <dd>{formatTokenUsage(task)}</dd>
    </div>
    <div>
      <dt>预算</dt>
      <dd>{formatBudgetUsage(task)}</dd>
    </div>
    <div>
      <dt>引擎版本</dt>
      <dd>{health ? health.version : "未连接"}</dd>
    </div>
    <div>
      <dt>运行时长</dt>
      <dd>{health ? `${Math.round(health.uptimeMs / 1000)} 秒` : "未连接"}</dd>
    </div>
  </dl>
  {/* 新增：预算使用可视化（从主对话区迁入） */}
  {task && <InspectorBudgetBar task={task} />}
</section>
```

新增 `InspectorBudgetBar` 子组件（样式独立于对话区的 BudgetBar）：

```tsx
function InspectorBudgetBar({ task }: { task: Task }) {
  const usage = task.budgetUsage;
  const budget = task.budget;
  if (!usage && !budget) return null;
  const toolLimit = budget?.maxToolCalls ?? 80;
  const outputLimit = budget?.maxOutputBytes ?? 1024 * 1024;
  const toolRatio = Math.min(100, ((usage?.toolCalls ?? 0) / toolLimit) * 100);
  const outputRatio = Math.min(100, ((usage?.outputBytes ?? 0) / outputLimit) * 100);

  return (
    <div className="inspector-budget">
      <div className="inspector-budget-row">
        <span>工具调用</span>
        <strong>{usage?.toolCalls ?? 0} / {toolLimit}</strong>
        <div className="inspector-budget-track">
          <span style={{ width: `${toolRatio}%` }} />
        </div>
      </div>
      <div className="inspector-budget-row">
        <span>输出字节</span>
        <strong>{formatBytes(usage?.outputBytes ?? 0)} / {formatBytes(outputLimit)}</strong>
        <div className="inspector-budget-track">
          <span style={{ width: `${outputRatio}%` }} />
        </div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}
```

#### 6.4 对应 CSS

```css
/* Inspector 内的预算条 */
.inspector-budget {
  display: flex;
  flex-direction: column;
  gap: var(--ui-space-3);
  margin-top: var(--ui-space-3);
  padding-top: var(--ui-space-3);
  border-top: 1px solid var(--border);
}

.inspector-budget-row {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 8px;
  align-items: center;
  font-size: var(--ui-font-xs);
  color: var(--text-secondary);
}

.inspector-budget-row strong {
  text-align: right;
  color: var(--text);
  font-weight: 600;
}

.inspector-budget-track {
  grid-column: 1 / -1;
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--surface-strong);
}

.inspector-budget-track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width 0.3s ease;
}
```

---

### 七、P2-1：Markdown 渲染升级

#### 7.1 当前问题

`MarkdownRenderer.tsx` 是手写的行级解析器（~120 行），存在以下不足：

- 不支持有序列表（`1. item`）、表格、引用块（`> text`）
- 不支持嵌套格式（如粗体中的链接）
- Heading 字号（20px/17px/15px）不跟随 `--font-scale`
- 代码块无语法高亮

#### 7.2 方案

替换为 `marked` 库 + `highlight.js`：

```bash
npm install marked marked-highlight highlight.js
npm install -D @types/marked
```

> **注意：** `marked` v5+ 移除了 `setOptions({ highlight })` 回调，需使用 `marked-highlight` 扩展包注册语法高亮能力。

新的 `MarkdownRenderer.tsx`：

```tsx
import { useMemo } from "react";
import { marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js/lib/core";
// 按需引入常用语言
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import css from "highlight.js/lib/languages/css";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("css", css);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);

// 使用 marked-highlight 扩展注册语法高亮（兼容 marked v5+）
marked.use(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code: string, lang: string) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  })
);

// 启用 GFM
marked.use({ gfm: true, breaks: false });

export function MarkdownRenderer({ content }: { content: string }) {
  const html = useMemo(() => {
    try {
      // marked.use() 注册后 parse() 同步返回 string
      return marked.parse(content) as string;
    } catch {
      return `<p>${content}</p>`;
    }
  }, [content]);

  return (
    <div
      className="markdown-body"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
```

#### 7.3 CSS 调整

需要增加 heading 的 `font-scale` 跟随，以及引用块、表格样式：

```css
.markdown-body h1 { font-size: calc(20px * var(--font-scale)); }
.markdown-body h2 { font-size: calc(17px * var(--font-scale)); }
.markdown-body h3 { font-size: calc(15px * var(--font-scale)); }

.markdown-body blockquote {
  margin: 0;
  padding: var(--ui-space-2) var(--ui-space-4);
  border-left: 3px solid var(--border-strong);
  color: var(--text-secondary);
}

.markdown-body table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--ui-font-sm);
}

.markdown-body th,
.markdown-body td {
  padding: var(--ui-space-2) var(--ui-space-3);
  border: 1px solid var(--border);
  text-align: left;
}

.markdown-body th {
  background: var(--surface);
  font-weight: 650;
}

.markdown-body ol {
  padding-left: 1.5em;
  margin: 0;
}

.markdown-body img {
  max-width: 100%;
  border-radius: var(--ui-radius-md);
}

/* highlight.js 主题适配（暗色模式自动跟随） */
.markdown-body pre code.hljs {
  background: var(--surface);
  color: var(--text);
  padding: var(--ui-space-3);
  border-radius: var(--ui-radius-md);
}
```

---

### 八、P2-2：无障碍补全

#### 8.1 全局 focus-visible 样式

```css
/* 全局键盘焦点样式 */
:focus-visible {
  outline: 2px solid var(--accent-soft-fg);
  outline-offset: 2px;
}

/* 按钮和输入框的焦点样式 */
button:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible {
  outline: 2px solid var(--accent-soft-fg);
  outline-offset: 1px;
  border-radius: inherit;
}

/* 对话项的焦点样式 */
.conv-item:focus-visible {
  outline: 2px solid var(--accent-soft-fg);
  outline-offset: -2px;
}
```

#### 8.2 侧边栏键盘导航

为 `conv-list` 添加方向键导航：

```tsx
// TaskHistorySidebar.tsx 中 conv-list 改造
<ul
  className="conv-list"
  role="listbox"
  aria-label="对话列表"
  onKeyDown={(event) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".conv-item"));
    const current = document.activeElement;
    const index = items.indexOf(current as HTMLButtonElement);
    if (index === -1) return;

    if (event.key === "ArrowDown" && index < items.length - 1) {
      event.preventDefault();
      items[index + 1].focus();
    } else if (event.key === "ArrowUp" && index > 0) {
      event.preventDefault();
      items[index - 1].focus();
    }
  }}
>
  {visibleTasks.map((task) => (
    <li key={task.id} role="option" aria-selected={task.id === activeTaskId}>
      <button type="button" className="conv-item" ...>
        ...
      </button>
    </li>
  ))}
</ul>
```

#### 8.3 Composer 发送按钮禁用原因提示

```tsx
// Composer.tsx 发送按钮增加 tooltip
<button
  type="button"
  className="composer-send"
  disabled={busy ? !onStop : !canSend}
  onClick={busy ? onStop : onSubmit}
  aria-label={busy ? "停止" : "发送"}
  title={
    busy
      ? "停止生成"
      : !value.trim()
        ? "输入内容后可发送"
        : online === false
          ? "引擎离线，无法发送"
          : !providerConfigured
            ? "请先配置 LLM 模型"
            : "发送 (Enter)"
  }
>
  {busy ? <StopDot /> : <ArrowUpIcon />}
</button>
```

---

### 九、实施路径

#### Phase 1（1-2 天）：视觉层次 + 信息精简

1. 改造 `ToolActivityList`，引入 `ToolChip` 紧凑态
2. 从 `RunSummaryPanel` 移除 `BudgetBar`
3. 在 `InspectorPanel` 中增加 `InspectorBudgetBar`
4. 更新 CSS（tool-chip、inspector-budget 样式）

改动文件：`Conversation.tsx`、`InspectorPanel.tsx`、`App.css`

#### Phase 2（2-3 天）：多模式内容区

1. 在 `App.tsx` 中增加 `contentMode` 状态
2. 创建 `ArtifactView.tsx` 组件
3. Topbar 增加模式切换按钮
4. 编写产物视图 CSS

改动文件：`App.tsx`、新增 `ArtifactView.tsx`、`App.css`

#### Phase 3（1-2 天）：侧边栏 + Markdown

1. `TaskHistorySidebar` 增加上下文摘要
2. 安装 `marked` + `highlight.js`，重写 `MarkdownRenderer.tsx`
3. 更新 Markdown 相关 CSS

改动文件：`TaskHistorySidebar.tsx`、`MarkdownRenderer.tsx`、`App.css`、`package.json`（新增 `marked`、`marked-highlight`、`highlight.js`）

#### Phase 4（1 天）：无障碍

1. 添加全局 `:focus-visible` 样式
2. 侧边栏方向键导航
3. Composer 禁用状态 tooltip
4. 测试键盘可达性

改动文件：`App.css`、`TaskHistorySidebar.tsx`、`Composer.tsx`

---

### 十、风险与注意事项

**向后兼容：** 所有改动都是纯 UI 层的，不涉及 `shared` 类型定义或后端 API 变更。`Conversation.tsx` 的 props 接口保持不变，只是内部渲染逻辑调整。

**性能：** `ArtifactView` 采用简单的列表 + 详情布局，无虚拟化需求（产物数量通常 < 20）。`marked` 的解析在 `useMemo` 中缓存，不会导致不必要的重渲染。

**暗色模式：** 所有新增 CSS 均使用 CSS 自定义属性（`var(--border)`、`var(--text-secondary)` 等），暗色模式无需额外处理。`highlight.js` 的主题需要单独适配暗色模式下的语法高亮色值。

**数据依赖：** `ArtifactView` 和侧边栏摘要依赖 `task.artifacts` 和 `task.budgetUsage`，这些字段已存在于 `@aurevoy/shared` 的 `Task` 类型中，无需后端改动。
