# Aurevoy Android

Android WebView 壳，加载 `packages/web-ui` 构建产物，通过 JavaScriptInterface 桥接原生能力。

## 架构

```
packages/web-ui (React UI + PlatformAdapter)
    │
    │  Vite 构建 → dist-web/
    │  ↓ 复制
apps/android/app/src/main/assets/web/
    │
    │  WebViewAssetLoader (https://aurevoy.local/assets/web/)
    │  ↓
android.webkit.WebView (MainActivity)
    │
    ├── AurevoyPlatform (JavaScriptInterface)
    │   ├── filePathToUrl(path) → content:// URI
    │   ├── openExternal(url) → ACTION_VIEW Intent
    │   └── getMimeType(path) → MIME type
    │
    ├── WebChromeClient.onShowFileChooser → 系统文件选择器
    │
    └── HTTP + SSE → apps/agent (远程或本地后端)
```

## 前置要求

- Android Studio Hedgehog (2024.3+) 或 IntelliJ IDEA
- JDK 17+
- Android SDK 35
- Gradle 8.4+

## 构建与运行

```bash
# 1. 构建 web-ui
cd packages/web-ui && npm run build:web

# 2. 同步到 Android assets
bash scripts/sync-android-assets.sh

# 3. 在 Android Studio 中打开 apps/android 目录
#    或者命令行构建：
cd apps/android && ./gradlew assembleDebug
```

## 连接 Agent 后端

Android 客户端通过 HTTP + SSE 连接 Agent 引擎，后端地址可通过以下方式配置：

1. **intent extra**: `adb shell am start -n com.aurevoy.android/.MainActivity --es AGENT_BASE_URL "http://192.168.1.100:8787"`
2. **环境变量**（开发期）: 设置 `VITE_AGENT_BASE_URL` 环境变量
3. **默认地址**: `http://127.0.0.1:8787`（本机或 localhost 代理）

**注意**：生产环境必须使用 HTTPS，且移除 `network_security_config.xml` 中的 cleartext 配置。

## PlatformAdapter 实现状态

| 方法 | 状态 | 说明 |
|---|---|---|
| `filePathToUrl` | ✅ | 通过 `Uri.fromFile()` 转换为 WebView 可加载路径 |
| `openExternal` | ✅ | `ACTION_VIEW` Intent 打开系统浏览器 |
| `openFileDialog` | ⬜ | 待实现（当前使用 WebChromeClient 默认行为） |
| `getFileMetadata` | ⬜ | 待实现 |
| `saveTempFile` | ⬜ | 待实现 |
| `onFileDrop` | ⬜ | Android 不支持桌面拖拽 |
| `ensureAgentRunning` | ⬜ | Android 连接远程 Agent，无需进程管理 |

## 后续改进

- [ ] 设置页面：允许用户配置 Agent 后端地址
- [ ] 离线缓存：Service Worker 缓存 UI 资源
- [ ] 推送通知：Agent 任务完成后推送
- [ ] 文件处理：完整实现 `openFileDialog` + `getFileMetadata`
- [ ] 深色模式：跟随系统主题
