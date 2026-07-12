import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const credentialState = vi.hoisted(() => ({
  credential: undefined as Record<string, unknown> | undefined,
}));

// 模型发现只关心凭证语义，隔离 SQLite 以避免测试触碰用户的真实登录状态。
vi.mock('./llm-store.js', () => ({
  deleteLlmCredential: vi.fn(),
  ensureLlmSchemaMigrated: vi.fn(),
  ensureProviderRow: vi.fn(),
  getLlmProvider: vi.fn(() => undefined),
  hasLlmApiKeyCredential: vi.fn(() => false),
  hasLlmCredential: vi.fn(() => Boolean(credentialState.credential)),
  hasLlmOauthCredential: vi.fn(() => credentialState.credential?.type === 'oauth'),
  readLlmCredential: vi.fn(() => credentialState.credential),
  writeLlmCredential: vi.fn(),
}));

import { config } from '../config.js';
import { listPiProviderModels, resetPiProviderCache } from './pi-provider.js';

const originalLlm = { ...config.llm };

function createJwt(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
  ).toString('base64url');
  return `header.${payload}.signature`;
}

describe('listPiProviderModels Codex OAuth discovery', () => {
  beforeEach(() => {
    Object.assign(config.llm, originalLlm, {
      provider: 'openai-codex',
      baseUrl: '',
      apiKey: '',
      model: 'gpt-5.4',
    });
    credentialState.credential = {
      type: 'oauth',
      access: createJwt('acct_test'),
      refresh: 'refresh_test',
      expires: Date.now() + 60_000,
      accountId: 'acct_test',
    };
    resetPiProviderCache();
  });

  afterEach(() => {
    Object.assign(config.llm, originalLlm);
    credentialState.credential = undefined;
    resetPiProviderCache();
    vi.unstubAllGlobals();
  });

  it('uses the Codex model source with refreshed OAuth auth and excludes unsupported entries', async () => {
    const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      models: [
        { slug: 'gpt-5.999-codex', supported_in_api: true, visibility: 'list' },
        { slug: 'gpt-internal-preview', supported_in_api: false, visibility: 'list' },
        { slug: 'gpt-hidden', supported_in_api: true, visibility: 'hidden' },
      ],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const models = await listPiProviderModels();

    expect(models).toContain('gpt-5.999-codex');
    expect(models).not.toContain('gpt-internal-preview');
    expect(models).not.toContain('gpt-hidden');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [input, init] = call!;
    const url = new URL(String(input));
    expect(url.origin).toBe('https://chatgpt.com');
    expect(url.pathname).toBe('/backend-api/codex/models');
    expect(url.searchParams.get('client_version')).toBe('1.0.0');
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${(credentialState.credential as { access: string }).access}`,
      'ChatGPT-Account-Id': 'acct_test',
      Originator: 'pi',
    });
  });
});

describe('listPiProviderModels OpenAI-compatible discovery', () => {
  beforeEach(() => {
    Object.assign(config.llm, originalLlm, {
      provider: 'openai-compatible',
      baseUrl: 'https://gateway.example.test/v1',
      apiKey: 'gateway_key',
      model: 'existing-model',
    });
    credentialState.credential = undefined;
    resetPiProviderCache();
  });

  afterEach(() => {
    Object.assign(config.llm, originalLlm);
    resetPiProviderCache();
    vi.unstubAllGlobals();
  });

  it('uses the selected custom slot URL rather than an inferred provider default', async () => {
    const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'gateway-model' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const models = await listPiProviderModels();

    expect(models).toContain('gateway-model');
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [input, init] = call!;
    expect(String(input)).toBe('https://gateway.example.test/v1/models');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer gateway_key' });
  });
});
