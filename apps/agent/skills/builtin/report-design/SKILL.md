---
name: report-design
description: 按照 Aurevoy 设计系统生成专业 HTML 报告。支持技术报告、设计文档、项目计划、调研报告、会议纪要等。每份报告基于 Web Component 组件库构建——Agent 通过自定义元素填充内容，组件自行处理布局/配色/深色模式/动画，确保输出完全符合设计规范。提供从需求分析、调研、结构规划、HTML 草稿到终稿交付的完整工作流。当用户需要生成可视化报告、设计评审、方案展示或任何需要浏览的文档时使用此技能。
allowed-tools: web_search http_fetch list_directory open_file scroll search_grep get_current_time create_artifact apply_artifact attach_content bundle_report
metadata:
  version: "3.1"
---

# Report Design HTML 报告设计技能

你已加载 HTML 报告设计技能。你能生成符合 Aurevoy 视觉系统的高质量 HTML 报告。

**核心设计**：报告基于 **Web Component 组件库**（`components.js`）构建。
你无需编写 CSS 或复杂 HTML 结构——只需使用自定义元素 + 属性/文本填充内容。
组件通过 Shadow DOM 封装样式，自动适配 Light/Dark 双模式，你无法写出偏离设计规范的界面。

---

## 1. 组件库加载与打包

报告基于 **Web Component 组件库**（`components.js`）构建。你无需编写 CSS 或复杂 HTML 结构——只需使用自定义元素 + 属性/文本填充内容。

最终交付物为**单一自包含 HTML 文件**：在 HTML 草稿中按常规方式引用 `./components.js`（以及本地图片），然后用 **`bundle_report`** 工具自动将脚本、样式、图片内联成单个文件。这样：

- 避免浏览器通过 `file://` 打开时拦截本地脚本/图片
- 报告可单独复制、邮件发送、上传分享
- 你无需把 `components.js` 的代码粘贴进 HTML，大幅节省 token

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>报告标题</title>
<!-- 常规引用即可，bundle_report 会自动内联 -->
<script src="./components.js"></script>
</head>
<body style="background:var(--surface, #f8f8f8); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif; padding:32px 24px; margin:0">
```

组件库通过 CSS 自定义属性适配深色模式。所有组件自动响应 `prefers-color-scheme`，并包含淡入、上浮、进度条填充等微动画（尊重 `prefers-reduced-motion`）。

**图片**：如需插入本地图片，使用相对路径 `<img src="./diagram.png">`，`bundle_report` 会自动 base64 编码内联。外部 URL 图片保持原样。

---

## 2. 组件 API 参考

以下每个组件对应一个自定义元素。你通过 **attributes** 传递数据，通过 **文本内容 / `<slot>`** 填充富文本。

### 2.1 页面容器 `<report-container>`

| Attribute | 说明 |
|-----------|------|
| — | 无属性。包裹整个报告内容 |

```html
<report-container>
  <!-- 所有报告内容放在这里 -->
</report-container>
```

### 2.2 报告头部 `<report-header>`

| Attribute | 类型 | 说明 |
|-----------|------|------|
| `badge` | string | 报告类型徽章文字 |
| `date` | string | 日期，格式 YYYY-MM-DD |
| `title` | string | 报告标题 |
| `summary` | string | 一句话摘要 |

```html
<report-header
  badge="技术评估"
  date="2026-06-29"
  title="PostgreSQL 迁移方案评估报告"
  summary="对 3 个候选方案的 5 维度对比评估，推荐方案 A。">
</report-header>
```

### 2.3 章节 `<report-section>`

| Attribute | 说明 |
|-----------|------|
| `title` | 章节标题（可选；也可用原生 `<h2>` 写在 slot 里） |

`<report-section>` 的 slot 内支持原生 HTML：`<p>`, `<ul>`, `<ol>`, `<blockquote>`, `<pre><code>`, `<table>`, `<img>` 以及任何 `<report-*>` 组件。

```html
<report-section title="背景与评估范围">
  <p>本次评估旨在……</p>
  <report-callout type="info" title="评估范围">
    <p>覆盖性能、成本、社区成熟度三个维度，不包含安全合规审计。</p>
  </report-callout>
