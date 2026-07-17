/**
 * Agent 出站 HTTP(S) 代理。
 *
 * 仅支持 HTTP 代理（`http://127.0.0.1:7890` 等）。
 * 通过 undici `EnvHttpProxyAgent` + `setGlobalDispatcher` 作用于 Node 内置 fetch。
 * 不支持 SOCKS5（undici 实现不稳定，请用 Clash 的 HTTP 入站端口）。
 */
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { getLogger } from '../logging/logger.js';

export type OutboundProxyConfig = {
  enabled: boolean;
  url: string;
  noProxy: string;
};

const DEFAULT_NO_PROXY = '127.0.0.1,localhost,::1';

let proxyActive = false;
let proxyUrlRedacted: string | null = null;

/** 上次由本模块写入的 env，便于关闭时只清理自己设的值 */
let appliedEnv: {
  http?: string;
  https?: string;
  noProxy?: string;
  useEnv?: string;
} | null = null;

export function defaultNoProxy(): string {
  return DEFAULT_NO_PROXY;
}

/**
 * 校验代理 URL：仅允许 http:// 或 https://
 */
export function validateProxyUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('代理地址不能为空');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`代理地址无效：${trimmed}`);
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol === 'socks5:' || protocol === 'socks:') {
    throw new Error(
      '已不再支持 SOCKS5。请改用 HTTP 代理地址（例如 Clash 的 http://127.0.0.1:7890）',
    );
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(
      '代理地址须以 http:// 或 https:// 开头（例如 http://127.0.0.1:7890）',
    );
  }
  if (!parsed.hostname) {
    throw new Error('代理地址缺少主机名');
  }
  return parsed.toString().replace(/\/+$/, '');
}

export function normalizeNoProxy(raw: string | undefined): string {
  const parts = String(raw ?? '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return DEFAULT_NO_PROXY;
  return [...new Set(parts)].join(',');
}

/**
 * 应用出站 HTTP 代理到全局 fetch。
 * enabled=false 或 url 空：恢复直连。
 * 若 URL 为已废弃的 socks5://，记录警告并回落直连（避免启动崩溃）。
 */
export function applyOutboundProxy(settings: OutboundProxyConfig): void {
  const log = getLogger('outbound-proxy');
  const enabled = Boolean(settings.enabled) && settings.url.trim().length > 0;

  if (!enabled) {
    clearProxyEnv();
    setGlobalDispatcher(new Agent());
    proxyActive = false;
    proxyUrlRedacted = null;
    log.info('出站代理已关闭（直连）');
    return;
  }

  let url: string;
  try {
    url = validateProxyUrl(settings.url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    clearProxyEnv();
    setGlobalDispatcher(new Agent());
    proxyActive = false;
    proxyUrlRedacted = null;
    log.warn({ err: message, url: settings.url }, '出站代理配置无效，已回落直连');
    return;
  }

  const noProxy = normalizeNoProxy(settings.noProxy);
  clearProxyEnv();

  process.env.HTTP_PROXY = url;
  process.env.HTTPS_PROXY = url;
  process.env.http_proxy = url;
  process.env.https_proxy = url;
  process.env.NO_PROXY = noProxy;
  process.env.no_proxy = noProxy;
  process.env.NODE_USE_ENV_PROXY = '1';
  appliedEnv = {
    http: url,
    https: url,
    noProxy,
    useEnv: '1',
  };

  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      httpProxy: url,
      httpsProxy: url,
      noProxy,
    }),
  );

  proxyActive = true;
  proxyUrlRedacted = redactProxyUrl(url);
  log.info({ proxy: proxyUrlRedacted, noProxy }, '出站 HTTP 代理已启用');
}

function clearProxyEnv(): void {
  if (!appliedEnv) return;
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'http_proxy',
    'https_proxy',
    'NO_PROXY',
    'no_proxy',
    'NODE_USE_ENV_PROXY',
  ] as const) {
    delete process.env[key];
  }
  appliedEnv = null;
}

function redactProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = u.username ? '***' : '';
      u.password = u.password ? '***' : '';
    }
    return u.toString().replace(/\/+$/, '');
  } catch {
    return '[invalid]';
  }
}

export type OutboundProbeResult = {
  ok: boolean;
  status?: number;
  latencyMs: number;
  error?: string;
  viaProxy: string | null;
  proxyEnabled: boolean;
  bodySnippet?: string;
};

/** 用当前全局 dispatcher 探测出站。 */
export async function testOutboundProxy(options?: {
  probeUrl?: string;
  signal?: AbortSignal;
}): Promise<OutboundProbeResult> {
  const probeUrl =
    options?.probeUrl?.trim() || 'https://www.wikipedia.org/';
  const started = Date.now();
  try {
    const res = await fetch(probeUrl, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
      signal: options?.signal ?? AbortSignal.timeout(12_000),
    });
    let bodySnippet: string | undefined;
    if (!res.ok) {
      try {
        bodySnippet = (await res.text()).slice(0, 200).replace(/\s+/g, ' ');
      } catch {
        bodySnippet = undefined;
      }
    }
    return {
      ok: res.ok,
      status: res.status,
      latencyMs: Date.now() - started,
      error: res.ok ? undefined : `HTTP ${res.status}${bodySnippet ? `: ${bodySnippet}` : ''}`,
      viaProxy: proxyUrlRedacted,
      proxyEnabled: proxyActive,
      bodySnippet,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: formatFetchError(err),
      viaProxy: proxyUrlRedacted,
      proxyEnabled: proxyActive,
    };
  }
}

export function formatFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.message];
  let cause: unknown = (err as { cause?: unknown }).cause;
  let depth = 0;
  while (cause instanceof Error && depth < 4) {
    parts.push(cause.message);
    cause = (cause as { cause?: unknown }).cause;
    depth += 1;
  }
  return parts.filter(Boolean).join(' → ');
}

export function isOutboundProxyActive(): boolean {
  return proxyActive;
}

export function activeOutboundProxySummary(): string | null {
  return proxyUrlRedacted;
}

export function withProxyHint(message: string): string {
  const summary = activeOutboundProxySummary();
  if (!summary) return message;
  return (
    `${message}`
    + `（Agent 出站代理：${summary}。请确认使用 HTTP 代理端口，例如 http://127.0.0.1:7890；不再支持 socks5://）`
  );
}
