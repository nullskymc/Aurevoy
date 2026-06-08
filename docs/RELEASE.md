# 发布与跨平台交付 — RELEASE

> 本文记录 M5 后续分发工作的真实门槛。没有证书、sidecar 二进制和更新签名密钥前，
> 不能把“可发布”标记为完成。

## 当前已具备

- `npm run build` 可构建 shared、agent 和 desktop web assets。
- `.github/workflows/ci.yml` 在 Linux、macOS、Windows 上运行 build、typecheck 和 M3-M5 回归。
- Tauri 配置已启用 bundle，当前可用 `npm run tauri:build -w @aurevoy/desktop` 生成本机平台安装包。
- 桌面壳已具备 Agent 子进程托管层：启动时复用已在线的 `127.0.0.1:8787`，
  否则开发期拉起 `npm run dev:agent`，生产期可通过 `AUREVOY_AGENT_SIDECAR` 指向真实 sidecar。

## macOS 打包、签名与公证

交付级 macOS 发布必须满足：

- 有 Apple Developer 账号和有效 Developer ID Application 证书。
- CI 或本机设置 `APPLE_SIGNING_IDENTITY`，或在 Tauri 配置中写入 `bundle.macOS.signingIdentity`。
- 公证时配置 `APPLE_API_ISSUER`、`APPLE_API_KEY`、`APPLE_API_KEY_PATH`
  或 `APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`。
- 发布前确认包内不包含 `.env`、开发 SQLite、临时工作区或本地测试数据。

本地验证命令：

```bash
npm run build
npm run tauri:build -w @aurevoy/desktop -- --bundles dmg
```

## 自动更新

Tauri 2 自动更新需要：

- 安装并初始化 updater plugin。
- 生成 updater signing key，并把公钥写入 `plugins.updater.pubkey`。
- 在 `bundle.createUpdaterArtifacts` 开启更新产物。
- 配置 HTTPS update endpoint，例如 GitHub release 的 `latest.json`。
- Windows 需确认 updater install mode。

在这些条件未满足前，不得在路线图中勾选“自动更新”。

## Agent sidecar

普通用户不应依赖命令行单独启动 `apps/agent`。当前已落地桌面壳托管层：

- `apps/desktop/src-tauri/src/agent_process.rs` 管理 Agent 子进程生命周期；
  应用退出时会关闭由桌面壳启动的子进程。
- 启动逻辑先探测本地引擎端口，已有外部进程在线时复用，避免开发期重复启动。
- 前端通过 Tauri command `ensure_agent_process` 触发托管启动；是否可用仍以
  `/api/health` 真实响应为准。

后续发布级 sidecar 仍需满足：

- 把 Agent 引擎打包成 Tauri sidecar 二进制，按目标 triple 命名并配置 `bundle.externalBin`。
- 设置 `AUREVOY_AGENT_SIDECAR` 或改为从 Tauri resource 目录解析 sidecar 路径。
- sidecar 崩溃后进入可诊断状态，任务恢复仍依赖 M4 的 SQLite 恢复路径。
- macOS/Windows 都要验证 native module（`better-sqlite3`）和路径权限。

## Windows 适配清单

- WebView2 运行时可用。
- `better-sqlite3` 在 Windows CI 上能安装/构建。
- 工作区路径、SQLite 路径、MCP cwd/env 使用跨平台路径。
- Tauri installer、sidecar 命名和权限模型单独验证。
