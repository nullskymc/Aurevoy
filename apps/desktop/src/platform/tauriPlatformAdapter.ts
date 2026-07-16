import type { AppUpdateInfo, AppUpdateProgress, PlatformAdapter } from '@aurevoy/web-ui';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { LogicalSize, currentMonitor, getCurrentWindow } from '@tauri-apps/api/window';
import type { Update } from '@tauri-apps/plugin-updater';

const registeredWindowDragHandlers = new Set<string>();

/** 最近一次 check 返回的 Update，供 install 复用，避免重复请求。 */
let pendingUpdate: Update | null = null;

/**
 * Tauri 桌面壳的 PlatformAdapter 实现。
 *
 * 桥接 web-ui 的平台无关代码与 Tauri 原生能力：
 * - 文件系统：convertFileSrc / invoke('file_metadata') / invoke('save_temp_file')
 * - 系统对话框：@tauri-apps/plugin-dialog（动态 import）
 * - 文件拖拽：getCurrentWindow().onDragDropEvent
 * - 进程管理：invoke('ensure_agent_process')
 * - 外部链接：@tauri-apps/plugin-opener（动态 import）
 */
export const tauriPlatformAdapter: PlatformAdapter = {
  setupWindowDrag(
    dragSelector: string,
    noDragSelector = 'button, input, select, textarea, a, [role="button"], [data-no-window-drag]',
  ): void {
    const key = `${dragSelector}\n${noDragSelector}`;
    if (registeredWindowDragHandlers.has(key)) return;
    registeredWindowDragHandlers.add(key);

    const win = getCurrentWindow();

    const isWindowDragTarget = (target: EventTarget | null): target is Element => {
      if (!(target instanceof Element)) return false;
      if (!target.closest(dragSelector)) return false;
      if (target.closest(noDragSelector)) return false; // 交互元素不触发拖动
      return true;
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return; // 仅左键拖动
      if (!isWindowDragTarget(e.target)) return;
      if (e.detail >= 2) {
        void win.toggleMaximize().catch(() => undefined);
        return;
      }
      // macOS 要求 startDragging() 在 mousedown 同步调用，
      // 且不能阻止默认事件，否则 native drag 无法获取位置
      void win.startDragging().catch(() => undefined);
    };

    document.addEventListener('mousedown', onMouseDown);
    // 平台适配器不负责清理（App 生命周期内常驻）
  },
  filePathToUrl(filePath: string): string | null {
    try {
      return convertFileSrc(filePath);
    } catch {
      return null;
    }
  },

  async openExternal(url: string): Promise<void> {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  },

  async openFile(path: string): Promise<void> {
    const { openPath } = await import('@tauri-apps/plugin-opener');
    await openPath(path);
  },

  async revealFile(path: string): Promise<void> {
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
    await revealItemInDir(path);
  },

  onFileDrop(callback: (paths: string[]) => void): (() => void) {
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    win
      .onDragDropEvent((event) => {
        if (event.payload.type === 'drop') {
          callback(event.payload.paths);
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        // 浏览器开发模式忽略
      });
    return () => {
      unlisten?.();
    };
  },

  async openFileDialog(options?: {
    directory?: boolean;
    multiple?: boolean;
  }): Promise<string[] | null> {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        directory: options?.directory ?? false,
        multiple: options?.multiple ?? false,
      });
      if (!selected) return null;
      return Array.isArray(selected) ? selected : [selected];
    } catch {
      return null;
    }
  },

  async getFileMetadata(path: string) {
    const meta = await invoke<{
      name: string;
      size: number;
      is_dir: boolean;
      mime_type: string;
    }>('file_metadata', { path });
    return {
      name: meta.name,
      size: meta.size,
      mimeType: meta.mime_type,
      isDir: meta.is_dir,
    };
  },

  async saveTempFile(name: string, dataUrl: string): Promise<string> {
    return invoke<string>('save_temp_file', { name, data: dataUrl });
  },

  async readImageDataUrl(path: string): Promise<string> {
    return invoke<string>('read_image_data_url', { path });
  },

  async ensureAgentRunning() {
    if (
      typeof window !== 'undefined' &&
      '__TAURI_INTERNALS__' in window
    ) {
      try {
        return invoke<{
          baseUrl: string;
          mode: string;
          running: boolean;
          pid: number | null;
          message: string;
          error: string | null;
        }>('ensure_agent_process');
      } catch {
        return null;
      }
    }
    return null;
  },

  async ensureWindowMinWidth(minWidth: number): Promise<void> {
    if (!Number.isFinite(minWidth) || minWidth <= 0) return;
    const win = getCurrentWindow();
    if (await win.isMaximized()) return;

    const [physical, scale] = await Promise.all([win.innerSize(), win.scaleFactor()]);
    const currentLogical = physical.width / scale;
    if (currentLogical >= minWidth - 0.5) return;

    let target = minWidth;
    try {
      const monitor = await currentMonitor();
      if (monitor) {
        const workAreaLogical = monitor.workArea.size.width / monitor.scaleFactor;
        // Leave a small margin so the frame does not hug the display edge.
        target = Math.min(target, Math.max(currentLogical, workAreaLogical - 16));
      }
    } catch {
      // Monitor query is best-effort.
    }

    if (target <= currentLogical + 0.5) return;

    const heightLogical = physical.height / scale;
    // Requires core:window:allow-set-size in capabilities — do not swallow errors so
    // callers can detect a failed expand (otherwise workbench opens then auto-collapses).
    await win.setSize(new LogicalSize(Math.ceil(target), Math.ceil(heightLogical)));
  },

  async getAppVersion() {
    try {
      const { getVersion } = await import('@tauri-apps/api/app');
      return await getVersion();
    } catch {
      return null;
    }
  },

  async checkForAppUpdate(): Promise<AppUpdateInfo> {
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const { getVersion } = await import('@tauri-apps/api/app');
      const currentVersion = await getVersion();
      // 关闭上一轮未安装的 Update 句柄
      if (pendingUpdate) {
        try {
          await pendingUpdate.close();
        } catch {
          // ignore
        }
        pendingUpdate = null;
      }
      const update = await check();
      if (!update) {
        return { available: false, currentVersion };
      }
      pendingUpdate = update;
      return {
        available: true,
        currentVersion: update.currentVersion || currentVersion,
        version: update.version,
        notes: update.body ?? null,
        date: update.date ?? null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message || '检查更新失败');
    }
  },

  async installAppUpdate(options) {
    const update = pendingUpdate;
    if (!update) {
      throw new Error('没有待安装的更新，请先检查更新');
    }
    let downloaded = 0;
    let contentLength: number | null | undefined;
    await update.downloadAndInstall((event) => {
      const progress: AppUpdateProgress = {
        event: event.event,
      };
      if (event.event === 'Started') {
        contentLength = event.data.contentLength ?? null;
        downloaded = 0;
        progress.contentLength = contentLength;
        progress.downloaded = 0;
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength;
        progress.chunkLength = event.data.chunkLength;
        progress.contentLength = contentLength;
        progress.downloaded = downloaded;
      } else if (event.event === 'Finished') {
        progress.contentLength = contentLength;
        progress.downloaded = downloaded;
      }
      options?.onProgress?.(progress);
    });
    pendingUpdate = null;

    // 更新包替换完成后清 quarantine，避免重启后再次被 Gatekeeper 拦截。
    // 仅 macOS 有实际动作；失败不阻断 relaunch（用户仍可手动 xattr）。
    try {
      await invoke<string>('clear_app_quarantine');
    } catch {
      // best-effort
    }

    if (options?.relaunch !== false) {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    }
  },
};
