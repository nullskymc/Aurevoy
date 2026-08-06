#!/usr/bin/env node

/**
 * 发布前的确定性审计门。
 *
 * 默认审计源码版本与锁文件；传入 --artifacts 后再检查待发布目录，
 * 传入 --updater-manifest 时检查 latest.json 的版本、平台、签名和 URL。
 * 该脚本不替代平台签名工具，但会在进入签名/上传前阻止明显的版本漂移、
 * 敏感文件和 source map 泄漏。
 */

import { readFileSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PACKAGE_FILES = [
  "package.json",
  "packages/shared/package.json",
  "packages/web-ui/package.json",
  "apps/agent/package.json",
  "apps/desktop/package.json",
];

const args = process.argv.slice(2);
const expectedVersion = readOption("--version") ?? readJson(join(ROOT, "package.json")).version;
const artifactRoot = readOption("--artifacts");
const manifestPath = readOption("--manifest");
const updaterManifestPath = readOption("--updater-manifest");
const failures = [];
const warnings = [];
const checks = [];

function readOption(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function pass(id, detail) {
  checks.push({ id, status: "ok", detail });
}

function fail(id, detail) {
  failures.push({ id, detail });
  checks.push({ id, status: "error", detail });
}

function warn(id, detail) {
  warnings.push({ id, detail });
  checks.push({ id, status: "warning", detail });
}

function checkPackageVersions() {
  for (const relativePath of PACKAGE_FILES) {
    const path = join(ROOT, relativePath);
    const pkg = readJson(path);
    if (pkg.version !== expectedVersion) {
      fail("package-version", `${relativePath}: ${pkg.version ?? "missing"} != ${expectedVersion}`);
    } else {
      pass(`package-version:${relativePath}`, expectedVersion);
    }
  }

  const lock = readJson(join(ROOT, "package-lock.json"));
  if (lock.version !== expectedVersion) fail("lock-root-version", `${lock.version} != ${expectedVersion}`);
  else pass("lock-root-version", expectedVersion);
  for (const relativePath of ["", "apps/agent", "apps/desktop", "packages/shared", "packages/web-ui"]) {
    const entry = lock.packages?.[relativePath];
    if (!entry) {
      fail("lock-workspace-entry", `package-lock.json 缺少 workspace entry: ${relativePath || "."}`);
    } else if (entry.version !== expectedVersion) {
      fail("lock-workspace-version", `${relativePath || "."}: ${entry.version ?? "missing"} != ${expectedVersion}`);
    } else {
      pass(`lock-workspace-version:${relativePath || "."}`, expectedVersion);
    }
  }

  const tauri = readJson(join(ROOT, "apps/desktop/src-tauri/tauri.conf.json"));
  if (tauri.version !== expectedVersion) fail("tauri-version", `${tauri.version ?? "missing"} != ${expectedVersion}`);
  else pass("tauri-version", expectedVersion);
}

async function collectFiles(root) {
  const result = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else result.push(path);
    }
  }
  await walk(root);
  return result;
}

async function auditArtifacts(root) {
  const rootPath = resolve(ROOT, root);
  let info;
  try {
    info = await stat(rootPath);
  } catch {
    fail("artifact-root", `产物目录不存在: ${root}`);
    return;
  }
  if (!info.isDirectory()) {
    fail("artifact-root", `产物路径不是目录: ${root}`);
    return;
  }

  const files = await collectFiles(rootPath);
  const manifest = [];
  for (const path of files) {
    const name = relative(rootPath, path);
    const lower = name.toLowerCase();
    if (/(^|[/\\])(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\.json)?|secrets?)(?:$|[.])/.test(lower)) {
      fail("artifact-sensitive-file", name);
    }
    if (lower.endsWith(".map")) fail("artifact-source-map", name);

    const bytes = await readFile(path);
    manifest.push({ path: name, bytes: bytes.byteLength });
    // 只扫描 UTF-8 文本，避免把二进制误判为密钥；模式是高置信度门禁。
    if (bytes.byteLength <= 5 * 1024 * 1024) {
      const text = bytes.toString("utf8");
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
        fail("artifact-private-key", name);
      }
      if (/(?:sk-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,}|ghp_[A-Za-z0-9]{30,})/.test(text)) {
        fail("artifact-api-key-pattern", name);
      }
    } else {
      warn("artifact-large-file", `${name}: ${bytes.byteLength} bytes`);
    }
  }
  pass("artifact-scan", `${manifest.length} files`);
  return manifest;
}

