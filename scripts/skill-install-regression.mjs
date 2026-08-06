#!/usr/bin/env node

/** 通过本机 git-http-backend 验证 Skill 来源确认、路径白名单、元数据和幂等覆盖。 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const { installFromGit, readInstallMetadata } = await import("../apps/agent/dist/skills/installer.js");
const root = await mkdtemp(join(tmpdir(), "aurevoy-skill-install-"));
const sourceDir = join(root, "source");
const bareDir = join(root, "catalog.git");
const targetDir = join(root, "installed");
let server;

try {
  await mkdir(join(sourceDir, "skills/research"), { recursive: true });
  await mkdir(join(sourceDir, "skills/ignored"), { recursive: true });
  await writeFile(
    join(sourceDir, "skills/research/SKILL.md"),
    "---\nname: local-research\ndescription: A deterministic research skill for regression.\n---\n\n# Research\n",
  );
  await writeFile(
    join(sourceDir, "skills/ignored/SKILL.md"),
    "---\nname: local-ignored\ndescription: A second skill that must not be installed without inspection.\n---\n\n# Ignored\n",
  );
  await runGit(sourceDir, ["init", "--initial-branch=main"]);
  await runGit(sourceDir, ["config", "user.email", "regression@aurevoy.local"]);
  await runGit(sourceDir, ["config", "user.name", "Aurevoy Regression"]);
  await runGit(sourceDir, ["add", "."]);
  await runGit(sourceDir, ["commit", "-m", "fixture skill"]);
  await runGit(root, ["clone", "--bare", sourceDir, bareDir]);
  await runGit(root, ["--git-dir", bareDir, "update-server-info"]);

  server = await startGitHttpServer(root);
  const repoUrl = `${server.url}/catalog.git`;
  const inspectionSummary = "已检查 skills/research/SKILL.md，确认 frontmatter 有效且来源为本地回归仓库。";
  const result = await installFromGit(repoUrl, targetDir, {
    expectedSkillPaths: ["skills/research"],
    inspectedSource: `${repoUrl}/tree/main/skills/research/SKILL.md`,
    inspectionSummary,
    requireExpectedPaths: true,
  });

  assert.deepEqual(result.installedSkills, ["local-research"]);
  assert.equal(result.totalFound, 2);
  assert.deepEqual(result.inspectedSkillPaths, ["skills/research"]);
  assert.equal(await exists(join(targetDir, "local-research/SKILL.md")), true);
  assert.equal(await exists(join(targetDir, "local-ignored")), false);
  const metadata = readInstallMetadata(join(targetDir, "local-research"));
  assert.equal(metadata?.repoUrl, repoUrl);
  assert.equal(metadata?.inspectionSummary, inspectionSummary);
  const body = await readFile(join(targetDir, "local-research/SKILL.md"), "utf8");
  assert.match(body, /name: local-research/);

  const second = await installFromGit(repoUrl, targetDir, {
    expectedSkillPaths: ["skills/research/SKILL.md"],
    inspectionSummary,
    requireExpectedPaths: true,
  });
  assert.deepEqual(second.alreadyExisted, ["local-research"]);

  await assert.rejects(
    installFromGit(repoUrl, join(root, "mismatch"), {
      expectedSkillPaths: ["skills/not-inspected"],
      inspectionSummary,
      requireExpectedPaths: true,
    }),
    /未找到调用前确认的 skill 路径/,
  );

  console.log("Skill install regression passed: inspected source + path allowlist + metadata + idempotent reinstall");
} finally {
  if (server) await server.close();
  await rm(root, { recursive: true, force: true });
}

function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} failed: ${stderr}`)));
  });
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function startGitHttpServer(projectRoot) {
  return new Promise((resolve, reject) => {
    const httpServer = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const child = spawn("git", ["http-backend"], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: requestUrl.pathname,
          QUERY_STRING: requestUrl.searchParams.toString(),
          REQUEST_METHOD: request.method ?? "GET",
          CONTENT_TYPE: typeof request.headers["content-type"] === "string" ? request.headers["content-type"] : "",
          CONTENT_LENGTH: typeof request.headers["content-length"] === "string" ? request.headers["content-length"] : "0",
          REMOTE_ADDR: "127.0.0.1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const chunks = [];
      let stderr = "";
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => response.destroy(error));
      child.on("close", () => {
        const payload = Buffer.concat(chunks);
        const separator = payload.indexOf(Buffer.from("\r\n\r\n"));
        const alternate = payload.indexOf(Buffer.from("\n\n"));
        const splitAt = separator >= 0 ? separator : alternate;
        if (splitAt < 0) {
          response.writeHead(500).end(stderr || "git-http-backend returned no headers");
          return;
        }
        const separatorLength = separator >= 0 ? 4 : 2;
        const headerText = payload.subarray(0, splitAt).toString("utf8");
        const body = payload.subarray(splitAt + separatorLength);
        let status = 200;
        const headers = {};
        for (const line of headerText.split(/\r?\n/)) {
          const colon = line.indexOf(":");
          if (colon < 0) continue;
          const name = line.slice(0, colon).trim();
          const value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === "status") {
            status = Number.parseInt(value, 10) || 200;
          } else if (name.toLowerCase() !== "transfer-encoding") {
            headers[name] = value;
          }
        }
        response.writeHead(status, headers).end(body);
      });
      request.pipe(child.stdin);
    });
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        reject(new Error("unable to determine git fixture address"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((closeResolve) => httpServer.close(() => closeResolve())),
      });
    });
  });
}
