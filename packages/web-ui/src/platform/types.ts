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

  /** 以系统默认方式打开本地文件路径。浏览器环境会回退到复制路径。 */
  openFile?(path: string): Promise<void>;

  /** 在系统文件管理器中定位本地文件或目录。浏览器环境会回退到复制路径。 */
  revealFile?(path: string): Promise<void>;

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

  /** 读取本地图片并转为 data URL，用于将真实图片内容上传到 Agent 引擎。 */
  readImageDataUrl?(path: string): Promise<string>;

  /** 确保 Agent 引擎在运行（桌面壳进程管理） */
  ensureAgentRunning?(): Promise<{
    baseUrl?: string;
    running: boolean;
    error?: string | null;
    message?: string;
  } | null>;

  /**
   * 设置窗口拖拽区域（桌面壳 Tauri/Electron）。
   * 将 className 对应的元素设为窗口拖拽手柄，不影响内部按钮的点击交互。
   * 浏览器环境无需实现。
   */
  setupWindowDrag?(dragSelector: string, noDragSelector?: string): void;

  /**
   * 确保当前窗口逻辑宽度至少为 minWidth（单位 CSS px）。
   * 桌面壳在窄窗打开右侧工作台时调用，主动拉宽窗口以免挤占主区。
   * 已最大化或已足够宽时为 no-op；浏览器可忽略。
   */
  ensureWindowMinWidth?(minWidth: number): void | Promise<void>;
}
