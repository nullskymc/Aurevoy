import type { Message } from "@aurevoy/shared";

export function formatContextK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function parseProviderModel(provider?: string | null): string {
  if (!provider || provider === "unconfigured") return "";
  const [, model] = provider.split(/:(.*)/s);
  return model ?? provider;
}

export async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  opts: { retries: number; baseDelayMs: number },
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= opts.retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < opts.retries) {
        await new Promise((r) => setTimeout(r, opts.baseDelayMs * Math.pow(2, i)));
      }
    }
  }
  throw lastErr;
}

export function mergeById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) return [...items, next];
  return items.map((item) => (item.id === next.id ? next : item));
}

export function createFailureMessage(taskId: string, message: string): Message {
  return {
    id: `failure-${taskId}-${Date.now()}`,
    role: "assistant",
    content: "",
    failure: { message, category: "unknown" },
    createdAt: new Date().toISOString(),
  };
}
