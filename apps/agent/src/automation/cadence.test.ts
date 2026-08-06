import { describe, expect, it } from 'vitest';
import { automationCadenceMs, nextAutomationRunAt, nextScheduledAutomationRunAt } from './cadence.js';

describe('automation cadence', () => {
  it('uses stable cross-platform intervals', () => {
    expect(automationCadenceMs('manual')).toBeUndefined();
    expect(automationCadenceMs('hourly')).toBe(60 * 60 * 1000);
    expect(automationCadenceMs('every_6_hours')).toBe(6 * 60 * 60 * 1000);
    expect(automationCadenceMs('daily')).toBe(24 * 60 * 60 * 1000);
    expect(automationCadenceMs('weekly')).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('returns deterministic next timestamps', () => {
    expect(nextAutomationRunAt('manual', 0)).toBeUndefined();
    expect(nextAutomationRunAt('hourly', 0)).toBe('1970-01-01T01:00:00.000Z');
  });

  it('advances from the original schedule and skips missed intervals', () => {
    expect(nextScheduledAutomationRunAt('hourly', '1970-01-01T00:00:00.000Z', Date.parse('1970-01-01T03:30:00.000Z')))
      .toBe('1970-01-01T04:00:00.000Z');
    expect(nextScheduledAutomationRunAt('manual', '1970-01-01T00:00:00.000Z')).toBeUndefined();
  });
});
