/**
 * OAuth 认证页打开路径（设置页订阅登录）。
 *
 * 桌面壳（Tauri）：只走 platform.openExternal → plugin-opener → 系统浏览器。
 * 不调用 window.open：WebView2 在未注册 on_new_window 时会拒绝新窗口，
 * 双路径只会制造「无法显示网页」的假象且掩盖 openExternal 失败。
 *
 * 无 openExternal（纯浏览器预览）：回退 window.open。
 * 失败以 Promise reject 抛出，由 UI 提示用户手动打开链接。
 */
export type OpenExternalFn = (url: string) => void | Promise<void>;

export type OpenWindowFn = (
  url: string,
  target?: string,
  features?: string,
) => unknown;

export type OpenOauthAuthUrlResult = {
  /** openExternal | window.open */
  via: "openExternal" | "window.open";
};

/**
 * 打开 OAuth 授权 URL。成功 resolve；失败 reject(Error)。
 */
export async function openOauthAuthUrl(
  openExternal: OpenExternalFn | undefined,
  url: string,
  openWindow: OpenWindowFn = (href, target, features) =>
    window.open(href, target, features),
): Promise<OpenOauthAuthUrlResult> {
  if (typeof openExternal === "function") {
    await Promise.resolve(openExternal(url));
    return { via: "openExternal" };
  }

  const opened = openWindow(url, "_blank", "noopener,noreferrer");
  // window.open 被拦截时返回 null
  if (opened === null) {
    throw new Error("window.open blocked");
  }
  return { via: "window.open" };
}
