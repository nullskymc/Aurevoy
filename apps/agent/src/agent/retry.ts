/**
 * 带指数退避的重试包装器。
 * - 网络错误 / 429 / 5xx：自动重试（最多 maxRetries 次）
 * - 400 / 401 / 403：不可重试，直接抛出
 * - AbortError（用户取消）：不重试，直接抛出
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal,
  maxRetries = 3,
): Promise<T> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    try {
      if (attempt > 0) {
        const delay = Math.min(1000 * 2 ** (attempt - 1), 10000);
        const jitter = Math.random() * 500;
        await sleep(delay + jitter, signal);
      }
      return await fn();
    } catch (err) {
      lastError = err;
      const e = err as { name?: string; status?: number };
      if (e?.name === 'AbortError') throw err;
      if (e?.status === 400 || e?.status === 401 || e?.status === 403) throw err;
      // 其余（429 / 5xx / 网络错误）继续重试
    }
  }
  throw lastError;
}

/** 可被 AbortSignal 提前唤醒的 sleep */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