/** 生成可审计的锁文件依赖清单；不执行网络请求，也不把凭证写入清单。 */
async function auditDependencies() {
  const lockPath = join(ROOT, "package-lock.json");
  const lock = readJson(lockPath);
  if (lock.lockfileVersion !== 3) {
    fail("lockfile-version", `package-lock.json lockfileVersion=${String(lock.lockfileVersion)}，预期为 3`);
  } else {
    pass("lockfile-version", "3");
  }
  const entries = [];
  for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
    if (!packagePath || entry?.link) continue;
    const packageName = packagePath.replace(/^node_modules\//, "");
    let license = "NOASSERTION";
    let licenseSource = "missing";
    let packageInstalled = false;
    const packageDir = join(ROOT, packagePath);
    try {
      const packageJson = readJson(join(packageDir, "package.json"));
      packageInstalled = true;
      license = typeof packageJson.license === "string"
        ? packageJson.license
        : Array.isArray(packageJson.licenses)
          ? packageJson.licenses.map((item) => typeof item === "string" ? item : item?.type).filter(Boolean).join(" OR ") || "NOASSERTION"
          : "NOASSERTION";
      if (license !== "NOASSERTION") licenseSource = "package.json";
    } catch {
      // npm ci 可能只留下 lockfile；锁文件本身仍可用于复现安装。
    }
    if (license === "NOASSERTION") {
      for (const filename of ["LICENSE", "license", "LICENSE.md", "license.md", "COPYING"]) {
        try {
          const text = (await readFile(join(packageDir, filename), "utf8")).slice(0, 4096);
          const match = text.match(/\b(MIT|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|ISC|MPL-2\.0)\b/i);
          if (match) {
            license = match[1].toUpperCase() === "MIT" ? "MIT" : match[1];
            licenseSource = filename;
            break;
          }
        } catch {
          // 当前平台未安装的 optional package 没有可读取的 package 目录。
        }
      }
    }
    if (license === "NOASSERTION" && entry.optional === true && !packageInstalled) {
      license = "NOT_INSTALLED";
      licenseSource = "lockfile-optional-not-installed";
    }
    entries.push({
      path: packagePath,
      name: packageName,
      version: entry.version ?? null,
      license,
      licenseSource,
      resolved: entry.resolved ?? null,
      integrity: entry.integrity ?? null,
      dev: entry.dev === true,
      optional: entry.optional === true,
    });
  }
  if (entries.length === 0) fail("dependency-manifest", "package-lock.json 没有可审计依赖条目");
  else pass("dependency-manifest", `${entries.length} packages`);
  const noAssertion = entries.filter((entry) => entry.license === "NOASSERTION").length;
  if (noAssertion > 0) warn("dependency-license", `${noAssertion} packages 未声明可读取的 license；发布前需人工确认`);
  else pass("dependency-license", "all packages declare a license");
  return entries;
}

/** 发布清单必须同时覆盖三平台，并为每个更新包携带签名和当前 tag URL。 */
async function auditUpdaterManifest(path) {
  let payload;
  try {
    payload = JSON.parse(await readFile(resolve(ROOT, path), "utf8"));
  } catch (error) {
    fail("updater-manifest", `${path}: 无法读取或解析 (${error instanceof Error ? error.message : String(error)})`);
    return;
  }
  if (payload.version !== expectedVersion) {
    fail("updater-version", `${payload.version ?? "missing"} != ${expectedVersion}`);
  } else {
    pass("updater-version", expectedVersion);
  }
  const platforms = payload.platforms;
  const required = ["darwin-aarch64", "windows-x86_64", "linux-x86_64"];
  if (!platforms || typeof platforms !== "object") {
    fail("updater-platforms", "latest.json 缺少 platforms 对象");
    return;
  }
  for (const platform of required) {
    const entry = platforms[platform];
    if (!entry || typeof entry !== "object") {
      fail("updater-platform", `${platform} 缺少更新条目`);
      continue;
    }
    if (typeof entry.signature !== "string" || entry.signature.trim().length < 20) {
      fail("updater-signature", `${platform} 缺少有效签名`);
    }
    if (typeof entry.url !== "string" || !entry.url.includes(`/v${expectedVersion}/`)) {
      fail("updater-url", `${platform} URL 未指向 v${expectedVersion}`);
    }
  }
  pass("updater-platforms", required.join(", "));
}

checkPackageVersions();
const dependencyManifest = await auditDependencies();
const manifest = artifactRoot ? await auditArtifacts(artifactRoot) : undefined;
if (updaterManifestPath) await auditUpdaterManifest(updaterManifestPath);
const summary = {
  version: expectedVersion,
  artifactRoot: artifactRoot ?? null,
  checks,
  failures,
  warnings,
  dependencies: dependencyManifest,
  manifest: manifest ?? null,
};

if (manifestPath) {
  await writeFile(resolve(ROOT, manifestPath), JSON.stringify(summary, null, 2) + "\n", "utf8");
}

console.log(JSON.stringify({
  version: expectedVersion,
  checks: checks.length,
  failures: failures.length,
  warnings: warnings.length,
  artifactFiles: manifest?.length ?? 0,
}, null, 2));
if (failures.length > 0) {
  for (const item of failures) console.error(`FAIL ${item.id}: ${item.detail}`);
  process.exit(1);
}
