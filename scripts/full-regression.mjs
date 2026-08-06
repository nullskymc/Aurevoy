#!/usr/bin/env node

/** 发布/合并前完整质量门；每个子命令独立运行，失败立即停止并保留原始退出码。 */
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const commands = [
  ["test"],
  ["run", "typecheck"],
  ["run", "build"],
  ["run", "regression:m3"],
  ["run", "regression:m4"],
  ["run", "regression:m5"],
  ["run", "regression:m6"],
  ["run", "regression:m7"],
  ["run", "regression:m8"],
  ["run", "regression:m9"],
  ["run", "regression:m10"],
  ["run", "regression:auth"],
  ["run", "regression:long-loop"],
  ["run", "regression:process-recovery"],
  ["run", "regression:mcp"],
  ["run", "regression:skill-install"],
  ["run", "regression:shell-isolation"],
  ["run", "regression:browser"],
  ["run", "regression:ui-e2e"],
  ["run", "audit:async-actions"],
  ["run", "eval:agent-usability"],
  ["run", "docs:build"],
  ["run", "audit:release", "--", "--artifacts", "apps/desktop/dist"],
];

for (const args of commands) {
  const label = `${npm} ${args.join(" ")}`;
  console.log(`\n▶ ${label}`);
  const code = await run(npm, args);
  if (code !== 0) {
    console.error(`\n✖ 完整回归在「${label}」失败，退出码 ${code}`);
    process.exit(code || 1);
  }
}

console.log("\n✓ 完整回归通过");

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit", env: process.env });
    child.once("error", () => resolve(1));
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
