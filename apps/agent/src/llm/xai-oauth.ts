/**
 * xAI Grok OAuth（SuperGrok / X Premium+）device-code 流。
 * 协议与 Hermes Agent 对齐：https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/xai-grok-oauth.md
 *
 * 注意：xAI 可能按订阅档位限制 OAuth API；失败时应回退 API Key。
 */
import type {
  AuthInteraction,
  ModelAuth,
  OAuthAuth,
  OAuthCredential,
} from '@earendil-works/pi-ai';
import { formatFetchError } from '../runtime/outbound-proxy.js';

const XAI_OAUTH_ISSUER = 'https://auth.x.ai';
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_OAUTH_DEVICE_CODE_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`;
const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const XAI_DEFAULT_TOKEN_ENDPOINT = `${XAI_OAUTH_ISSUER}/oauth2/token`;
const XAI_INFERENCE_BASE = 'https://api.x.ai/v1';

export const XAI_OAUTH_LABEL = 'xAI (SuperGrok / X Premium+)';

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
};

function isXaiHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'x.ai' || host.endsWith('.x.ai');
}

function assertXaiHttpsEndpoint(url: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid xAI ${field}: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`xAI ${field} must use https`);
  }
  if (!isXaiHost(parsed.hostname)) {
    throw new Error(`xAI ${field} host is not allowed: ${parsed.hostname}`);
  }
  return parsed.toString();
}

async function discoverTokenEndpoint(signal?: AbortSignal): Promise<string> {
  try {
    const res = await fetch(XAI_OAUTH_DISCOVERY_URL, {
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!res.ok) {
      return XAI_DEFAULT_TOKEN_ENDPOINT;
    }
    const body = (await res.json()) as {
      token_endpoint?: string;
      authorization_endpoint?: string;
    };
    if (typeof body.token_endpoint === 'string' && body.token_endpoint.trim()) {
      return assertXaiHttpsEndpoint(body.token_endpoint.trim(), 'token_endpoint');
    }
  } catch {
    // discovery 失败时回落默认 token endpoint
  }
  return XAI_DEFAULT_TOKEN_ENDPOINT;
}

function expiresAtMs(expiresInSeconds: number | undefined): number {
  const ttl = typeof expiresInSeconds === 'number' && expiresInSeconds > 0
    ? expiresInSeconds
    : 3600;
  return Date.now() + ttl * 1000;
}

function toOauthCredential(payload: TokenResponse): OAuthCredential {
  const access = String(payload.access_token ?? '').trim();
  const refresh = String(payload.refresh_token ?? '').trim();
  if (!access) throw new Error('xAI token response missing access_token');
  if (!refresh) throw new Error('xAI token response missing refresh_token');
  return {
    type: 'oauth',
    access,
    refresh,
    expires: expiresAtMs(payload.expires_in),
  };
}

async function requestDeviceCode(signal?: AbortSignal): Promise<DeviceCodeResponse> {
  let res: Response;
  try {
    res = await fetch(XAI_OAUTH_DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: XAI_OAUTH_CLIENT_ID,
        scope: XAI_OAUTH_SCOPE,
      }),
      signal,
    });
  } catch (err) {
    throw new Error(
      `xAI device-code 网络失败（无法访问 auth.x.ai）。`
      + `若使用系统代理，请在设置 → 通用 → 出站代理中填写同一代理。详情：${formatFetchError(err)}`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `xAI device-code request failed (HTTP ${res.status})${text ? `: ${text}` : ''}`,
    );
  }
  const payload = (await res.json()) as Partial<DeviceCodeResponse>;
  if (
    !payload.device_code
    || !payload.user_code
    || !payload.verification_uri
    || typeof payload.expires_in !== 'number'
    || typeof payload.interval !== 'number'
  ) {
    throw new Error('xAI device-code response incomplete');
  }
  return payload as DeviceCodeResponse;
}

async function pollDeviceToken(
  tokenEndpoint: string,
  deviceCode: string,
  expiresIn: number,
  intervalSeconds: number,
  callbacks: AuthInteraction,
): Promise<OAuthCredential> {
  const endpoint = assertXaiHttpsEndpoint(tokenEndpoint, 'token_endpoint');
  const deadline = Date.now() + Math.max(1, expiresIn) * 1000;
  let intervalMs = Math.max(1000, Math.floor(intervalSeconds * 1000));

  while (Date.now() < deadline) {
    if (callbacks.signal?.aborted) {
      throw new Error('cancelled');
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: XAI_OAUTH_CLIENT_ID,
        device_code: deviceCode,
      }),
      signal: callbacks.signal,
    });

    if (res.status === 200) {
      const payload = (await res.json()) as TokenResponse;
      return toOauthCredential(payload);
    }

    let errorCode = '';
    let description = '';
    try {
      const errBody = (await res.json()) as TokenResponse;
      errorCode = String(errBody.error ?? '');
      description = String(errBody.error_description ?? errBody.error ?? '');
    } catch {
      const text = await res.text().catch(() => '');
      throw new Error(
        `xAI device-code polling failed (HTTP ${res.status})${text ? `: ${text}` : ''}`,
      );
    }

    if (errorCode === 'authorization_pending') {
      callbacks.notify({ type: 'progress', message: 'Waiting for browser approval…' });
    } else if (errorCode === 'slow_down') {
      intervalMs = Math.min(intervalMs + 1000, 30_000);
      callbacks.notify({ type: 'progress', message: 'Slowing poll rate…' });
    } else {
      throw new Error(description || `xAI device-code failed: ${errorCode || res.status}`);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining), callbacks.signal);
  }

  throw new Error('Timed out waiting for xAI device authorization');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function refreshXaiToken(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredential> {
  const tokenEndpoint = await discoverTokenEndpoint(signal);
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: XAI_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }),
    signal,
  });

  if (res.status === 403) {
    throw new Error(
      'xAI OAuth refresh returned HTTP 403 (tier/entitlement). '
      + 'This SuperGrok account may not be allowed on the OAuth API surface. '
      + 'Use an XAI_API_KEY instead, or upgrade the subscription.',
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `xAI token refresh failed (HTTP ${res.status})${text ? `: ${text}` : ''}`,
    );
  }

  const payload = (await res.json()) as TokenResponse;
  const next = toOauthCredential({
    ...payload,
    // 部分实现不轮换 refresh_token
    refresh_token: payload.refresh_token || refreshToken,
  });
  return next;
}

export const xaiGrokOauth: OAuthAuth = {
  name: XAI_OAUTH_LABEL,
  async login(callbacks) {
    callbacks.notify({ type: 'progress', message: 'Starting xAI device login…' });
    const tokenEndpoint = await discoverTokenEndpoint(callbacks.signal);
    const device = await requestDeviceCode(callbacks.signal);
    const verificationUri = (
      device.verification_uri_complete || device.verification_uri
    ).trim();

    callbacks.notify({
      type: 'device_code',
      userCode: device.user_code,
      verificationUri,
      intervalSeconds: device.interval,
      expiresInSeconds: device.expires_in,
    });
    callbacks.notify({
      type: 'auth_url',
      url: verificationUri,
      instructions: 'Open the verification page and approve access for SuperGrok / X Premium+.',
    });

    return pollDeviceToken(
      tokenEndpoint,
      device.device_code,
      device.expires_in,
      device.interval,
      callbacks,
    );
  },
  async refresh(credential) {
    return refreshXaiToken(credential.refresh);
  },
  async toAuth(credential): Promise<ModelAuth> {
    return {
      apiKey: credential.access,
      baseUrl: XAI_INFERENCE_BASE,
    };
  },
};

export function providerIdSupportsXaiOauth(providerId: string): boolean {
  return providerId === 'xai';
}
