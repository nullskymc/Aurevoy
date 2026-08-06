/** 浏览器工具失败的可恢复分类；只处理用户需要下一步的常见环境问题。 */
export type BrowserFailureKind =
  | "login_required"
  | "page_changed"
  | "element_unavailable"
  | "download_failed"
  | "unknown";

export interface BrowserRecoveryPlan {
  kind: BrowserFailureKind;
  /** 仅保留 origin + pathname，避免把 query 中的 token/state 带入外部打开或人工摘要。 */
  url?: string;
}

const BROWSER_TOOL_PATTERN = /\b(?:browser|playwright)[\w-]*/i;
const LOGIN_PATTERN = /login|log[ -]?in|signin|sign[ -]?in|auth|unauthori[sz]ed|session|cookie|storage_state|登录|认证|会话/i;
const DOWNLOAD_PATTERN = /download|save[_ -]?file|save[_ -]?pdf|export|下载|保存文件|导出/i;
const PAGE_PATTERN = /page\s+(?:changed|navigated|reloaded)|unexpected\s+navigation|navigation\s+(?:changed|failed)|content\s+(?:changed|updated)|stale\s+page|页面变化|页面已变化|导航变化/i;
const ELEMENT_PATTERN = /locator|selector|element|strict mode|detached|no longer attached|not found|timeout.*(?:locator|selector|element)|元素|选择器|定位器/i;

/**
 * 将浏览器工具错误映射为用户可理解的恢复入口。
 * 未带浏览器工具名且没有浏览器错误信号时返回 null，避免污染普通工具失败卡片。
 */
export function classifyBrowserFailure(error: string, toolName = ""): BrowserRecoveryPlan | null {
  const text = `${toolName}\n${error}`;
  const isBrowserFailure = BROWSER_TOOL_PATTERN.test(toolName) || BROWSER_TOOL_PATTERN.test(error);
  if (!isBrowserFailure) return null;

  const kind = LOGIN_PATTERN.test(text)
    ? "login_required"
    : DOWNLOAD_PATTERN.test(text)
      ? "download_failed"
      : PAGE_PATTERN.test(text)
        ? "page_changed"
        : ELEMENT_PATTERN.test(text) || (/click|fill|type|press|select/i.test(toolName) && /timeout|failed|error/i.test(error))
          ? "element_unavailable"
          : "unknown";

  return {
    kind,
    url: extractSafeBrowserUrl(text),
  };
}

/** 只提取脱敏后的站点路径，丢弃 query/hash 中可能存在的登录态或临时签名。 */
export function extractSafeBrowserUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s<>"'`]+/i)?.[0];
  if (!match) return undefined;
  try {
    const parsed = new URL(match.replace(/[),.;!?]+$/, ""));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

/** 复制给人工处理者的摘要不带原始 query，也会遮掉常见秘密字段。 */
export function buildBrowserManualHandoff(error: string, plan: BrowserRecoveryPlan): string {
  const safeError = error
    .replace(/(password|passwd|token|secret|cookie|authorization|api[_ -]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/https?:\/\/[^\s<>"'`]+/gi, plan.url ?? "[URL REDACTED]")
    .slice(0, 1_000);
  return [
    "Aurevoy browser manual handoff",
    `category=${plan.kind}`,
    `page=${plan.url ?? "[not detected]"}`,
    `error=${safeError}`,
  ].join("\n");
}
