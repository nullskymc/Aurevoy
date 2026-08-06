import { describe, expect, it } from 'vitest';
import { buildToolCallSummary } from './tool-call-summary.js';

describe('buildToolCallSummary', () => {
  it('summarizes MCP calls with server, action and a safe target', () => {
    expect(buildToolCallSummary(
      'mcp_zotero_zotero_search_items',
      { query: 'source-free domain adaptation', apiKey: 'do-not-display' },
    )).toBe('调用 Zotero · 搜索条目 · source-free domain adaptation');

    expect(buildToolCallSummary(
      'mcp_zotero_zotero_get_item_metadata',
      { item_key: 'MR79JRGV', include_abstract: true },
    )).toBe('调用 Zotero · 获取条目元数据 · MR79JRGV');
  });

  it('never uses content or credential fields as a fallback target', () => {
    expect(buildToolCallSummary(
      'mcp_notes_publish',
      { content: 'private document body', token: 'secret-token' },
    )).toBe('调用 Notes · publish');
  });

  it('provides a useful fallback for unknown builtin tools', () => {
    expect(buildToolCallSummary('run_dreams', {})).toBe('运行 run dreams');
  });

  it('uses distinct browser approval summaries without echoing form values', () => {
    expect(buildToolCallSummary('mcp_playwright_browser_navigate', { url: 'https://example.com' }))
      .toBe('导航到网页 · https://example.com');
    expect(buildToolCallSummary('mcp_playwright_browser_take_screenshot', { url: 'https://example.com' }))
      .toBe('截图网页 · https://example.com');
    expect(buildToolCallSummary('mcp_playwright_browser_click', { url: 'https://example.com', value: 'secret' }))
      .toBe('提交/交互页面 · https://example.com');
  });
});
