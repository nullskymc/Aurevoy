import type { AutomationCadence } from '@aurevoy/shared';

/** 自动化频率对应的固定间隔；使用间隔而不是时区日历，保证跨平台重启后语义一致。 */
export function automationCadenceMs(cadence: AutomationCadence): number | undefined {
  switch (cadence) {
    case 'hourly':
      return 60 * 60 * 1000;
    case 'every_6_hours':
      return 6 * 60 * 60 * 1000;
    case 'daily':
      return 24 * 60 * 60 * 1000;
    case 'weekly':
      return 7 * 24 * 60 * 60 * 1000;
    case 'manual':
      return undefined;
  }
}
export function nextAutomationRunAt(
  cadence: AutomationCadence,
  from = Date.now(),
): string | undefined {
  const interval = automationCadenceMs(cadence);
  return interval === undefined ? undefined : new Date(from + interval).toISOString();
}
