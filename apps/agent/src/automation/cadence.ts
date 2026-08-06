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

/**
 * 从原计划时间推进到下一个未来时刻，避免引擎休眠后按“当前时间 + 间隔”漂移，
 * 也避免把已经错过的多个周期在一次启动中连续补跑。
 */
export function nextScheduledAutomationRunAt(
  cadence: AutomationCadence,
  scheduledAt: string | undefined,
  now = Date.now(),
): string | undefined {
  const interval = automationCadenceMs(cadence);
  if (interval === undefined) return undefined;
  const parsed = scheduledAt ? Date.parse(scheduledAt) : Number.NaN;
  let next = Number.isFinite(parsed) ? parsed + interval : now + interval;
  while (next <= now) next += interval;
  return new Date(next).toISOString();
}
