#!/usr/bin/env node

/**
 * 真实桌面壳 smoke 入口：启动 Tauri/WKWebView，并通过 macOS Accessibility
 * 检查原生窗口与 WebView 可见控件；它不把 Puppeteer 浏览器测试当作桌面验收。
 * Windows runner 使用 WebView2 子进程、原生窗口句柄和 UI Automation 控件检查。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.cwd();
const strict = process.argv.includes('--strict');
const reportPath = readOption('--report') ?? process.env.AUREVOY_TAURI_SMOKE_REPORT;

if (process.platform === 'win32') {
  await runWindowsWebViewSmoke();
  process.exit(0);
}

if (process.platform !== 'darwin') {
  const message = '[tauri-webview] 当前实现覆盖 macOS WKWebView 和 Windows WebView2；其他平台没有桌面 UI runner。';
  if (strict) {
    await writeSmokeReport({ status: 'failed', platform: process.platform, error: message });
    throw new Error(message);
  }
  await writeSmokeReport({ status: 'skipped', platform: process.platform, reason: message });
  console.log(`${message} 非 macOS 环境跳过。`);
  process.exit(0);
}

const tempRoot = await mkdtemp(join(tmpdir(), 'aurevoy-tauri-webview-'));
const childEnv = {
  ...process.env,
  AUREVOY_DB_PATH: join(tempRoot, 'aurevoy.sqlite'),
  AUREVOY_WORKSPACE_DIR: join(tempRoot, 'workspace'),
  AUREVOY_MCP_SERVERS_JSON: '',
  AUREVOY_EMBEDDING_PROVIDER: 'off',
  AUREVOY_CORS_ORIGINS: 'http://localhost:1420,http://127.0.0.1:1420',
};
let child;
const output = [];

try {
  child = spawn(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'tauri:dev', '-w', '@aurevoy/desktop', '--', '--no-watch'],
    { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' },
  );
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  await waitForDesktopStart(child, output);

  const accessibility = await waitForAccessibilityWindow();
  if (!accessibility.ok) {
    throw new Error(`${accessibility.error}\n${output.join('').slice(-4000)}`);
  }
  const report = {
    status: 'passed',
    platform: process.platform,
    app: accessibility.app,
    window: accessibility.window,
    controls: accessibility.controls,
    assertion: '真实 macOS WKWebView 已创建可见窗口并暴露交互控件',
  };
  console.log(JSON.stringify(report, null, 2));
  await writeSmokeReport(report);
} catch (error) {
  await writeSmokeReport({
    status: 'failed',
    platform: process.platform,
    error: error instanceof Error ? error.message : String(error),
    logs: output.join('').slice(-4000),
  });
  throw error;
} finally {
  await stopProcess(child);
  await rm(tempRoot, { recursive: true, force: true });
}

async function waitForDesktopStart(processHandle, logs) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`[tauri-webview] Tauri 提前退出：${logs.join('').slice(-4000)}`);
    }
    // Cargo 的 ANSI 进度码和 Windows 路径分隔符可能变化，只匹配归一化后的可执行文件路径。
    if (logs.join('').replaceAll('\\', '/').includes('target/debug/desktop')) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`[tauri-webview] 等待 Tauri 启动超时：${logs.join('').slice(-4000)}`);
}

async function waitForAccessibilityWindow() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = spawnSync('osascript', ['-e', accessibilityScript()], {
      encoding: 'utf8',
      timeout: 3000,
    });
    if (result.status === 0 && result.stdout.trim()) {
      const [app, window, buttonCount, textAreaCount] = result.stdout.trim().split('|');
      const controls = { buttonCount: Number(buttonCount), textAreaCount: Number(textAreaCount) };
      // 只发现原生空窗口不算 WebView smoke 通过，必须同时暴露可操作控件。
      if (controls.buttonCount > 0 && controls.textAreaCount > 0) {
        return { ok: true, app, window, controls };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return {
    ok: false,
    error: 'macOS Accessibility 未发现 Aurevoy/desktop 的可见窗口和交互控件；请确认桌面会话、辅助功能权限和 WebView 加载状态。',
  };
}

async function runWindowsWebViewSmoke() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'aurevoy-tauri-webview-'));
  const childEnv = {
    ...process.env,
    AUREVOY_DB_PATH: join(tempRoot, 'aurevoy.sqlite'),
    AUREVOY_WORKSPACE_DIR: join(tempRoot, 'workspace'),
    AUREVOY_MCP_SERVERS_JSON: '',
    AUREVOY_EMBEDDING_PROVIDER: 'off',
    AUREVOY_CORS_ORIGINS: 'http://localhost:1420,http://127.0.0.1:1420',
  };
  let child;
  const output = [];
  try {
    child = spawn('npm.cmd', ['run', 'tauri:dev', '-w', '@aurevoy/desktop', '--', '--no-watch'], {
      cwd: root,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    });
    child.stdout.on('data', (chunk) => output.push(String(chunk)));
    child.stderr.on('data', (chunk) => output.push(String(chunk)));
    await waitForDesktopStart(child, output);

    const automation = await waitForWindowsWebView();
    if (!automation.ok) {
      throw new Error(automation.error + '\n' + output.join('').slice(-4000));
    }
    const report = {
      status: 'passed',
      platform: process.platform,
      process: automation.process,
      windowHandle: automation.windowHandle,
      controls: automation.controls,
      webviewChildren: automation.webviewChildren,
      assertion: '真实 Windows WebView2 已创建可见窗口并暴露 UI Automation 控件',
    };
    console.log(JSON.stringify(report, null, 2));
    await writeSmokeReport(report);
  } catch (error) {
    await writeSmokeReport({
      status: 'failed',
      platform: process.platform,
      error: error instanceof Error ? error.message : String(error),
      logs: output.join('').slice(-4000),
    });
    throw error;
  } finally {
    await stopProcess(child);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function readOption(name) {
  const direct = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function writeSmokeReport(report) {
  if (!reportPath) return;
  // CI 需要保留成功和失败的同一份机器可读证据，不能只依赖控制台日志。
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2)}\n`, 'utf8');
}

async function waitForWindowsWebView() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      windowsAutomationScript(),
    ], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    if (result.status === 0 && result.stdout.trim()) {
      const [processName, windowHandle, buttons, edits, documents, panes, webviewChildren] = result.stdout.trim().split('|');
      const controls = {
        buttonCount: Number(buttons),
        editCount: Number(edits),
        documentCount: Number(documents),
        paneCount: Number(panes),
      };
      const hasInteractiveControls = controls.buttonCount > 0 && controls.editCount > 0;
      const hasContentControls = controls.documentCount > 0 || controls.paneCount > 0;
      if (Number(windowHandle) > 0 && Number(webviewChildren) > 0 && hasInteractiveControls && hasContentControls) {
        return {
          ok: true,
          process: processName,
          windowHandle: Number(windowHandle),
          controls,
          webviewChildren: Number(webviewChildren),
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return {
    ok: false,
    error: 'Windows UI Automation 未发现可见 Aurevoy 窗口、WebView2 子进程和交互控件；请在带桌面会话的 runner 上执行。',
  };
}

function windowsAutomationScript() {
  return String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$processes = Get-Process -Name desktop,Aurevoy -ErrorAction SilentlyContinue
foreach ($process in $processes) {
  if ($process.MainWindowHandle -eq 0) { continue }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
  if ($null -eq $root) { continue }
  $buttonCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button)
  $editCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Edit)
  $documentCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Document)
  $paneCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Pane)
  $buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition).Count
  $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCondition).Count
  $documents = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $documentCondition).Count
  $panes = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $paneCondition).Count
  $webviewChildren = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" | Where-Object { $_.ParentProcessId -eq $process.Id }).Count
  Write-Output "$($process.ProcessName)|$($process.MainWindowHandle.ToInt64())|$buttons|$edits|$documents|$panes|$webviewChildren"
  exit 0
}
`;
}

function accessibilityScript() {
  return `
tell application "System Events"
  set candidates to every process whose name is "desktop" or name is "Aurevoy"
  repeat with candidate in candidates
    set currentProcess to contents of candidate
    if (count of windows of currentProcess) > 0 then
      set currentWindow to window 1 of currentProcess
      return (name of currentProcess as text) & "|" & (name of currentWindow as text) & "|" & (count of buttons of currentWindow as text) & "|" & (count of text areas of currentWindow as text)
    end if
  end repeat
  return ""
end tell`;
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return;
  if (process.platform !== 'win32' && processHandle.pid) {
    try {
      process.kill(-processHandle.pid, 'SIGINT');
    } catch {
      processHandle.kill('SIGINT');
    }
  } else if (process.platform === 'win32' && processHandle.pid) {
    spawnSync('taskkill.exe', ['/PID', String(processHandle.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    processHandle.kill('SIGINT');
  }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (process.platform !== 'win32' && processHandle.pid) {
        try {
          process.kill(-processHandle.pid, 'SIGKILL');
        } catch {
          processHandle.kill('SIGKILL');
        }
      } else {
        processHandle.kill('SIGKILL');
      }
      resolve();
    }, 5000);
    processHandle.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
