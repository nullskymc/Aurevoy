import type { PlatformAdapter } from './types';

/**
 * 浏览器环境默认 PlatformAdapter 实现。
 * 所有方法都返回无害默认值，让 web-ui 在浏览器中正常工作。
 */
export const browserPlatform: PlatformAdapter = {
  filePathToUrl: () => null,

  openExternal(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  },

  onFileDrop() {
    // 浏览器中文件拖拽由 HTML5 DragEvent 处理
    return () => {};
  },

  async openFile(path: string): Promise<void> {
    // 浏览器不能直接打开本地文件，复制路径到剪贴板
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      // 剪贴板不可用时忽略
    }
  },

  async revealFile(path: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      // 剪贴板不可用时忽略
    }
  },

  async openFileDialog() {
    // 浏览器环境通过 <input type="file"> 实现（仅用于兼容）
    return null;
  },

  async getFileMetadata() {
    return { name: '', size: 0, mimeType: '', isDir: false };
  },

  async saveTempFile() {
    return '';
  },
};
