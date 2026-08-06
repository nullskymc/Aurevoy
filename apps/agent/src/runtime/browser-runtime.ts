import type { BrowserRuntimeState, BrowserRuntimeStatus, McpServerStatus, SkillDescriptor } from '@aurevoy/shared';
import type { McpServerConfig } from '../config.js';

/** browser Skill 使用的官方参考安装方式；这里只展示说明，不在后台执行安装。 */
export const BROWSER_INSTALL_COMMAND = 'npm install -g @anthropic/mcp-server-playwright';
export const BROWSER_CONFIG_EXAMPLE = 'npx -y @anthropic/mcp-server-playwright';

/** 识别 Playwright/browser MCP 配置时只看用户可见的 server 名称，不读取或回显敏感字段。 */
export function isBrowserServerName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === 'playwright'
    || normalized.includes('playwright')
    || normalized.includes('browser');
}

/** 为设置页生成稳定的浏览器运行时状态；运行时状态本身不等于允许执行高风险动作。 */
export function buildBrowserRuntimeStatus(
  skill: Pick<SkillDescriptor, 'enabled'> | undefined,
  servers: readonly McpServerStatus[],
): BrowserRuntimeStatus {
  const browserServer = servers.find((server) => isBrowserServerName(server.name));
  const skillInstalled = skill !== undefined;
  const skillEnabled = skill?.enabled ?? false;

  let state: BrowserRuntimeState = 'not_configured';
  if (browserServer && !skillEnabled) {
    state = 'disabled';
  } else if (browserServer?.enabled && browserServer.connected) {
    state = 'ready';
  } else if (browserServer?.enabled) {
    state = 'unhealthy';
  }

  return {
    state: skillInstalled ? state : 'not_configured',
    skillInstalled,
    skillEnabled,
    serverName: browserServer?.name,
    connected: browserServer?.connected ?? false,
    registeredTools: browserServer?.registeredTools ?? 0,
    blockedTools: browserServer?.blockedTools ?? 0,
    toolNames: browserServer?.toolNames ?? [],
    error: browserServer?.error,
    installCommand: BROWSER_INSTALL_COMMAND,
    configExample: BROWSER_CONFIG_EXAMPLE,
  };
}

/** 在配置数组中找到可用于一次性探测的浏览器 MCP；不接受任意 server 名称绕过页面语义。 */
export function findBrowserServer(servers: readonly McpServerConfig[], serverName?: string): McpServerConfig | undefined {
  if (serverName?.trim()) {
    return servers.find((server) => server.name === serverName.trim() && isBrowserServerName(server.name));
  }
  return servers.find((server) => isBrowserServerName(server.name));
}
