import { describe, expect, it } from 'vitest';
import { classifyTaskError } from './task-error-category.js';

describe('classifyTaskError', () => {
  it('distinguishes network failures from local engine failures', () => {
    expect(classifyTaskError(new Error('fetch failed: ECONNRESET'))).toBe('network');
    expect(classifyTaskError(new Error('SQLite database is locked'))).toBe('engine');
  });

  it('keeps explicit model fallback for provider errors without a more specific signal', () => {
    expect(classifyTaskError(new Error('provider returned an invalid response'), 'model')).toBe('model');
  });

  it('recognizes configuration, permission, budget and timeout recovery categories', () => {
    expect(classifyTaskError(new Error('未选择模型'))).toBe('configuration');
    expect(classifyTaskError(new Error('EACCES: permission denied'))).toBe('permission');
    expect(classifyTaskError(new Error('budget exceeded'))).toBe('budget');
    expect(classifyTaskError(new Error('request timed out'))).toBe('timeout');
  });
});