</report-section>
```

### 2.4 统计卡片 `<report-stat-cards>` + `<report-stat-card>`

**容器** `<report-stat-cards>`:

| Attribute | 说明 |
|-----------|------|
| `cols` | 列数，默认 `auto-fit`（响应式）。可设为 `2`, `3`, `4` |

**卡片** `<report-stat-card>`:

| Attribute | 类型 | 说明 |
|-----------|------|------|
| `value` | string | 数值（如 `"85/100"`, `"$0"`, `"3ms"`） |
| `label` | string | 标签（如 `"综合评分"`, `"月成本"`） |
| `change` | string | 变化说明（可选，如 `"▼ 较方案 B 省 $299/月"`） |
| `direction` | `up` / `down` | 变化方向（可选） |
| `accent` | boolean | 是否高亮（深色背景） |

```html
<report-stat-cards>
  <report-stat-card value="方案 A" label="推荐方案" accent></report-stat-card>
  <report-stat-card value="85/100" label="综合评分"></report-stat-card>
  <report-stat-card value="$0" label="月成本（开源）"
    change="▼ 较方案 B 省 $299/月" direction="down"></report-stat-card>
</report-stat-cards>
```

### 2.5 卡片网格 `<report-card-grid>` + `<report-card>`

**容器** `<report-card-grid>`: 无属性，自动响应式网格。

**卡片** `<report-card>`:

| Attribute | 说明 |
|-----------|------|
| `title` | 卡片标题 |
| `badge` | 徽章文字（可选） |
| `badge-type` | `success` / `warn` / `info` / `danger` / `default` |

```html
<report-card-grid>
  <report-card title="方案 A · 开源" badge="推荐" badge-type="success">
    基于 PostgreSQL 的自建方案，社区活跃，完全可控。
  </report-card>
  <report-card title="方案 B · 云服务" badge="备选" badge-type="default">
    AWS RDS 托管方案，免运维但成本较高。
  </report-card>
  <report-card title="方案 C · 新兴产品" badge="不推荐" badge-type="warn">
    Serverless 架构，弹性好但生态不成熟。
  </report-card>
</report-card-grid>
```

### 2.6 时间线 `<report-timeline>` + `<report-timeline-item>`

**容器** `<report-timeline>`: 无属性。

**条目** `<report-timeline-item>`:

| Attribute | 说明 |
|-----------|------|
| `date` | 时间 / 阶段 |
| `title` | 事件标题 |
| `status` | `done` / `active` / 空（默认）——控制圆点颜色 |

```html
<report-timeline>
  <report-timeline-item date="W1-W2" title="M1：需求确认 & 技术选型" status="done">
    完成需求文档 V1 + 技术评估报告。交付物：PRD、架构设计文档。
  </report-timeline-item>
  <report-timeline-item date="W3-W4" title="M2：原型开发 & 设计评审" status="active">
    前端核心页面原型 + API 接口设计。交付物：可交互原型、API 文档。
  </report-timeline-item>
  <report-timeline-item date="W5-W8" title="M3：核心功能开发">
    全部核心功能实现 + 单元测试覆盖率 > 80%。
  </report-timeline-item>
</report-timeline>
```

### 2.7 评分矩阵 `<report-score-matrix>` + `<report-score-cell>`

用原生 `<table>` + `<report-score-cell>` 构建：

| 元素 | 说明 |
|------|------|
| `<report-score-matrix>` | 容器 |
| `<report-score-cell value="8" level="high">` | 评分单元格 |

`<report-score-cell>` 属性:

| Attribute | 说明 |
|-----------|------|
| `value` | 分数值 |
| `level` | `high`（绿）/ `mid`（黄）/ `low`（红）/ 空 |

```html
<report-section title="综合评分">
  <table>
    <thead><tr><th>维度（权重）</th><th>方案 A</th><th>方案 B</th><th>方案 C</th></tr></thead>
    <tbody>
      <tr><td>性能 (30%)</td>
        <td><report-score-cell value="8" level="high"></report-score-cell></td>
        <td><report-score-cell value="6" level="mid"></report-score-cell></td>
        <td><report-score-cell value="5" level="mid"></report-score-cell></td></tr>
      <tr><td>成本 (25%)</td>
        <td><report-score-cell value="9" level="high"></report-score-cell></td>
        <td><report-score-cell value="5" level="mid"></report-score-cell></td>
        <td><report-score-cell value="8" level="high"></report-score-cell></td></tr>
    </tbody>
    <tfoot><tr><td>加权总分</td>
      <td><report-score-cell value="76" level="high"></report-score-cell></td>
      <td><report-score-cell value="66" level="mid"></report-score-cell></td>
      <td><report-score-cell value="57" level="low"></report-score-cell></td></tr></tfoot>
  </table>
