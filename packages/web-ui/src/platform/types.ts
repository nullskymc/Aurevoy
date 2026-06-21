/**
 * 平台抽象接口。
 *
 * 每个平台壳（Tauri、Android WebView、浏览器）实现此接口，
 * 供 web-ui 中的组件以统一方式调用平台特定能力。
 *
 * 所有方法都是可选的，平台壳按需实现。
 */
export interface PlatformAdapter {
  /** 将本地文件系统路径转为前端可用的 URL（图片等场景）。
   *  Tauri: convertFileSrc() ；浏览器: 返回 null 走 HTML5 File API */
  filePathToUrl(filePath: string): string | null;

  /** 打开外部链接（默认浏览器/自定义标签页） */
  openExternal?(url: string): void | Promise<void>;

  /** 注册原生文件拖拽事件回调，返回取消监听的函数 */
  onFileDrop?(
    callback: (paths: string[]) => void,
  ): (() => void) | void;

  /** 打开系统文件选择器，返回选中的文件路径列表 */
  openFileDialog?(options?: {
    directory?: boolean;
    multiple?: boolean;
  }): Promise<string[] | null>;

  /** 获取文件系统元数据 */
  getFileMetadata?(path: string): Promise<{
    name: string;
    size: number;
    mimeType: string;
    isDir: boolean;
  }>;

  /** 将 data URL 保存为临时文件，返回文件路径 */
  saveTempFile?(name: string, dataUrl: string): Promise<string>;

  /** 确保 Agent 引擎在运行（桌面壳进程管理） */
  ensureAgentRunning?(): Promise<{
    running: boolean;
    error?: string | null;
    message?: string;
  } | null>;
}
