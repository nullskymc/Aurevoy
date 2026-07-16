---
description: Aurevoy 桌面端基于 GitHub Releases 的自动更新（Tauri updater）
---

# 自动更新（GitHub Releases）

Aurevoy 桌面端使用 [Tauri updater](https://v2.tauri.app/plugin/updater/)，以 **GitHub Releases 上的 `latest.json`** 作为更新源。

## 用户侧

1. 应用启动约 4 秒后静默检查更新；有新版本时 toast 提示。
2. 打开 **设置 → 常规 → 关于与更新**，可手动 **检查更新** / **下载并安装**。
3. 安装完成后应用会重启。
4. **macOS 二次及以后更新**：安装成功后、重启前会自动对 `.app` 执行 `xattr -cr`，减轻「更新后又提示无法验证 / 已损坏」。**首次**从网上下载仍需用户右键打开或手动 `xattr` 放行一次。

仅桌面壳（Tauri）支持；浏览器开发模式会显示「仅桌面可用」。

## 更新链路

```
GitHub Release (tag vX.Y.Z)
  ├── Aurevoy_*.dmg / *.exe / *.deb / *.AppImage   # 安装包
  ├── Aurevoy.app.tar.gz (+ .sig)                 # macOS 热更新包
  ├── *.exe.sig / *.AppImage.sig                  # 签名
  └── latest.json                                 # updater 清单
          ▲
          │  GET .../releases/latest/download/latest.json
Tauri 客户端 (plugins.updater.endpoints)
```

端点配置在 `apps/desktop/src-tauri/tauri.conf.json`：

```json
"plugins": {
  "updater": {
    "pubkey": "<minisign public key>",
    "endpoints": [
      "https://github.com/nullskymc/Aurevoy/releases/latest/download/latest.json"
    ]
  }
}
```

`releases/latest` **不会**指向 prerelease（版本号含 `-` 时 workflow 会标 prerelease）。

## 维护者：签名密钥

更新包必须用 **minisign** 私钥签名；公钥写在 `tauri.conf.json`，私钥只进 CI Secrets。

### 生成密钥（仅首次 / 轮换时）

```bash
cd apps/desktop
npx tauri signer generate -w ~/.tauri/aurevoy.key
# 或无密码（CI 更简单，安全性略低）:
npx tauri signer generate -w ~/.tauri/aurevoy.key --ci
```

将 **公钥内容** 写入 `tauri.conf.json` → `plugins.updater.pubkey`。  
私钥内容配置为 GitHub Secrets：

| Secret | 说明 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | 私钥文件全文（或路径内容） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 若生成时设了密码则必填，否则可空 |

**丢失私钥 = 无法再给已安装客户端推送可验证更新**，需重新生成密钥并发布强制换钥版本。

### 本地带签名构建

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/aurevoy.key)"
# export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='...'
npm run prepare-desktop-bundle
cd apps/desktop && npx tauri build --bundles dmg
```

未设置私钥时，`createUpdaterArtifacts: true` 会导致 `tauri build` 失败。临时关更新产物：

```bash
npx tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

## 发布流程

1. 版本号对齐：`package.json` / `apps/desktop` / `src-tauri`（当前 monorepo 惯例）。
2. 打 tag：`git tag v0.6.5 && git push origin v0.6.5`
3. `.github/workflows/release.yml`：
   - 多平台 `tauri build`（注入签名密钥）
   - 上传安装包 + updater 产物 + `.sig`
   - `scripts/generate-latest-json.mjs` 生成 `latest.json`
   - `softprops/action-gh-release` 创建 Release

手动触发 `workflow_dispatch` 时，版本取自 `tauri.conf.json`。

## 与 Apple 代码签名的关系

| 层 | 用途 | 状态 |
|---|---|---|
| Tauri updater 签名 | 验证更新包来源（minisign） | **已接入** |
| Apple Developer 签名/公证 | Gatekeeper / 无「未知开发者」提示 | 仍需证书与 Secrets，见 ROADMAP |

无 Apple 签名时自动更新仍可用，但用户首次打开可能被系统拦截。

## 相关文件

| 路径 | 作用 |
|---|---|
| `apps/desktop/src-tauri/tauri.conf.json` | endpoints / pubkey / createUpdaterArtifacts |
| `apps/desktop/src-tauri/src/lib.rs` | 注册 updater + process 插件 |
| `apps/desktop/src/platform/tauriPlatformAdapter.ts` | check / install |
| `packages/web-ui/.../GeneralSettings.tsx` | 设置页 UI |
| `scripts/generate-latest-json.mjs` | Release 清单 |
| `.github/workflows/release.yml` | CI 发布 |