</report-section>
```

### 2.8 进度条 `<report-progress>` + `<report-progress-bar>`

**容器** `<report-progress>`: 无属性。

**进度条** `<report-progress-bar>`:

| Attribute | 说明 |
|-----------|------|
| `label` | 标签 |
| `value` | 百分比数字（0-100） |
| `level` | `high`（绿）/ `mid`（黄）/ `low`（红）/ 空 |

```html
<report-progress>
  <report-progress-bar label="需求分析" value="100" level="high"></report-progress-bar>
  <report-progress-bar label="设计阶段" value="80" level="high"></report-progress-bar>
  <report-progress-bar label="开发实现" value="25" level="mid"></report-progress-bar>
  <report-progress-bar label="测试验证" value="0"></report-progress-bar>
</report-progress>
```

### 2.9 CSS 条形图 `<report-bar-chart>` + `<report-bar>`

**容器** `<report-bar-chart>`: 无属性。

**条形** `<report-bar>`:

| Attribute | 说明 |
|-----------|------|
| `label` | 数据标签 |
| `value` | 数值（0-100 比例，组件自动归一化） |
| `level` | `high` / `mid` / `low` / 空 |
| (slot) | 显示在条内和右侧的文本（如 `"3ms"`） |

```html
<report-bar-chart>
  <report-bar label="方案 A" value="30" level="high">3ms</report-bar>
  <report-bar label="方案 B" value="60" level="mid">6ms</report-bar>
  <report-bar label="方案 C" value="90" level="low">9ms</report-bar>
</report-bar-chart>
```

### 2.10 步骤指示器 `<report-steps>` + `<report-step>`

**容器** `<report-steps>`: 无属性，自动 flex 布局。

**步骤** `<report-step>`:

| Attribute | 说明 |
|-----------|------|
| `num` | 步骤编号 |
| `title` | 步骤标题 |
| `desc` | 步骤描述 |
| `active` | boolean，当前激活步骤 |

```html
<report-steps>
  <report-step num="1" title="POC 验证" desc="W1-W2" active></report-step>
  <report-step num="2" title="数据迁移" desc="W3-W4"></report-step>
  <report-step num="3" title="并行运行" desc="W5-W6"></report-step>
  <report-step num="4" title="完全切换" desc="W7"></report-step>
</report-steps>
```

### 2.11 优劣对比 `<report-pros-cons>` + `<report-pros>` + `<report-cons>`

| 元素 | Attribute | 说明 |
|------|-----------|------|
| `<report-pros-cons>` | — | 双栏容器 |
| `<report-pros>` | `title` | 优势栏（绿底），内含 `<li>` |
| `<report-cons>` | `title` | 劣势栏（红底），内含 `<li>` |

```html
<report-pros-cons>
  <report-pros title="方案 A 优势">
    <li>完全开源，无供应商锁定</li>
    <li>社区活跃，文档丰富</li>
    <li>月成本为零</li>
  </report-pros>
  <report-cons title="方案 A 劣势">
    <li>需要 DBA 运维经验</li>
    <li>高可用需自行搭建</li>
  </report-cons>
</report-pros-cons>
```

### 2.12 标注框 `<report-callout>`

| Attribute | 说明 |
|-----------|------|
| `type` | `info` / `warn` / `success` / `danger` |
| `title` | 框内标题（可选） |

```html
<report-callout type="warn" title="运维风险">
  <p>方案 A 需要至少 1 名有 PostgreSQL 运维经验的工程师。</p>
  <p>缓解措施：安排 2 周培训 + 外部顾问支持。</p>
</report-callout>

<report-callout type="success" title="成本优势">
  <p>三年总拥有成本（TCO）比方案 B 低 62%。</p>
