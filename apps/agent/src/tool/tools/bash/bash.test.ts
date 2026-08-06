import { afterEach, describe, expect, it, vi } from 'vitest';
import { bashTool, buildAllowedEnvironment } from './bash.js';

describe('bash tool safety metadata', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('requires explicit approval and exposes bounded execution metadata', () => {
    expect(bashTool.riskLevel).toBe('dangerous');
    expect(bashTool.executionPolicy).toMatchObject({
      parallelizable: false,
      requiresExplicitApproval: true,
    });
    expect(bashTool.description).toContain('explicit user approval');
  });

  it('only forwards the configured environment allowlist', () => {
    vi.stubEnv('PATH', '/test/path');
    vi.stubEnv('AUREVOY_LLM_API_KEY', 'should-not-reach-shell');

    const env = buildAllowedEnvironment(['PATH']);

    expect(env).toEqual({ PATH: '/test/path' });
    expect(env).not.toHaveProperty('AUREVOY_LLM_API_KEY');
  });
});
