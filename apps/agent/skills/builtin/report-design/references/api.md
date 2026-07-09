# report-design 组件 API（按需阅读）

主 SKILL 已覆盖常用组件。仅在需要少用组件或完整属性示例时读本文。  
**不要**读取 `components.js` 源码。

## 常用（速查）

### `report-container`

无属性，包裹整份报告。

### `report-header`

- `badge` `date` `title` `summary`

```html
<report-header badge="技术评估" date="2026-07-04" title="模型接入方案评估" summary="三种路径的风险与成本比较。"></report-header>
```

### `report-section`

- `title`
- slot：`p` / `ul` / `ol` / `blockquote` / `pre>code` / `table` / `img` / 其他 report 组件

### `report-stat-cards` / `report-stat-card`

- grid：`cols` = `2` | `3` | `4`（可省略）
- card：`value` `label`；可选 `change` `direction`=`up`|`down` `accent`

```html
<report-stat-cards>
  <report-stat-card value="3" label="候选方案" accent></report-stat-card>
  <report-stat-card value="2 周" label="预计 POC"></report-stat-card>
</report-stat-cards>
```

### `report-card-grid` / `report-card`

- card：`title`；可选 `badge`；`badge-type`=`success`|`warn`|`info`|`danger`|`default`

```html
<report-card-grid>
  <report-card title="方案 A" badge="推荐" badge-type="success">适合优先落地。</report-card>
  <report-card title="方案 B" badge="备选">预算更高时采用。</report-card>
</report-card-grid>
```

### `report-timeline` / `report-timeline-item`

- item：`date` `title`；`status`=`done`|`active`|空

### `report-score-cell`（放在 `<td>` 内）

- `value`；`level`=`high`|`mid`|`low`

```html
<td><report-score-cell value="8" level="high"></report-score-cell></td>
```

### `report-findings` / `report-finding`

- findings：`title`
- finding：`type`=`fact`|`risk`|`action`

### `report-callout`

- `type`=`info`|`warn`|`success`|`danger`；可选 `title`

### `report-decision`

- `title` + slot 正文

### `report-footer`

无属性；slot 放来源、日期、说明。

---

## 少用组件

### `report-progress` / `report-progress-bar`

- bar：`label`；`value` 0–100；`level`=`high`|`mid`|`low`

### `report-bar-chart` / `report-bar`

- bar：`label`；`value` 比例；`level`=`high`|`mid`|`low`
- slot 文本为显示值

```html
<report-bar label="方案 A" value="30" level="high">3ms</report-bar>
```

### `report-steps` / `report-step`

- step：`num` `title` `desc`；可选 `active`

### `report-pros-cons` / `report-pros` / `report-cons`

- pros/cons：`title`；内部用 `<li>`

### `report-tag`

- `type`=`success`|`warn`|`danger`|`info`|`default`

### `report-accordion` / `report-accordion-item`

- item：`title`；可选 `open`

### `report-tabs` / `report-tab`

- tab：`label`；可选 `active`

### `report-score-matrix`

高级表格容器；多数场景用原生 `<table>` + `report-score-cell` 即可。