</report-callout>
```

### 2.13 关键发现 `<report-findings>` + `<report-finding>`

| 元素 | Attribute | 说明 |
|------|-----------|------|
| `<report-findings>` | `title` | 容器标题 |
| `<report-finding>` | `type` | `fact`（蓝）/ `risk`（黄）/ `action`（绿） |

```html
<report-findings title="5 项关键发现">
  <report-finding type="fact">PostgreSQL 16 在 OLTP 场景下吞吐量领先 MySQL 30%。</report-finding>
  <report-finding type="risk">团队目前无 DBA，迁移后运维能力是关键瓶颈。</report-finding>
  <report-finding type="action">建议 W1-W2 完成 POC 验证后再做最终决策。</report-finding>
</report-findings>
```

### 2.14 决策卡 `<report-decision>`

| Attribute | 说明 |
|-----------|------|
| `title` | 建议标题 |

```html
<report-decision title="推荐方案 A：PostgreSQL 自建">
  <p>综合评分 76/100，性能领先 2-3×，完全开源且无月成本。</p>
  <p>若团队在 POC 阶段发现运维负担过重，方案 B（RDS）是最佳备选。</p>
</report-decision>
```

### 2.15 标签 `<report-tag>`

内联元素，用于表格或卡片中的状态标记。

| Attribute | 说明 |
|-----------|------|
| `type` | `success` / `warn` / `danger` / `info` / `default` |

```html
<report-tag type="success">已完成</report-tag>
<report-tag type="warn">进行中</report-tag>
<report-tag type="danger">高风险</report-tag>
```

### 2.16 折叠面板 `<report-accordion>` + `<report-accordion-item>`

用于附录、详细数据等可折叠内容。

| 元素 | Attribute | 说明 |
|------|-----------|------|
| `<report-accordion-item>` | `title` | 折叠项标题 |
| `<report-accordion-item>` | `open` | boolean，默认展开 |

```html
<report-accordion>
  <report-accordion-item title="原始性能数据" open>
    <table>…</table>
  </report-accordion-item>
  <report-accordion-item title="术语表">
    <dl><dt>OLTP</dt><dd>Online Transaction Processing</dd></dl>
  </report-accordion-item>
</report-accordion>
```

### 2.17 选项卡 `<report-tabs>` + `<report-tab>`

| 元素 | Attribute | 说明 |
|------|-----------|------|
| `<report-tab>` | `label` | 标签页标题 |
| `<report-tab>` | `active` | boolean，默认激活 |

```html
<report-tabs>
  <report-tab label="按性能" active>
    <p>性能维度的分析内容……</p>
    <report-bar-chart>…</report-bar-chart>
  </report-tab>
  <report-tab label="按成本">
    <p>成本维度的分析内容……</p>
    <report-stat-cards>…</report-stat-cards>
  </report-tab>
  <report-tab label="按安全">
    <p>安全维度的分析内容……</p>
  </report-tab>
</report-tabs>
```

### 2.18 页脚 `<report-footer>`

无属性。slot 内可放来源、日期、页码等。

```html
<report-footer>
  <span>来源：32 份文献 & 4 位专家访谈</span>
  <span>生成日期：2026-06-29</span>
