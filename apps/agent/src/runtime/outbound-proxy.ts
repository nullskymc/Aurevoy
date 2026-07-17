/**
 * Agent 出站 HTTP(S) 代理。
 *
 * Node 内置 fetch（undici）默认不走 Windows「系统代理」。
 * 设置页配置后：写入 HTTP(S)_PROXY + 安装 EnvHttpProxyAgent 全局 dispatcher，
 * 使 OAuth / LLM / 搜索等 fetch 走同一代理。
 */
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { getLogger } from '../logging/logger.js';

export type OutboundProxyConfig = {
  enabled: boolean;
  url: string;
  noProxy: string;
};

const DEFAULT_NO_PROXY = '127.0.0.1,localhost,::1';

/** 上次由本模块写入的 env，便于关闭时只清理自己设的值 */
let appliedEnv: { http?: string; https?: string; noProxy?: string; useEnv?: string } | null =
  null;

export function defaultNoProxy(): string {
  return DEFAULT_NO_PROXY;
}

/** 校验代理 URL：仅允许 http(s)://host:port[…] */
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
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('代理地址须以 http:// 或 https:// 开头（例如 http://127.0.0.1:7890）');
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
 * 应用出站代理到全局 fetch。
 * enabled=false 或 url 空：恢复直连。
 */
export function applyOutboundProxy(settings: OutboundProxyConfig): void {
  const log = getLogger('outbound-proxy');
  const enabled = Boolean(settings.enabled) && settings.url.trim().length > 0;

  if (!enabled) {
    clearProxyEnv();
    setGlobalDispatcher(new Agent());
    log.info('出站代理已关闭（直连）');
    return;
  }

  const url = validateProxyUrl(settings.url);
  const noProxy = normalizeNoProxy(settings.noProxy);

  // 同步 env：部分库 / NODE_USE_ENV_PROXY 路径会读这些变量
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

  log.info({ proxy: redactProxyUrl(url), noProxy }, '出站代理已启用');
}

function clearProxyEnv(): void {
  if (!appliedEnv) {
    // 仍重置 dispatcher；不擅自删用户启动时自带的 HTTP_PROXY
    return;
  }
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

/**
 * 用当前全局 dispatcher 探测出站是否可达（可选代理）。
 * 默认探测 auth.x.ai discovery，与 xAI OAuth 同路径。
 */
export async function testOutboundProxy(options?: {
  probeUrl?: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; status?: number; latencyMs: number; error?: string }> {
  const probeUrl =
    options?.probeUrl?.trim() || 'https://auth.x.ai/.well-known/openid-configuration';
  const started = Date.now();
  try {
    const res = await fetch(probeUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options?.signal ?? AbortSignal.timeout(12_000),
    });
    return {
      ok: res.ok,
      status: res.status,
      latencyMs: Date.now() - started,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (err) {
    const message = formatFetchError(err);
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: message,
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
