---
name: report-design
description: 生成可直接浏览和交付的专业 HTML 报告。适用于技术评估、调研报告、项目计划、设计方案、会议纪要、复盘总结、方案对比和面向管理层的可视化文档。使用内置 Web Component 组件库和 bundle_report 工具产出单一自包含 HTML 文件；必须先理解用户材料和事实来源，再组织结构、写入 HTML、打包交付。
allowed-tools: web_search web_fetch read open_file scroll grep search_grep glob list_directory write create_file edit edit_lines append_file get_current_time create_artifact apply_artifact attach_content ask_user bundle_report
metadata:
  version: "4.1"
---

# Report Design Skill

你已加载 `report-design`。你的目标不是“输出一段好看的 HTML”，而是交付一个可以打开、分享、审阅的单一 HTML 报告文件。

最终交付必须满足：

- 内容基于用户材料、当前事实或明确标注的假设，不编造来源和数字。
- HTML 使用本 skill 的 `<report-*>` Web Components，不自造视觉系统。
- 草稿文件写入工作区，再调用 `bundle_report` 打包为单一自包含 HTML。
- 最终用 `attach_content` 返回文件引用和简短说明。

---

## 1. 执行协议

### 1.1 先判断任务状态

如果用户已经给出明确主题、受众和材料，直接开始，不要例行追问。

只有以下信息会实质影响报告质量时才问用户，最多一次、最多 3 个问题：

- 报告主题或结论目标不清楚。
- 受众不清楚，且会影响深度：管理层、技术团队、客户、个人复盘等。
- 用户要求基于指定材料，但材料路径、链接或文件缺失。

不要为了“形式完整”追问日期、风格、章节数、颜色等非阻塞信息；可自行采用默认值。

### 1.2 读取和调研

根据输入选择最小必要的信息收集方式：

- 用户给了文件或目录：先用 `read` / `open_file` / `grep` / `search_grep` / `glob` / `list_directory` 理解材料。
- 用户给了网页或要求最新事实：用 `web_search` + `web_fetch` 获取来源。
- 用户只要求整理已有对话内容：基于上下文生成，不额外搜索。

事实规则：

- 不要虚构引用、访问日期、论文、价格、评分或性能数据。
- 不确定的数据写成“待确认”或“基于当前材料未发现”。
- 外部事实应在报告中保留来源链接或来源说明。

### 1.3 结构规划

在写 HTML 前先形成内部大纲。只有当主题复杂、用户明确要求先确认、或结论会影响业务决策时，才用 `create_artifact` 提交大纲并等待确认。

默认报告结构：

1. 标题和一句话摘要。
2. 关键结论或核心指标。
3. 背景、范围和约束。
4. 主体分析：对比、时间线、评分、风险、发现。
5. 建议、下一步或行动项。
6. 来源和附录。

### 1.4 写入 HTML 草稿

在工作区创建 `report/<kebab-title>.html`。草稿必须引用组件库：

```html
<script src="./components.js"></script>
```

不要复制 `components.js`；`bundle_report` 会自动从内置 skill 目录读取并内联。

HTML 草稿要求：

- 必须包含 `<!DOCTYPE html>`、`<meta charset>`、`<meta viewport>`。
- 所有报告内容必须放进 `<report-container>`。
- 每份报告必须有 `<report-header>` 和 `<report-footer>`。
- 正文不要写 `<style>`，不要为组件写自定义 class/CSS。
- `body` 只允许使用最小页面壳样式：背景、字体、padding、margin。
- 图片必须有 `alt`，本地图片用相对路径，外部图片保持 URL。
- 表格放在 `<report-section>` 内，由组件样式统一渲染。

### 1.5 打包和交付

HTML 写入后必须调用：

```text
bundle_report({ htmlPath: "report/<kebab-title>.html" })
```

打包成功后：

- 检查 `bundle_report` 的 warnings；有警告必须说明。
- 用 `attach_content` 附上最终 HTML 文件。
- 最终回复只写文件路径、是否有警告、打开方式，不要重复整篇报告内容。

---

## 2. 文件模板

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>报告标题</title>
  <script src="./components.js"></script>