</report-footer>
```

---

## 3. 工作流总览

报告生成分五个严格顺序的阶段。关键阶段用 `create_artifact` 等待用户确认：

```text
需求分析 → 调研搜集 → 结构规划 → HTML 草稿 → 终稿交付
```

---

## 4. 阶段一：需求分析

**目标**：与用户确认报告的核心要素。

### 采集清单

| 要素 | 问题示例 | 目的 |
|------|---------|------|
| 主题 | 报告主题是什么？ | 明确范围 |
| 受众 | 谁看？（开发团队 / 管理层 / 客户） | 决定深度与组件选择 |
| 类型 | 技术评估 / 设计文档 / 项目计划 / 调研 / 会议纪要？ | 决定组件组合 |
| 参考材料 | 是否有现有文档、文件或链接？ | 复用输入 |
| 约束 | 有无特殊章节或必须包含的内容？ | 避免返工 |

- 信息不完整时用 `ask_user` 逐项追问，不猜测。
- 明确完整后用 `create_artifact`（`type: "text"`, `requireConfirmation: true`）输出需求确认摘要，**等待确认后进入阶段二**。

---

## 5. 阶段二：调研搜集

- 参考材料：用 `open_file` + `scroll`、`search_grep`、`list_directory`
- 外部信息：用 `web_search` + `http_fetch`
- 标注来源 URL，禁止虚构
- 用 `create_artifact`（`requireConfirmation: false`）输出调研摘要（仅进度展示，不阻塞）

---

## 6. 阶段三：结构规划

**目标**：确定报告的章节结构和**组件选择**。

### 组件选择指南

| 内容类型 | 推荐组件 |
|---------|---------|
| 关键数字/指标 | `<report-stat-cards>` |
| 并行方案/实体 | `<report-card-grid>` |
| 时间/阶段 | `<report-timeline>` |
| 多维度评分 | 表格 + `<report-score-cell>` |
| 进度/占比 | `<report-progress>` |
| 数值对比 | `<report-bar-chart>` |
| 优劣并列 | `<report-pros-cons>` |
| 重要提醒 | `<report-callout>` |
| 步骤流程 | `<report-steps>` |
| 多视角分析 | `<report-tabs>` |
| 核心结论 | `<report-findings>` |
| 最终建议 | `<report-decision>` |
| 详细附录 | `<report-accordion>` |
| 状态标记 | `<report-tag>` |

用 `create_artifact`（`type: "text"`, `requireConfirmation: true`）输出大纲（含组件标注），**等待确认后进入阶段四**。

---

## 7. 阶段四：HTML 草稿生成

### 7.1 完整模板框架

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>报告标题</title>
<script src="./components.js"></script>
</head>
<body style="background:var(--surface,#f8f8f8);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;padding:32px 24px;margin:0">
<report-container>

  <report-header
    badge="报告"
    date="YYYY-MM-DD"
    title="报告标题"
    summary="一句话概括核心结论或目的。">
  </report-header>

  <!-- 各章节使用 <report-section> 包裹 -->
  <!-- 数据/对比使用组件，不写 CSS -->

  <report-footer>
    <span>来源：N 个</span>
    <span>生成日期：YYYY-MM-DD</span>
  </report-footer>

</report-container>
</body>
</html>
```

> **草稿阶段不要内联 `components.js`**——保持 `<script src="./components.js"></script>` 引用即可。终稿由 `bundle_report` 自动处理，可节省大量 token。

### 7.2 关键规则

1. **只用组件，不写 CSS**：所有样式由组件 Shadow DOM 处理。不要写 `<style>` 标签或 `style=""` 属性。
2. **组件 attributes 传递数据**：数值、标题、状态等通过 attributes 传入。
3. **slot 内容用原生 HTML**：`<p>`, `<ul>`, `<li>`, `<table>`, `<blockquote>`, `<pre><code>` 放在 `<report-section>` 或组件内部。
4. **table 放在 `<report-section>` 内**：表格的斑马纹、边框样式由 `<report-section>` 的 `::slotted(table/td/th)` 规则渲染。
5. **中文为主**，除非用户要求英文。
6. **数据标注来源**：`<blockquote>…来源：<a href="…">…</a></blockquote>`

### 7.3 产物

完整 HTML 用 `create_artifact`（`type: "file"`, `mimeType: "text/html"`, `requireConfirmation: true`）创建。
等待用户确认（`status: "confirmed"`）后进入阶段五。
若返回 `status: "rejected"`，根据反馈调整后重新提交。

---

## 8. 阶段五：终稿交付

### 8.1 写入草稿与依赖

用户确认后：

1. 用 `apply_artifact` 将 HTML 草稿写入 `<workspace>/report/<kebab-title>.html`。
2. 如有本地图片，一并写入 `<workspace>/report/` 目录，HTML 中保持相对引用（如 `<img src="./diagram.png">`）。

> 不需要把 `components.js` 复制到工作区。`bundle_report` 会自动从 skill 目录读取并内联。

### 8.2 打包为单一文件

调用 `bundle_report`：

```
htmlPath: "report/<kebab-title>.html"
```

`bundle_report` 会：

- 自动将 `<script src="./components.js"></script>` 替换为内联脚本
- 将 `<link rel="stylesheet" href="...">` 替换为内联样式
- 将本地 `<img src="...">` 图片 base64 编码为 data URI
- 直接覆盖原 HTML 文件，输出单一自包含报告

### 8.3 最终交付

打包成功后用 `attach_content` 展示文件引用：

```
## HTML 报告生成完成

- **文件路径**：<绝对路径>
- **说明**：报告已打包为单一自包含 HTML 文件，内联了组件脚本、样式与图片。直接双击或用浏览器打开即可查看，无需额外依赖。
```

---

## 9. 报告类型模板

