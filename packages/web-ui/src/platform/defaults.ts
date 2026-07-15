import type { PlatformAdapter } from './types';

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';

/**
 * 浏览器环境默认 PlatformAdapter 实现。
 * 图片通过 File API 读成 data URL 上传；不能访问本地绝对路径。
 */
export const browserPlatform: PlatformAdapter = {
  filePathToUrl: () => null,

  openExternal(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  },

  onFileDrop() {
    // 浏览器中文件拖拽由 Composer HTML5 DragEvent 处理
    return () => {};
  },

  async openFile(path: string): Promise<void> {
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

  /**
   * 网页端用隐藏 file input 选图；返回 object URL 列表。
   * 调用方应配合 readImageDataUrl / getFileMetadata 读取内容后 revoke。
   */
  async openFileDialog(options) {
    return await new Promise<string[] | null>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = IMAGE_ACCEPT;
      input.multiple = options?.multiple !== false;
      input.style.display = 'none';
      const cleanup = () => {
        input.remove();
      };
      input.addEventListener('change', () => {
        const files = Array.from(input.files ?? []);
        if (files.length === 0) {
          cleanup();
          resolve(null);
          return;
        }
        const urls = files.map((file) => {
          const url = URL.createObjectURL(file);
          browserFileRegistry.set(url, file);
          return url;
        });
        cleanup();
        resolve(urls);
      }, { once: true });
      // 用户取消时部分浏览器不触发 change；用 focus 回退
      window.addEventListener('focus', () => {
        window.setTimeout(() => {
          if (!input.isConnected) return;
          if (!input.files || input.files.length === 0) {
            cleanup();
            resolve(null);
          }
        }, 300);
      }, { once: true });
      document.body.appendChild(input);
      input.click();
    });
  },

  async getFileMetadata(path: string) {
    const file = browserFileRegistry.get(path);
    if (!file) {
      return { name: '', size: 0, mimeType: '', isDir: false };
    }
    return {
      name: file.name || 'image.png',
      size: file.size,
      mimeType: file.type || guessMimeFromName(file.name),
      isDir: false,
    };
  },

  async readImageDataUrl(path: string) {
    const file = browserFileRegistry.get(path);
    if (!file) {
      throw new Error('无法读取所选图片：请重新选择或粘贴图片');
    }
    try {
      return await readBlobAsDataUrl(file);
    } finally {
      // 读取后释放 object URL，避免泄漏（附件已持有 dataUrl）
      URL.revokeObjectURL(path);
      browserFileRegistry.delete(path);
    }
  },

  async saveTempFile() {
    return '';
  },
};

/** blob: URL → File，供 openFileDialog 结果读取 */
const browserFileRegistry = new Map<string, File>();

function guessMimeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('读取图片失败'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
    reader.readAsDataURL(blob);
  });
}
