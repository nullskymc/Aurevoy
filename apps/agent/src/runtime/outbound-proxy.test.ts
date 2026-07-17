import { describe, expect, it } from 'vitest';
import {
  formatFetchError,
  normalizeNoProxy,
  validateProxyUrl,
} from './outbound-proxy.js';

describe('validateProxyUrl', () => {
  it('accepts http proxy URLs and strips trailing slash', () => {
    expect(validateProxyUrl('http://127.0.0.1:7890/')).toBe('http://127.0.0.1:7890');
    expect(validateProxyUrl(' http://user:pass@127.0.0.1:7897 ')).toBe(
      'http://user:pass@127.0.0.1:7897',
    );
  });

  it('rejects empty, non-http schemes, and invalid URLs', () => {
    expect(() => validateProxyUrl('')).toThrow(/不能为空|empty/i);
    expect(() => validateProxyUrl('socks5://127.0.0.1:1080')).toThrow(/http/i);
    expect(() => validateProxyUrl('not-a-url')).toThrow();
  });
});

describe('normalizeNoProxy', () => {
  it('defaults and dedupes', () => {
    expect(normalizeNoProxy('')).toContain('localhost');
    expect(normalizeNoProxy('a, a; b  c')).toBe('a,b,c');
  });
});

describe('formatFetchError', () => {
  it('joins cause chain for undici-style fetch failed', () => {
    const root = new Error('connect ETIMEDOUT');
    const mid = new Error('fetch failed');
    (mid as Error & { cause: Error }).cause = root;
    expect(formatFetchError(mid)).toContain('fetch failed');
    expect(formatFetchError(mid)).toContain('ETIMEDOUT');
  });
});
