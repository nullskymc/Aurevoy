# UI 截图与性能基线

`scripts/ui-baseline.mjs` 固定 840×560、1280×800、1600×1000 三组 viewport，并分别采样浅色/深色主题。每组会保存截图和 `report.json`，报告包含导航耗时、DOM 节点数、横向溢出、24px 以下的可交互目标、长任务总时长以及应用 `performance.mark` 里记录的 SSE/任务阶段。

```bash
AUREVOY_UI_URL=http://127.0.0.1:5173 npm run ui:baseline -- --out /tmp/aurevoy-ui-baseline
```

在受限 macOS/CI Chromium 中若 CDP 截图调用不可用，可用 `--no-screenshots` 只采样布局和性能指标；这不会伪造截图，也不替代已有截图或平台 smoke：

```bash
npm run ui:baseline -- --no-screenshots --strict --out /tmp/aurevoy-ui-baseline-current \
  --baseline /tmp/aurevoy-ui-baseline-previous/report.json
```

新版本先保存一份报告，后续用 `--baseline` 做同 viewport/theme 的指标比较；默认超过 10% 退化或新出现横向溢出时返回失败：

```bash
npm run ui:baseline -- --strict --out /tmp/aurevoy-ui-baseline-v0.7.0
npm run ui:baseline -- --strict --out /tmp/aurevoy-ui-baseline-current \
  --baseline /tmp/aurevoy-ui-baseline-v0.7.0/report.json
```

没有运行中的 Web UI 时脚本默认跳过；发布或合并门可使用 `--strict` 将缺少 URL 视为失败。该采样不能替代真实 macOS WebView 与 Windows WebView2 smoke，平台 smoke 仍需要在对应 runner/设备中执行。

重点比较：首事件/首 token、窄窗横向溢出、长任务数量、截图中的 Composer/审批/停止入口是否可达。没有基线报告时不宣称性能提升；本地关键指标无合理解释时，冷启动、引擎就绪、首响应和交互耗时不接受超过 10% 的退化。

Windows 缩放 smoke 使用固定 1280×800 物理屏幕，分别以 125%（约 1024×640 CSS px）和 150%（约 853×533 CSS px）采样，检查页面横向溢出和可交互文字/控件裁切：

```bash
npm run audit:ui-scale -- --strict --url http://127.0.0.1:5173 \
  --out /tmp/aurevoy-ui-scale-current
```