</head>
<body style="background:#f8f8f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;padding:32px 24px;margin:0">
  <report-container>
    <report-header
      badge="报告"
      date="YYYY-MM-DD"
      title="报告标题"
      summary="一句话说明报告结论或目的。">
    </report-header>

    <report-section title="核心结论">
      <report-findings title="关键发现">
        <report-finding type="fact">基于已读取材料形成的事实。</report-finding>
        <report-finding type="risk">需要注意的风险或不确定性。</report-finding>
        <report-finding type="action">建议采取的下一步行动。</report-finding>
      </report-findings>
    </report-section>

    <report-footer>
      <span>来源：用户材料 / 公开资料 / 对话上下文</span>
      <span>生成日期：YYYY-MM-DD</span>
    </report-footer>
  </report-container>
</body>
</html>
```

---

## 3. 组件选择

优先选择能表达信息结构的组件，不要为了“丰富”堆叠组件。

| 内容 | 组件 |
|---|---|
| 标题、摘要、报告类型 | `<report-header>` |
| 章节正文 | `<report-section>` |
| 关键指标、数量、得分 | `<report-stat-cards>` + `<report-stat-card>` |
| 多个对象或方案概览 | `<report-card-grid>` + `<report-card>` |
| 时间、里程碑、事件顺序 | `<report-timeline>` + `<report-timeline-item>` |
| 多维评分 | `<table>` + `<report-score-cell>` |
| 进度、完成度 | `<report-progress>` + `<report-progress-bar>` |
| 数值对比 | `<report-bar-chart>` + `<report-bar>` |
| 流程步骤 | `<report-steps>` + `<report-step>` |
| 优劣势 | `<report-pros-cons>` + `<report-pros>` + `<report-cons>` |
| 风险、提醒、边界 | `<report-callout>` |
| 关键发现 | `<report-findings>` + `<report-finding>` |
| 推荐方案或最终判断 | `<report-decision>` |
| 状态标记 | `<report-tag>` |
| 附录和长材料 | `<report-accordion>` |
| 多视角内容 | `<report-tabs>` |
| 来源、日期、说明 | `<report-footer>` |

---

## 4. 组件 API

### `<report-container>`

包裹整份报告，无属性。

```html
<report-container>...</report-container>
```

### `<report-header>`

属性：

- `badge`: 报告类型。
- `date`: 日期，建议 `YYYY-MM-DD`。
- `title`: 报告标题。
- `summary`: 一句话摘要。

```html
<report-header badge="技术评估" date="2026-07-04" title="模型接入方案评估" summary="对三种接入路径做风险、成本和交付周期比较。"></report-header>
```

### `<report-section>`

属性：

- `title`: 章节标题。

slot 内可放 `<p>`、`<ul>`、`<ol>`、`<blockquote>`、`<pre><code>`、`<table>`、`<img>` 和其他 report 组件。

### `<report-stat-cards>` / `<report-stat-card>`

`report-stat-cards` 属性：

- `cols`: `2` / `3` / `4`，可省略。

`report-stat-card` 属性：

- `value`: 指标值。
- `label`: 指标名。
- `change`: 变化说明，可选。
- `direction`: `up` / `down`，可选。
- `accent`: 高亮卡，可选。

```html
<report-stat-cards>
  <report-stat-card value="3" label="候选方案" accent></report-stat-card>
  <report-stat-card value="2 周" label="预计 POC"></report-stat-card>
</report-stat-cards>
```

### `<report-card-grid>` / `<report-card>`

`report-card` 属性：

- `title`: 卡片标题。
- `badge`: 状态徽章，可选。
- `badge-type`: `success` / `warn` / `info` / `danger` / `default`。

```html
<report-card-grid>
  <report-card title="方案 A" badge="推荐" badge-type="success">适合优先落地。</report-card>
  <report-card title="方案 B" badge="备选" badge-type="default">适合预算更高时采用。</report-card>
