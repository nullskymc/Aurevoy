#!/usr/bin/env node
/**
 * 从 Release 构建产物生成 Tauri updater 用的 latest.json。
 *
 * 用法:
 *   node scripts/generate-latest-json.mjs \
 *     --artifacts-dir artifacts \
 *     --version 0.6.5 \
 *     --repo nullskymc/Aurevoy \
 *     --out latest.json
 *
 * 识别规则（文件名）:
 *   - *.app.tar.gz (+ .sig)     → darwin-{arch}
 *   - *setup.exe / *.nsis.zip   → windows-x86_64
 *   - *.AppImage                → linux-x86_64
 */
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const out = {
    artifactsDir: "artifacts",
    version: "",
    repo: "nullskymc/Aurevoy",
    out: "latest.json",
    notes: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--artifacts-dir" && next) {
      out.artifactsDir = next;
      i += 1;
    } else if (arg === "--version" && next) {
      out.version = next.replace(/^v/, "");
      i += 1;
    } else if (arg === "--repo" && next) {
      out.repo = next;
      i += 1;
    } else if (arg === "--out" && next) {
      out.out = next;
      i += 1;
    } else if (arg === "--notes" && next) {
      out.notes = next;
      i += 1;
    }
  }
  return out;
}

function walkFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

function detectPlatform(filePath) {
  const base = path.basename(filePath);
  const lower = base.toLowerCase();

  if (lower.endsWith(".app.tar.gz")) {
    if (lower.includes("x86_64") || lower.includes("x64") || lower.includes("amd64")) {
      return "darwin-x86_64";
    }
    // 默认视为 Apple Silicon（当前 CI 仅构建 aarch64）
    return "darwin-aarch64";
  }

  if (
    lower.endsWith("-setup.exe") ||
    lower.endsWith(".nsis.zip") ||
    (lower.endsWith(".exe") && lower.includes("setup"))
  ) {
    return "windows-x86_64";
  }

  if (lower.endsWith(".appimage")) {
    if (lower.includes("aarch64") || lower.includes("arm64")) {
      return "linux-aarch64";
    }
    return "linux-x86_64";
  }

  return null;
}

function readSignature(filePath) {
  const candidates = [`${filePath}.sig`, `${filePath}.sig.txt`];
  for (const sigPath of candidates) {
    if (fs.existsSync(sigPath)) {
      return fs.readFileSync(sigPath, "utf8").trim();
    }
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version) {
    console.error("Missing --version");
    process.exit(1);
  }

  const files = walkFiles(args.artifactsDir);
  const platforms = {};

  for (const filePath of files) {
    if (filePath.endsWith(".sig") || filePath.endsWith(".sig.txt")) continue;
    const platform = detectPlatform(filePath);
    if (!platform) continue;

    const signature = readSignature(filePath);
    if (!signature) {
      console.warn(`Skip ${filePath}: missing .sig`);
      continue;
    }

    const name = path.basename(filePath);
    const tag = `v${args.version}`;
    const url = `https://github.com/${args.repo}/releases/download/${tag}/${encodeURIComponent(name)}`;

    platforms[platform] = { signature, url };
    console.log(`+ ${platform}: ${name}`);
  }

  if (Object.keys(platforms).length === 0) {
    console.error("No updater artifacts found (need signed .app.tar.gz / setup.exe / AppImage)");
    process.exit(1);
  }

  const payload = {
    version: args.version,
    notes: args.notes || `Aurevoy v${args.version}`,
    pub_date: new Date().toISOString(),
    platforms,
  };

  fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${args.out}`);
}

main();
