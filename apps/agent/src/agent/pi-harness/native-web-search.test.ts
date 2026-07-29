import { describe, expect, it } from 'vitest';
import { injectNativeWebSearchTool } from './native-web-search.js';

describe('injectNativeWebSearchTool', () => {
  it('replaces the local web_search function and preserves other tools', () => {
    const payload = injectNativeWebSearchTool({
      model: 'gpt-test',
      tools: [
        { type: 'function', name: 'web_search', parameters: { type: 'object' } },
        { type: 'function', name: 'read', parameters: { type: 'object' } },
      ],
    }, 'openai-responses') as { tools: Array<Record<string, unknown>> };

    expect(payload.tools).toEqual([
      { type: 'function', name: 'read', parameters: { type: 'object' } },
      { type: 'web_search' },
    ]);
  });

  it('does not duplicate a native search tool', () => {
    const payload = injectNativeWebSearchTool({
      tools: [{ type: 'web_search' }],
    }, 'openai-responses') as { tools: Array<Record<string, unknown>> };

    expect(payload.tools).toEqual([{ type: 'web_search' }]);
  });

  it('uses the Anthropic server tool shape and removes the local function', () => {
    const payload = injectNativeWebSearchTool({
      tools: [
        { name: 'web_search', input_schema: { type: 'object' } },
        { name: 'read', input_schema: { type: 'object' } },
      ],
    }, 'anthropic-messages') as { tools: Array<Record<string, unknown>> };

    expect(payload.tools).toEqual([
      { name: 'read', input_schema: { type: 'object' } },
      { type: 'web_search_20250305', name: 'web_search' },
    ]);
  });

  it('leaves non-object payloads unchanged', () => {
    expect(injectNativeWebSearchTool('payload', 'openai-responses')).toBe('payload');
  });
});
