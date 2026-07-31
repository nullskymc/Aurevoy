import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../../config.js';
import {
  injectNativeWebSearchTool,
  resolveNativeWebSearchModel,
} from './native-web-search.js';

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

describe('resolveNativeWebSearchModel', () => {
  const originalPreferNative = config.search.preferNative

  afterEach(() => {
    config.search.preferNative = originalPreferNative
  })

  it('keeps Responses and Anthropic models untouched when native search is on', () => {
    config.search.preferNative = true
    const responses = { id: 'deepseek-v4-flash', api: 'openai-responses', provider: 'deepseek' }
    const anthropic = { id: 'claude-x', api: 'anthropic-messages', provider: 'anthropic' }
    expect(resolveNativeWebSearchModel(responses as never)).toBe(responses)
    expect(resolveNativeWebSearchModel(anthropic as never)).toBe(anthropic)
  })

  it('skips hosted search for DeepSeek completions models (no anthropic detour)', () => {
    config.search.preferNative = true
    const model = { id: 'deepseek-v4-pro', api: 'openai-completions', provider: 'deepseek' }
    expect(resolveNativeWebSearchModel(model as never)).toBeNull()
  })

  it('tries Responses hosted search for other completions endpoints', () => {
    config.search.preferNative = true
    const model = { id: 'qwen3', api: 'openai-completions', provider: 'openai-compatible' }
    expect(resolveNativeWebSearchModel(model as never)).toMatchObject({
      api: 'openai-responses',
    })
  })

  it('returns null when native search preference is off', () => {
    config.search.preferNative = false
    const model = { id: 'deepseek-v4-flash', api: 'openai-responses', provider: 'deepseek' }
    expect(resolveNativeWebSearchModel(model as never)).toBeNull()
  })
})