### 9.1 技术评估报告

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PostgreSQL 迁移方案评估报告</title>
<script src="./components.js"></script>
</head>
<body style="background:var(--surface,#f8f8f8);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;padding:32px 24px;margin:0">
<report-container>

<report-header
  badge="技术评估"
  date="2026-06-29"
  title="PostgreSQL 迁移方案评估报告"
  summary="对 3 个候选方案的 5 维度对比评估，推荐方案 A（PostgreSQL 自建）。">
</report-header>

<!-- 关键结论先置 -->
<report-stat-cards>
  <report-stat-card value="方案 A" label="推荐方案" accent></report-stat-card>
  <report-stat-card value="85/100" label="综合评分"></report-stat-card>
  <report-stat-card value="$0" label="月成本（开源）"
    change="▼ 较方案 B 省 $299/月" direction="down"></report-stat-card>
</report-stat-cards>

<report-section title="背景与评估范围">
  <p>当前系统使用 MySQL 5.7，面临 JSON 查询性能瓶颈和版本升级压力。</p>
  <report-callout type="info" title="评估范围">
    <p>本次评估覆盖性能、成本、社区成熟度三个维度，不包含安全合规审计。</p>
  </report-callout>
</report-section>

<report-section title="候选方案概览">
  <report-card-grid>
    <report-card title="方案 A · PostgreSQL 自建" badge="推荐" badge-type="success">
      基于 PostgreSQL 16 的自建方案，社区活跃，完全可控。
    </report-card>
    <report-card title="方案 B · AWS RDS" badge="备选" badge-type="default">
      AWS RDS for PostgreSQL 托管方案，免运维但成本较高。
    </report-card>
    <report-card title="方案 C · CockroachDB" badge="不推荐" badge-type="warn">
      Serverless 架构，弹性好但生态不成熟。
    </report-card>
  </report-card-grid>
</report-section>

<report-section title="性能评估">
  <p class="table-desc">基准环境：4 vCPU / 16GB RAM，1000 并发连接。读写延迟对比（越低越好）：</p>
  <report-bar-chart>
    <report-bar label="方案 A" value="30" level="high">3ms</report-bar>
    <report-bar label="方案 B" value="60" level="mid">6ms</report-bar>
    <report-bar label="方案 C" value="90" level="low">9ms</report-bar>
  </report-bar-chart>
</report-section>

<report-section title="综合评分">
  <table>
    <thead><tr><th>维度（权重）</th><th>方案 A</th><th>方案 B</th><th>方案 C</th></tr></thead>
    <tbody>
      <tr><td>性能 (30%)</td>
        <td><report-score-cell value="8" level="high"></report-score-cell></td>
        <td><report-score-cell value="6" level="mid"></report-score-cell></td>
        <td><report-score-cell value="5" level="mid"></report-score-cell></td></tr>
      <tr><td>成本 (25%)</td>
        <td><report-score-cell value="9" level="high"></report-score-cell></td>
        <td><report-score-cell value="5" level="mid"></report-score-cell></td>
        <td><report-score-cell value="8" level="high"></report-score-cell></td></tr>
      <tr><td>成熟度 (20%)</td>
        <td><report-score-cell value="9" level="high"></report-score-cell></td>
        <td><report-score-cell value="8" level="high"></report-score-cell></td>
        <td><report-score-cell value="3" level="low"></report-score-cell></td></tr>
      <tr><td>运维复杂度 (15%)</td>
        <td><report-score-cell value="5" level="mid"></report-score-cell></td>
        <td><report-score-cell value="8" level="high"></report-score-cell></td>
        <td><report-score-cell value="7" level="mid"></report-score-cell></td></tr>
      <tr><td>可扩展性 (10%)</td>
        <td><report-score-cell value="6" level="mid"></report-score-cell></td>
        <td><report-score-cell value="7" level="mid"></report-score-cell></td>
        <td><report-score-cell value="8" level="high"></report-score-cell></td></tr>
    </tbody>
    <tfoot><tr><td>加权总分</td>
      <td><report-score-cell value="76" level="high"></report-score-cell></td>
      <td><report-score-cell value="66" level="mid"></report-score-cell></td>
      <td><report-score-cell value="57" level="low"></report-score-cell></td></tr></tfoot>
  </table>
</report-section>

