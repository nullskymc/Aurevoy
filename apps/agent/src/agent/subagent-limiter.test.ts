import { describe, expect, it } from 'vitest';
import { SubagentConcurrencyLimiter } from './subagent-limiter.js';

describe('SubagentConcurrencyLimiter', () => {
  it('limits concurrency and wakes queued runs in order', async () => {
    const limiter = new SubagentConcurrencyLimiter(() => 1);
    const releaseFirst = await limiter.acquire();
    let secondStarted = false;
    const second = limiter.acquire().then((release) => {
      secondStarted = true;
      return release;
    });

    await Promise.resolve();
    expect(secondStarted).toBe(false);
    expect(limiter.activeCount).toBe(1);
    expect(limiter.pendingCount).toBe(1);

    releaseFirst();
    const releaseSecond = await second;
    expect(secondStarted).toBe(true);
    expect(limiter.activeCount).toBe(1);
    releaseSecond();
    expect(limiter.activeCount).toBe(0);
  });

  it('removes a cancelled waiter without consuming a slot', async () => {
    const limiter = new SubagentConcurrencyLimiter(() => 1);
    const release = await limiter.acquire();
    const controller = new AbortController();
    const queued = limiter.acquire(controller.signal);
    controller.abort();

    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(limiter.pendingCount).toBe(0);
    release();
    expect(limiter.activeCount).toBe(0);
  });
});
