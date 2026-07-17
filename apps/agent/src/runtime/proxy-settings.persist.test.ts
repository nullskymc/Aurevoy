import { describe, expect, it } from 'vitest';
import { validateProxyUrl } from './outbound-proxy.js';

describe('proxy settings validation (HTTP only)', () => {
  it('accepts HTTP proxy URLs', () => {
    expect(validateProxyUrl('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890');
  });

  it('rejects SOCKS5', () => {
    expect(() => validateProxyUrl('socks5://127.0.0.1:1080')).toThrow(/SOCKS5/i);
  });
});
