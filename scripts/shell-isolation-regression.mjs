import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const strict = process.argv.includes('--strict');
const { detectOsIsolation, prepareIsolatedSpawn } = await import('../apps/agent/dist/sandbox/os-isolation.js');

const status = detectOsIsolation();
console.log(`[shell-isolation] platform=${process.platform} mode=${status.mode} available=${status.available} reason=${status.reason}`);

if (!status.available) {
  const message = '[shell-isolation] 当前环境没有可执行的 OS 级 sandbox；auto 将明确回退为 process。';
  if (strict) throw new Error(`${message} strict 回归失败。`);
  console.log(`${message} 非 strict 回归跳过真实越界写入测试。`);
  process.exit(0);
}

const workspace = await mkdtemp(join(tmpdir(), 'aurevoy-shell-isolation-workspace-'));
const outside = await mkdtemp(join(tmpdir(), 'aurevoy-shell-isolation-outside-'));
const insideFile = join(workspace, 'inside.txt');
const outsideFile = join(outside, 'outside.txt');
const windows = process.platform === 'win32';
const shellProgram = windows ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';
const shellEnvironment = windows
  ? {
      Path: process.env.Path ?? process.env.PATH ?? 'C:\\Windows\\System32;C:\\Windows',
      SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    }
  : { PATH: '/usr/bin:/bin' };
const command = windows
  ? `(echo|set /p=isolated)>${shellQuote(insideFile)} & (echo|set /p=escaped)>${shellQuote(outsideFile)}`
  : `printf isolated > ${shellQuote(insideFile)}; printf escaped > ${shellQuote(outsideFile)}`;
let plan;

try {
  plan = await prepareIsolatedSpawn({
    program: shellProgram,
    args: windows ? ['/d', '/s', '/c', command] : ['-c', command],
    cwd: workspace,
    workspaceRoot: workspace,
    externalPaths: [],
    env: shellEnvironment,
    requested: 'required',
  });
  if (plan.mode !== status.mode) {
    throw new Error(`OS 隔离计划与探测结果不一致：${plan.mode} !== ${status.mode}`);
  }

  const result = await runPlan(plan);
  await expectFileContents(insideFile, 'isolated');
  await expectMissing(outsideFile);
  if (result.code === 0) {
    throw new Error(`[shell-isolation] 越界写入没有让命令失败，输出：${result.output}`);
  }
  console.log(`[shell-isolation] workspace write allowed, outside write denied, exit=${result.code}`);
} finally {
  await plan?.cleanup();
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}

function runPlan(commandPlan) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandPlan.program, commandPlan.args, {
      cwd: workspace,
      shell: false,
      env: commandPlan.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    const timer = setTimeout(() => {
      child.kill(windows ? undefined : 'SIGKILL');
      reject(new Error('[shell-isolation] 命令超过 5 秒未退出'));
    }, 5000);
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

async function expectFileContents(path, expected) {
  const value = await readFile(path, 'utf8');
  if (value !== expected) throw new Error(`文件内容不符合预期：${path}`);
}

async function expectMissing(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`越界文件被创建：${path}`);
}

function shellQuote(value) {
  if (windows) return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
