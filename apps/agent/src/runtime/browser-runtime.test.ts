import { describe, expect, it } from 'vitest';
import type { McpServerStatus } from '@aurevoy/shared';
import { buildBrowserRuntimeStatus, findBrowserServer, isBrowserServerName } from './browser-runtime.js';

function status(patch: Partial<McpServerStatus> = {}): McpServerStatus {
  return {
    name: 'playwright',
    enabled: true,
    connected: true,
    registeredTools: 3,
    toolNames: ['browser_navigate', 'browser_snapshot', 'browser_take_screenshot'],
    ...patch,
  };
}

describe('browser runtime status', () => {
  it('recognizes Playwright/browser server names without exposing configuration', () => {
    expect(isBrowserServerName('playwright')).toBe(true);
    expect(isBrowserServerName('local-browser')).toBe(true);
    expect(isBrowserServerName('filesystem')).toBe(false);
  });

  it('distinguishes ready, disabled, unhealthy and not configured states', () => {
    expect(buildBrowserRuntimeStatus({ enabled: true }, [status()])).toMatchObject({
      state: 'ready',
      serverName: 'playwright',
      registeredTools: 3,
      blockedTools: 0,
    });
    expect(buildBrowserRuntimeStatus({ enabled: true }, [status({ blockedTools: 2 })]).blockedTools).toBe(2);
    expect(buildBrowserRuntimeStatus({ enabled: false }, [status()]).state).toBe('disabled');
    expect(buildBrowserRuntimeStatus({ enabled: true }, [status({ connected: false, registeredTools: 0, error: 'offline' })])).toMatchObject({
      state: 'unhealthy',
      error: 'offline',
    });
    expect(buildBrowserRuntimeStatus({ enabled: true }, []).state).toBe('not_configured');
  });

  it('only selects an explicitly browser-named MCP server for probing', () => {
    const server = { name: 'playwright', enabled: true, transport: 'stdio' as const, command: 'npx', args: [] };
    expect(findBrowserServer([server], 'playwright')).toBe(server);
    expect(findBrowserServer([server], 'filesystem')).toBeUndefined();
  });
});
