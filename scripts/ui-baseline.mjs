#!/usr/bin/env node

/**
 * 可复现的 Web UI 截图与性能采样入口。
 *
 * 真实桌面 WebView 仍需通过 macOS/Windows smoke；本脚本负责先固定浏览器
 * viewport、明暗主题和采样字段，避免只凭开发机观感判断回归。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const url = option("--url") ?? process.env.AUREVOY_UI_URL;
const outputDir = resolve(option("--out") ?? "/tmp/aurevoy-ui-baseline");
const strict = args.includes("--strict");
const baselinePath = option("--baseline");
const maxRegression = Number(option("--max-regression") ?? "0.1");
const skipScreenshots = args.includes("--no-screenshots");

if (!url) {
  console.log("UI baseline skipped: set AUREVOY_UI_URL or pass --url <running web UI URL>.");
  if (strict) process.exit(2);
  process.exit(0);
}

const { default: puppeteer } = await import("puppeteer");
await mkdir(outputDir, { recursive: true });

const viewports = [
  { name: "narrow-840x560", width: 840, height: 560 },
  { name: "desktop-1280x800", width: 1280, height: 800 },
  { name: "wide-1600x1000", width: 1600, height: 1000 },
];
const themes = ["light", "dark"];
const executablePath = process.env.AUREVOY_BROWSER_EXECUTABLE?.trim() || undefined;
const browser = await puppeteer.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
  // CI/Linux 容器和部分 macOS 受限环境没有可用的 Chromium sandbox；
  // 调用方仍可通过 AUREVOY_BROWSER_EXECUTABLE 选择已审计的浏览器二进制。
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const samples = [];

try {
  for (const viewport of viewports) {
    for (const theme of themes) {
      const page = await browser.newPage();
      await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
      const startedAt = Date.now();
      // 开发服务器会保持 HMR/WebSocket 连接，不能用 networkidle2 作为采样门；
      // DOMContentLoaded 足以固定布局、截图和同步读取性能指标。
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const screenshot = skipScreenshots ? null : `${viewport.name}-${theme}.png`;
      if (!skipScreenshots) await page.screenshot({ path: join(outputDir, screenshot) });
      const metrics = await page.evaluate(() => {
        const navigation = performance.getEntriesByType("navigation")[0];
        const longTasks = performance.getEntriesByType("longtask");
        const interactiveTargets = [...document.querySelectorAll("button, a[href], [role=button], [role=menuitem], [role=tab]")]
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return {
              element,
              rect,
              hidden: style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0,
            };
          })
          .filter((item) => !item.hidden && (item.rect.width < 24 || item.rect.height < 24))
          .slice(0, 50)
          .map((item) => ({
            tag: item.element.tagName.toLowerCase(),
            className: item.element.className && typeof item.element.className === "string" ? item.element.className : "",
            label: (item.element.getAttribute("aria-label") || item.element.textContent || "").trim().slice(0, 80),
            width: Math.round(item.rect.width),
            height: Math.round(item.rect.height),
          }));
        return {
          navigationMs: navigation && "duration" in navigation ? navigation.duration : null,
          domNodes: document.getElementsByTagName("*").length,
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          longTaskCount: longTasks.length,
          longTaskMs: longTasks.reduce((sum, entry) => sum + entry.duration, 0),
          undersizedInteractiveTargetCount: interactiveTargets.length,
          undersizedInteractiveTargets: interactiveTargets,
          milestones: performance.getEntriesByType("mark")
            .filter((entry) => entry.name.startsWith("aurevoy:"))
            .map((entry) => ({ name: entry.name, startTime: entry.startTime })),
        };
      });
      samples.push({ viewport, theme, screenshot, elapsedMs: Date.now() - startedAt, metrics });
      await page.close();
    }
  }
} finally {
  await browser.close();
}

const report = {
  generatedAt: new Date().toISOString(),
  url,
  viewports,
  themes,
  screenshots: !skipScreenshots,
  samples,
};
if (baselinePath) {
  report.baselineComparison = await compareBaseline(baselinePath, report, maxRegression);
}
await writeFile(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputDir, samples: samples.length, report: join(outputDir, "report.json") }, null, 2));
if (report.baselineComparison?.regressions.length) {
  console.error(`UI baseline regression: ${report.baselineComparison.regressions.length} metric(s) exceeded ${maxRegression * 100}%`);
  process.exitCode = 1;
}

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/** 将同一 viewport/theme 的报告按可比指标对齐，阻止 UI 基线静默退化。 */
async function compareBaseline(path, current, threshold) {
  const baseline = JSON.parse(await readFile(resolve(path), "utf8"));
  const baselineSamples = new Map((baseline.samples ?? []).map((sample) => [sampleKey(sample), sample]));
  const regressions = [];
  const comparisons = [];
  const metrics = ["navigationMs", "elapsedMs", "domNodes", "longTaskMs", "undersizedInteractiveTargetCount"];

  for (const sample of current.samples) {
    const previous = baselineSamples.get(sampleKey(sample));
    if (!previous) continue;
    for (const metric of metrics) {
      const before = previous.metrics?.[metric];
      const after = sample.metrics?.[metric];
      if (typeof before !== "number" || typeof after !== "number" || before <= 0) continue;
      const changeRatio = (after - before) / before;
      const comparison = {
        sample: sampleKey(sample),
        metric,
        before,
        after,
        changeRatio,
      };
      comparisons.push(comparison);
      if (changeRatio > threshold) regressions.push(comparison);
    }
    if (previous.metrics?.horizontalOverflow === false && sample.metrics?.horizontalOverflow === true) {
      regressions.push({ sample: sampleKey(sample), metric: "horizontalOverflow", before: false, after: true });
    }
  }
  return { baselinePath: resolve(path), threshold, comparisons, regressions };
}

function sampleKey(sample) {
  return `${sample.viewport?.name ?? "unknown"}/${sample.theme ?? "unknown"}`;
}
