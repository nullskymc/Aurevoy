#!/usr/bin/env node

/** 在固定物理屏幕尺寸下模拟 Windows 125% / 150% 缩放的布局 smoke。 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const url = option("--url") ?? process.env.AUREVOY_UI_URL;
const outputDir = resolve(option("--out") ?? "/tmp/aurevoy-ui-scale");
const strict = args.includes("--strict");
const physicalViewport = { width: 1280, height: 800 };
const scales = [1.25, 1.5];

if (!url) {
  console.log("UI scale regression skipped: set AUREVOY_UI_URL or pass --url <running web UI URL>.");
  if (strict) process.exit(2);
  process.exit(0);
}

const { default: puppeteer } = await import("puppeteer");
await mkdir(outputDir, { recursive: true });
const executablePath = process.env.AUREVOY_BROWSER_EXECUTABLE?.trim() || undefined;
const browser = await puppeteer.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const samples = [];

try {
  for (const scale of scales) {
    const page = await browser.newPage();
    const cssViewport = {
      width: Math.round(physicalViewport.width / scale),
      height: Math.round(physicalViewport.height / scale),
    };
    await page.setViewport({ ...cssViewport, deviceScaleFactor: scale });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const metrics = await page.evaluate(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const candidates = [...document.querySelectorAll("button, a[href], [role=button], [role=tab], input, select, textarea, h1, h2, h3, label")]
        .filter(visible)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            element,
            rect,
            clipped: element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2,
          };
        });
      const clipped = candidates
        .filter((item) => item.clipped)
        .slice(0, 40)
        .map((item) => ({
          tag: item.element.tagName.toLowerCase(),
          className: typeof item.element.className === "string" ? item.element.className : "",
          label: (item.element.getAttribute("aria-label") || item.element.textContent || "").trim().slice(0, 100),
          width: Math.round(item.rect.width),
          height: Math.round(item.rect.height),
        }));
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        verticalOverflow: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
        clippedInteractiveCount: clipped.length,
        clippedInteractive: clipped,
      };
    });
    samples.push({ scale, physicalViewport, cssViewport, metrics });
    await page.close();
  }
} finally {
  await browser.close();
}

const failures = samples.flatMap((sample) => {
  const issues = [];
  if (sample.metrics.horizontalOverflow) issues.push("horizontalOverflow");
  if (sample.metrics.clippedInteractiveCount > 0) issues.push("clippedInteractive");
  return issues.map((metric) => ({ scale: sample.scale, metric }));
});
const report = {
  generatedAt: new Date().toISOString(),
  url,
  physicalViewport,
  scales,
  samples,
  failures,
};
await writeFile(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputDir, samples: samples.length, failures, report: join(outputDir, "report.json") }, null, 2));
if (failures.length > 0) process.exitCode = 1;

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
