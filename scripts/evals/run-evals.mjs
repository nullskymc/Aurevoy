#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreFixtures } from "./scoring.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_DIR = join(ROOT, "scripts", "evals", "fixtures");
const jsonOutput = process.argv.includes("--json");
const baselinePath = option("--baseline");
const writeBaselinePath = option("--write-baseline");

const fixtures = [];
for (const name of (await readdir(FIXTURE_DIR)).filter((item) => item.endsWith(".json")).sort()) {
  const raw = await readFile(join(FIXTURE_DIR, name), "utf8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) fixtures.push(...parsed);
  else fixtures.push(parsed);
}

const results = scoreFixtures(fixtures);
const unexpected = results.filter((result, index) => {
  const expected = fixtures[index]?.expected ?? {};
  return result.passed !== (expected.shouldPass ?? true);
});
const passed = results.filter((result) => result.passed).length;
const total = results.length;
const baseline = baselinePath
  ? JSON.parse(await readFile(resolve(baselinePath), "utf8"))
  : null;
const baselineRegressions = baseline ? compareBaseline(results, baseline.results ?? []) : [];
const report = { generatedAt: new Date().toISOString(), passed, total, unexpected: unexpected.length, results };

if (writeBaselinePath) {
  await writeFile(resolve(writeBaselinePath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

if (jsonOutput) {
  console.log(JSON.stringify({ ...report, baseline: baselinePath ?? null, baselineRegressions }, null, 2));
} else {
  console.log("Aurevoy Agent usability eval\n");
  for (const result of results) {
    const status = result.passed ? "PASS" : "FAIL";
    console.log(
      `${status} ${result.id} · ${result.category} · ${result.score}/${result.maxScore}`
      + ` · interventions=${result.userInterventions}`
      + ` · retries=${result.retries}`
      + ` · dangerous=${result.dangerousSideEffects}`,
    );
    for (const check of result.checks.filter((item) => !item.passed)) {
      console.log(`  - ${check.reason}`);
    }
  }
  console.log(`\n通过: ${passed}/${total}；评测结果偏差: ${unexpected.length}`);
  if (baselinePath) {
    console.log(`基线对比: ${baselineRegressions.length === 0 ? "无回退" : `${baselineRegressions.length} 项回退`}`);
    for (const regression of baselineRegressions) console.log(`  - ${regression}`);
  }
}

if (unexpected.length > 0 || baselineRegressions.length > 0) process.exit(1);

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** 比较固定 fixture 的硬门结果，避免模型或 Agent loop 只回归在成功样例上。 */
function compareBaseline(currentResults, baselineResults) {
  const previous = new Map(baselineResults.map((result) => [result.id, result]));
  const regressions = [];
  for (const current of currentResults) {
    const old = previous.get(current.id);
    if (!old) continue;
    if (current.score < old.score) regressions.push(`${current.id}: score ${old.score} -> ${current.score}`);
    if (current.dangerousSideEffects > old.dangerousSideEffects) {
      regressions.push(`${current.id}: dangerous side effects ${old.dangerousSideEffects} -> ${current.dangerousSideEffects}`);
    }
    if (old.passed && !current.passed) regressions.push(`${current.id}: passed -> failed`);
  }
  return regressions;
}
