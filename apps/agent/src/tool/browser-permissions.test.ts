import { describe, expect, it } from 'vitest';
import { browserToolTier, isBrowserMcpToolAllowed, isBrowserMcpServerName } from './browser-permissions.js';

describe('browser MCP permission profiles', () => {
  it('recognizes browser servers without treating unrelated MCP names as browser', () => {
    expect(isBrowserMcpServerName('playwright')).toBe(true);
    expect(isBrowserMcpServerName('local-browser')).toBe(true);
    expect(isBrowserMcpServerName('filesystem')).toBe(false);
  });

  it('blocks high-risk browser tools by default and opens them progressively', () => {
    const navigate = { name: 'browser_navigate' };
    const download = { name: 'browser_download' };
    const login = { name: 'browser_login' };
    const submit = { name: 'browser_click' };

    expect(browserToolTier(navigate)).toBe('read_only');
    expect(browserToolTier(download)).toBe('download');
    expect(browserToolTier(login)).toBe('login');
    expect(browserToolTier(submit)).toBe('submit');
    expect(browserToolTier({ name: 'browser_navigate', description: 'navigate to a form page' })).toBe('read_only');
    expect(isBrowserMcpToolAllowed('playwright', navigate)).toBe(true);
    expect(isBrowserMcpToolAllowed('playwright', download)).toBe(false);
    expect(isBrowserMcpToolAllowed('playwright', login, 'login')).toBe(true);
    expect(isBrowserMcpToolAllowed('playwright', submit, 'login')).toBe(false);
    expect(isBrowserMcpToolAllowed('playwright', submit, 'submit')).toBe(true);
    expect(isBrowserMcpToolAllowed('filesystem', submit)).toBe(true);
  });
});
