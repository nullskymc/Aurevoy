import type { BrowserPermissionProfile } from '@aurevoy/shared';

/** 浏览器 MCP 的四级能力边界；数字越大代表越高风险。 */
export type BrowserToolTier = 'read_only' | 'download' | 'login' | 'submit';

const PROFILE_RANK: Record<BrowserPermissionProfile, number> = {
  read_only: 0,
  download: 1,
  login: 2,
  submit: 3,
};

/** 只根据 server 名称识别浏览器 MCP，不读取 command、URL 或凭据。 */
export function isBrowserMcpServerName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === 'playwright' || normalized.includes('playwright') || normalized.includes('browser');
}

/** 识别 Playwright 常见工具动作；未知动作按提交级处理，避免默认放开副作用。 */
export function browserToolTier(tool: {
  name: string;
  title?: string;
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
}): BrowserToolTier {
  // 明确的工具名优先于描述：例如“navigate to a form page”仍然是只读导航，
  // 不能因为描述里提到 form 就把导航误判为提交动作。
  const name = tool.name.toLowerCase();
  if (/(submit|click|fill|type|press|upload|select_option|set_input|form|checkout|purchase|delete|remove)/.test(name)) {
    return 'submit';
  }
  if (/(login|log_in|signin|sign_in|auth|cookie|storage_state|session)/.test(name)) {
    return 'login';
  }
  if (/(download|save_pdf|save_file|export)/.test(name)) {
    return 'download';
  }
  if (/(navigate|goto|open|snapshot|read|text|content|screenshot|screen|wait|tab|page|close|inspect|evaluate)/.test(name)) {
    return 'read_only';
  }

  const text = `${tool.title ?? ''} ${tool.description ?? ''}`.toLowerCase();
  if (/(submit|click|fill|type|press|upload|select_option|set_input|form|checkout|purchase|delete|remove)/.test(text)) {
    return 'submit';
  }
  if (/(login|log_in|signin|sign_in|auth|cookie|storage_state|session)/.test(text)) {
    return 'login';
  }
  if (/(download|save_pdf|save_file|export)/.test(text)) {
    return 'download';
  }
  if (/(navigate|goto|open|snapshot|read|text|content|screenshot|screen|wait|tab|page|close|inspect|evaluate)/.test(text)) {
    return 'read_only';
  }
  if (tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true && tool.annotations.openWorldHint !== true) {
    return 'read_only';
  }
  return 'submit';
}

/** 非浏览器 MCP 不受 profile 影响；浏览器未配置时默认采用只读 profile。 */
export function isBrowserMcpToolAllowed(
  serverName: string,
  tool: Parameters<typeof browserToolTier>[0],
  profile: BrowserPermissionProfile = 'read_only',
): boolean {
  if (!isBrowserMcpServerName(serverName)) return true;
  return PROFILE_RANK[browserToolTier(tool)] <= PROFILE_RANK[profile];
}