</report-card-grid>
```

### `<report-timeline>` / `<report-timeline-item>`

`report-timeline-item` 属性：

- `date`: 时间或阶段。
- `title`: 事件标题。
- `status`: `done` / `active` / 空。

### `<report-score-cell>`

属性：

- `value`: 分数或等级。
- `level`: `high` / `mid` / `low`。

用于原生表格单元格内：

```html
<td><report-score-cell value="8" level="high"></report-score-cell></td>
```

### `<report-progress>` / `<report-progress-bar>`

`report-progress-bar` 属性：

- `label`: 标签。
- `value`: 0-100。
- `level`: `high` / `mid` / `low`。

### `<report-bar-chart>` / `<report-bar>`

`report-bar` 属性：

- `label`: 标签。
- `value`: 数值比例。
- `level`: `high` / `mid` / `low`。

slot 文本显示实际值：

```html
<report-bar label="方案 A" value="30" level="high">3ms</report-bar>
```

### `<report-steps>` / `<report-step>`

`report-step` 属性：

- `num`: 步骤编号。
- `title`: 步骤标题。
- `desc`: 简短说明。
- `active`: 当前步骤，可选。

### `<report-pros-cons>` / `<report-pros>` / `<report-cons>`

`report-pros` 和 `report-cons` 属性：

- `title`: 栏目标题。

内部使用 `<li>`。

### `<report-callout>`

属性：

- `type`: `info` / `warn` / `success` / `danger`。
- `title`: 标题，可选。

### `<report-findings>` / `<report-finding>`

`report-findings` 属性：

- `title`: 容器标题。

`report-finding` 属性：

- `type`: `fact` / `risk` / `action`。

### `<report-decision>`

属性：

- `title`: 决策或建议标题。

### `<report-tag>`

属性：

- `type`: `success` / `warn` / `danger` / `info` / `default`。

### `<report-accordion>` / `<report-accordion-item>`

`report-accordion-item` 属性：

- `title`: 折叠项标题。
- `open`: 默认展开，可选。

### `<report-tabs>` / `<report-tab>`

`report-tab` 属性：

- `label`: 标签名。
- `active`: 默认激活，可选。

### `<report-footer>`

无属性，slot 内放来源、日期、版权或生成说明。

---

## 5. 报告类型模式

### 技术评估

推荐结构：

1. 结论先行：推荐方案、评分、成本/周期。
2. 背景和评估范围。
3. 候选方案概览。
4. 评分矩阵和关键指标。
5. 风险和缓解。
6. 推荐路径和下一步。

推荐组件：`report-stat-cards`、`report-card-grid`、表格 + `report-score-cell`、`report-callout`、`report-decision`。

### 调研报告

推荐结构：

1. 调研问题和范围。
2. 来源和样本量。
3. 关键发现。
4. 市场/竞品/方案对比。
5. 机会、风险、建议。

推荐组件：`report-findings`、`report-card-grid`、`report-bar-chart`、`report-tabs`、`report-decision`。

### 项目计划

推荐结构：

1. 目标和交付物。
2. 里程碑。
3. 任务分解。
4. 资源和风险。
5. 决策点。

推荐组件：`report-timeline`、`report-steps`、`report-progress`、`report-callout`、表格。

### 会议纪要

推荐结构：

1. 会议主题、时间、参与者。
2. 结论和决定。
3. 讨论摘要。
4. 行动项。
5. 待确认问题。

推荐组件：`report-stat-cards`、`report-findings`、`report-tag`、`report-accordion`。

### 设计方案

推荐结构：

1. 设计目标。
2. 用户/业务约束。
3. 方案说明。
4. 取舍分析。
5. 实施路径。
6. 验收标准。

推荐组件：`report-card-grid`、`report-pros-cons`、`report-steps`、`report-decision`。

---

## 6. 质量检查

交付前逐项检查：

- HTML 文件在 `report/` 目录下。
- 草稿中存在 `<script src="./components.js"></script>`，打包后已被内联。
- 没有复制整份 `components.js` 到模型输出或聊天正文。
- 没有自定义 `<style>` 或组件级 `style=""`。
- 关键事实有来源，未知项有标注。
- 图表和评分有含义，不只是装饰。
- 移动端不会依赖固定宽度。
- `bundle_report` 已执行，且 warnings 已处理或说明。
- 最终已用 `attach_content` 返回 HTML 文件。
