/**
 * @aurevoy/web-ui 独立入口。
 *
 * 用于 Android WebView 壳或浏览器直接预览。
 * 自动检测 window.AurevoyPlatform（Android JavaScriptInterface）并注入为 PlatformAdapter。
 */
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { PlatformContext, browserPlatform } from "./platform";
import type { PlatformAdapter } from "./platform";

declare global {
  interface Window {
    /** Android WebView 平台桥接（由 AndroidPlatformAdapter 注入） */
    AurevoyPlatform?: {
      filePathToUrl(path: string): string | null;
      openExternal(url: string): void;
      getMimeType(path: string): string;
      fileExists(path: string): boolean;
    };
  }
}

/** 从 Android JavaScriptInterface 构建 PlatformAdapter */
function createAndroidPlatformAdapter(): PlatformAdapter {
  const bridge = window.AurevoyPlatform;
  if (!bridge) return browserPlatform;

  return {
    filePathToUrl(path: string): string | null {
      try {
        return bridge.filePathToUrl(path) ?? null;
      } catch {
        return null;
      }
    },
    openExternal(url: string): void {
      try {
        bridge.openExternal(url);
      } catch {
        window.open(url, "_blank");
      }
    },
    // 文件对话框由 Android WebChromeClient.onShowFileChooser 处理
    async openFileDialog() {
      return null;
    },
    async getFileMetadata() {
      return { name: "", size: 0, mimeType: "", isDir: false };
    },
    async saveTempFile() {
      return "";
    },
  };
}

const platform = window.AurevoyPlatform
  ? createAndroidPlatformAdapter()
  : browserPlatform;

// 适配 Vite 环境变量或 Android 注入的 Agent 地址
// Agent 地址由 api.ts 通过 import.meta.env.VITE_AGENT_BASE_URL 或
// window.__AUREVOY_AGENT_BASE_URL__（Android 注入）读取


ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PlatformContext.Provider value={platform}>
      <App />
    </PlatformContext.Provider>
  </React.StrictMode>,
);
