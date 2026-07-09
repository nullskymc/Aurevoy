---
name: report-design
description: 产出单一自包含 HTML 报告（评估/调研/计划/纪要等）。使用 `<report-*>` 组件 + bundle_report 交付。
allowed-tools: web_search web_fetch read open_file scroll grep search_grep glob list_directory write create_file edit edit_lines append_file get_current_time create_artifact apply_artifact attach_content ask_user bundle_report
metadata:
  version: "4.2"
---

# Report Design

交付可打开、可分享的**单一 HTML 报告**，不是聊天里的长文。

## 成本纪律（必守）

1. **禁止** `read` / 打开 skill 目录下的 `components.js`；禁止把组件库贴进对话。`bundle_report` 会从内置路径内联。
2. **一次写完** `report/<kebab-title>.html` 草稿；禁止先空壳再整文件覆盖。
3. 修改只用小范围 `edit` / `edit_lines`；**禁止**为了改一处而整页 `read` 后再全量 `write`。
4. 正文优先：结论、指标、表格、发现；少堆装饰组件。
5. 最终回复**只**给路径 + 一句摘要 + 警告（如有）；不要复述全文。
6. 完整 API / 报告类型模式见 `references/`（仅在不熟悉某组件时 `read` 对应文件）。

## 执行协议

1. **澄清**：主题、受众、材料路径不明时最多问 1 次、≤3 问。日期/风格/章节数可自定。
2. **取材**：文件用 `read`/`grep`/`glob`；外部事实用 `web_search`+`web_fetch`；已有对话则直接写。不编造数字与来源。
3. **大纲**：内部想好即可；仅复杂/高风险决策才用 `create_artifact` 确认。
4. **结构**：标题摘要 → 关键结论/指标 → 背景 → 分析 → 建议/行动 → 来源。
5. **写草稿** → `bundle_report({ htmlPath })` → 检查 warnings → `attach_content`。

## HTML 硬约束

- 路径：`report/<kebab-title>.html`
- 草稿必须有：`<!DOCTYPE html>`、charset、viewport、`<script src="./components.js"></script>`
- 内容只在 `<report-container>`；必有 `<report-header>` 与 `<report-footer>`
- 禁止自定义 `<style>` / 组件级花哨 class；`body` 仅允许背景/字体/padding/margin
- 表格放在 `<report-section>` 内

## 最短模板

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
    <report-header badge="报告" date="YYYY-MM-DD" title="报告标题" summary="一句话结论或目的。"></report-header>

    <report-section title="核心结论">
      <report-findings title="关键发现">
        <report-finding type="fact">事实。</report-finding>
        <report-finding type="risk">风险。</report-finding>
        <report-finding type="action">行动。</report-finding>
      </report-findings>
    </report-section>

    <report-footer>
      <span>来源：…</span>
      <span>生成日期：YYYY-MM-DD</span>
    </report-footer>
  </report-container>
</body>
</html>
```

## 常用组件（优先只用这些）

| 用途 | 标签 | 关键属性 |
|---|---|---|
| 页头 | `report-header` | `badge` `date` `title` `summary` |
| 章节 | `report-section` | `title`；内可放 p/ul/table/img/其他组件 |
| 指标 | `report-stat-cards` > `report-stat-card` | card: `value` `label`；可选 `change` `direction` `accent`；grid: `cols` |
| 方案卡 | `report-card-grid` > `report-card` | `title`；可选 `badge` `badge-type` |
| 时间线 | `report-timeline` > `report-timeline-item` | `date` `title`；`status`=`done`/`active` |
| 评分格 | 原生 `table` + `report-score-cell` | `value`；`level`=`high`/`mid`/`low` |
| 发现 | `report-findings` > `report-finding` | finding `type`=`fact`/`risk`/`action` |
| 提示 | `report-callout` | `type`=`info`/`warn`/`success`/`danger`；可选 `title` |
| 决策 | `report-decision` | `title` + slot 正文 |
| 页脚 | `report-footer` | slot：来源/日期 |

少用组件（进度条、条形图、步骤、优劣势、tag、accordion、tabs 等）见 `references/api.md`。  
报告类型推荐结构见 `references/patterns.md`。

## 交付检查

- [ ] 文件在 `report/` 下，草稿含 `./components.js` 引用（打包后内联）
- [ ] 未读、未粘贴 `components.js`
- [ ] 无自定义样式；事实有来源或标注不确定
- [ ] 已 `bundle_report` 并处理/说明 warnings
- [ ] 已 `attach_content`；最终回复无全文复述