<report-section title="优劣分析">
  <report-pros-cons>
    <report-pros title="方案 A 优势">
      <li>完全开源，无供应商锁定</li>
      <li>社区活跃，文档丰富</li>
      <li>月成本为零（现有基础设施）</li>
    </report-pros>
    <report-cons title="方案 A 劣势">
      <li>需要 DBA 运维经验</li>
      <li>高可用需自行搭建</li>
      <li>升级需停机窗口</li>
    </report-cons>
  </report-pros-cons>
</report-section>

<report-section title="迁移路径">
  <report-steps>
    <report-step num="1" title="POC 验证" desc="W1-W2 · 性能基准测试" active></report-step>
    <report-step num="2" title="数据迁移" desc="W3-W4 · pgloader 灰度迁移"></report-step>
    <report-step num="3" title="并行运行" desc="W5-W6 · 双写验证一致性"></report-step>
    <report-step num="4" title="完全切换" desc="W7 · 下线旧方案"></report-step>
  </report-steps>
</report-section>

<report-section title="风险与缓解">
  <report-callout type="warn" title="运维风险">
    <p>方案 A 需要至少 1 名有 PostgreSQL 运维经验的工程师。缓解措施：安排 2 周培训 + 外部顾问支持。</p>
  </report-callout>
  <report-callout type="danger" title="数据迁移风险">
    <p>从 MySQL 迁移到 PostgreSQL 涉及 schema 转换。缓解措施：使用 pgloader 工具 + 灰度迁移策略。</p>
  </report-callout>
</report-section>

<report-section title="建议">
  <report-decision title="推荐方案 A：PostgreSQL 自建">
    <p>综合评分 76/100，性能领先 2-3×，完全开源且无月成本。主要代价是需要 DBA 运维能力，但通过培训和顾问可在 2 周内补齐。</p>
    <p>若团队在 POC 阶段发现运维负担过重，方案 B（RDS）是最佳备选，成本增加 $299/月但免运维。</p>
  </report-decision>
</report-section>

<report-footer>
  <span>来源：PostgreSQL 官方文档 · AWS RDS Pricing · DB-Engines Ranking</span>
  <span>生成日期：2026-06-29</span>
</report-footer>

</report-container>
</body>
</html>
```

### 9.2 项目计划

**核心组件**：`<report-stat-cards>`（工期/团队）+ `<report-progress>`（进度）+ `<report-timeline>`（里程碑）+ `<report-callout>`（风险）+ 表格（任务分解）。

### 9.3 调研报告

**核心组件**：`<report-stat-cards>`（来源/发现统计）+ `<report-card-grid>`（市场格局）+ `<report-findings>`（关键发现）+ `<report-score-matrix>`（竞品对比）+ `<report-decision>`（建议）。

### 9.4 会议纪要

**核心组件**：`<report-stat-cards>`（决定/行动项计数）+ `<report-callout>`（讨论摘要/决定）+ `<report-tag>`（行动项状态）+ `<report-accordion>`（详细讨论）。

### 9.5 设计文档

**核心组件**：`<report-stat-cards>`（关键指标）+ `<report-card-grid>`（方案卡片）+ `<report-score-matrix>`（评分）+ `<report-pros-cons>`（优劣）+ `<report-steps>`（实现路径）+ `<report-decision>`（推荐）。

---

## 10. 最终检查清单

- [ ] `<!DOCTYPE html>` + `<meta charset>` + `<meta viewport>`
- [ ] HTML 草稿使用 `<script src="./components.js"></script>` 引用组件库
- [ ] 所有内容包裹在 `<report-container>` 内
- [ ] 报告头部 `<report-header>` 完整（badge, date, title, summary）
- [ ] **无 `<style>` 标签和 `style=""` 属性**——组件处理所有样式
- [ ] **关键数字使用了 `<report-stat-cards>`**
- [ ] **方案对比使用了 `<report-score-cell>` 评分矩阵**
- [ ] **进度数据使用了 `<report-progress>`**
- [ ] **时间事件使用了 `<report-timeline>`**
- [ ] 数据/引用有来源标注
- [ ] 无虚构引用或编造数据
- [ ] HTML 语法正确、标签闭合
- [ ] 用户已通过 `create_artifact` 确认草稿（`status: "confirmed"`）
- [ ] 已调用 `bundle_report` 打包为单一自包含 HTML：`<workspace>/report/<name>.html`
