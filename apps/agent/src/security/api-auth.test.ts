import { describe, expect, it } from 'vitest';
import { createApiToken, isAllowedApiOrigin, isValidApiAuthorization } from './api-auth.js';

describe('local API authentication', () => {
  it('uses a configured token only when explicitly provided', () => {
    expect(createApiToken(' fixture-token ')).toBe('fixture-token');
    expect(createApiToken('')).toHaveLength(64);
    expect(createApiToken(undefined)).toHaveLength(64);
  });

  it('requires an exact allowed Origin for bootstrap', () => {
    const origins = ['http://tauri.localhost', 'http://localhost:1420'];
    expect(isAllowedApiOrigin('http://tauri.localhost', origins)).toBe(true);
    expect(isAllowedApiOrigin('http://evil.localhost', origins)).toBe(false);
    expect(isAllowedApiOrigin(undefined, origins)).toBe(false);
  });

  it('accepts only the current Bearer token', () => {
    expect(isValidApiAuthorization('Bearer token-1', 'token-1')).toBe(true);
    expect(isValidApiAuthorization('token-1', 'token-1')).toBe(false);
    expect(isValidApiAuthorization('Bearer token-2', 'token-1')).toBe(false);
  });
});
