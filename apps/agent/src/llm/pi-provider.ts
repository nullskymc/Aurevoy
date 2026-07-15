import {
  getModel,
  type Model as PiModel,
  openAICompletionsApi,
} from '@earendil-works/pi-ai/compat';
import {
  createModels,
  createProvider,
  type Models as PiModels,
  type Provider as PiProvider,
} from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { filterChatModelIds, type PiProviderCatalogEntry } from '@aurevoy/shared';
import { config } from '../config.js';
import { aurevoyCredentialStore, hasStoredCredential } from './credential-store.js';
import {
  ensureLlmSchemaMigrated,
  getLlmProvider,
  modelSupportsImage,
  readLlmCredential,
} from './llm-store.js';
import { providerIdSupportsXaiOauth, XAI_OAUTH_LABEL } from './xai-oauth.js';

// ---- Dynamic model discovery via Pi's createProvider + refreshModels ----

let _piModelsCache: PiModels | null = null;

function getPiModels(): PiModels {
  if (_piModelsCache) return _piModelsCache;
  // 复用运行时凭证库：模型发现也能让 Pi 自动刷新 OAuth access token。
  const models = createModels({ credentials: aurevoyCredentialStore });
  for (const provider of builtinProviders()) {
    models.setProvider(provider);
  }
  models.setProvider(createOpenAICompatProvider());
  _piModelsCache = models;
  return _piModelsCache;
}

function createOpenAICompatProvider() {
  return createProvider({
    id: 'openai-compatible',
    name: 'OpenAI Compatible',
    baseUrl: config.llm.baseUrl,
    auth: { apiKey: { name: 'none', resolve: async () => undefined } },
    models: [],
    refreshModels: async () => {
      const base = config.llm.baseUrl.replace(/\/+$/, '');
      const resp = await fetch(`${base}/models`, {
        headers: config.llm.apiKey ? { Authorization: `Bearer ${config.llm.apiKey}` } : {},
      });
      if (!resp.ok) {
        throw new Error(`Failed to fetch models from ${base}/models: ${resp.status} ${resp.statusText}`);
      }
      const json = (await resp.json()) as { data?: { id: string }[] };
      return (json.data ?? []).map((item) => ({
        id: item.id,
        name: item.id,
        api: 'openai-completions' as const,
        provider: 'openai-compatible',
        baseUrl: config.llm.baseUrl,
        reasoning: false,
        input: ['text', 'image'] as const,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: config.agent.contextTokenBudget,
        maxTokens: config.llm.maxTokens,
      }));
    },
    api: openAICompletionsApi(),
  });
}

// ---- Public API ----

/**
 * 暴露 Pi 对各家 provider 的元数据（协议 apis、鉴权形态、默认 baseUrl）。
 * 前端只做展示/接入，不在 Aurevoy 侧复刻各家协议差异。
 */
export function listPiProviderCatalog(): PiProviderCatalogEntry[] {
  const entries = builtinProviders().map((provider) => toCatalogEntry(provider));
  // 自定义 OpenAI 兼容端：Aurevoy 合成，不在 Pi 内置列表
  entries.push({
    id: 'openai-compatible',
    name: 'OpenAI Compatible / Custom',
    defaultBaseUrl: '',
    apis: ['openai-completions'],
    supportsApiKey: true,
    apiKeyLabel: 'API key',
    supportsOauth: false,
    modelCount: 0,
    requiresBaseUrl: true,
    custom: true,
  });
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function toCatalogEntry(provider: PiProvider): PiProviderCatalogEntry {
  const models = provider.getModels();
  const apis = [...new Set(models.map((model) => model.api).filter(Boolean))].sort();
  // xAI：Pi 仅 API Key；Aurevoy 叠加 SuperGrok / X Premium+ device-code OAuth
  const supportsOauth =
    Boolean(provider.auth.oauth) || providerIdSupportsXaiOauth(provider.id);
  return {
    id: provider.id,
    name: provider.name || provider.id,
    defaultBaseUrl: (provider.baseUrl ?? '').replace(/\/+$/, ''),
    apis: apis.length > 0 ? apis : [fallbackApiForProvider(provider.id)],
    supportsApiKey: Boolean(provider.auth.apiKey),
    apiKeyLabel: provider.auth.apiKey?.name,
    supportsOauth,
    oauthLabel:
      provider.auth.oauth?.name
      ?? (providerIdSupportsXaiOauth(provider.id) ? XAI_OAUTH_LABEL : undefined),
    modelCount: models.length,
    requiresBaseUrl: false,
    custom: false,
  };
}

export function getPiProviderName(): string {
  return isPiLLMConfigured() ? `${config.llm.provider}:${config.llm.model}` : 'unconfigured';
}

export function isPiLLMConfigured(): boolean {
  if (!isValidPiProviderId(config.llm.provider)) return false;
  if (config.llm.apiKey?.trim()) return true;
  // OAuth / 分槽凭证（CredentialStore）
  return hasStoredCredential(config.llm.provider);
}

export function assertPiLLMConfigured(): void {
  if (!isValidPiProviderId(config.llm.provider)) {
    throw new Error(`未支持的 Provider id: "${config.llm.provider}"。仅允许小写字母、数字和连字符。`);
  }
  if (!isPiLLMConfigured()) {
    throw new Error(
      '未配置 LLM 凭证。请在设置中为当前 Provider 配置 API Key，或使用订阅登录。',
    );
  }
}

/**
 * 按 provider 槽位解析请求端点，避免扁平 `config.llm.baseUrl` 跨槽串用。
 *
 * 优先级：
 * 1. llm_providers.base_url（表内有行时：空串 = 明确使用 catalog 默认）
 * 2. 仅当请求的是**当前激活** provider 且表无行时，回退扁平 `config.llm.baseUrl`
 * 3. 模型 catalog / 调用方传入的默认 baseUrl
 */
export function resolveModelBaseUrl(modelBaseUrl?: string, provider?: string): string {
  ensureLlmSchemaMigrated();
  const providerId = (provider ?? config.llm.provider).trim();
  const slot = getLlmProvider(providerId);
  if (slot) {
    const fromSlot = slot.baseUrl.trim().replace(/\/+$/, '');
    if (fromSlot) return fromSlot;
    return (modelBaseUrl ?? '').replace(/\/+$/, '');
  }

  if (providerId === config.llm.provider) {
    const configured = config.llm.baseUrl?.trim().replace(/\/+$/, '');
    if (configured) return configured;
  }
  return (modelBaseUrl ?? '').replace(/\/+$/, '');
}

/**
 * 第三方网关通常只有 chat/completions：把官方 OpenAI Responses 降级为 completions。
 *
 * 注意：
 * - `openai-codex-responses` 必须走 chatgpt.com Codex 协议，**绝不能**降级，
 *   否则会打到 /backend-api/chat/completions 并被 Cloudflare 403。
 * - chatgpt.com 是 Codex 官方端点，不是「第三方网关」。
 */
export function resolveModelApi(api: string | undefined, baseUrl: string, provider: string): string {
  const resolved = api || fallbackApiForProvider(provider);
  // Codex 订阅协议：始终保留
  if (resolved === 'openai-codex-responses' || provider === 'openai-codex') {
    return 'openai-codex-responses';
  }
  // 仅对「真·OpenAI Responses」在非官方主机上降级
  if (resolved === 'openai-responses' && !isOfficialOpenAIHost(baseUrl) && !isCodexHost(baseUrl)) {
    return 'openai-completions';
  }
  return resolved;
}

/**
 * @param modelOverride 覆盖模型 id（用于显式调用方测试或高级路由）
 * @param providerOverride 覆盖 provider（避免使用激活槽的 baseUrl）
 */
export function createPiModel(modelOverride?: string, providerOverride?: string): PiModel<any> {
  const provider = normalizePiProvider(providerOverride?.trim() || config.llm.provider);
  const modelId = modelOverride?.trim() || config.llm.model;
  const builtin = (getModel as (provider: string, model: string) => PiModel<any> | undefined)(
    provider,
    modelId,
  );
  if (builtin) {
    const baseUrl = resolveModelBaseUrl(builtin.baseUrl, provider);
    const withBaseUrl = {
      ...builtin,
      baseUrl,
      api: resolveModelApi(builtin.api, baseUrl, provider) as typeof builtin.api,
    };
    // 确保 DeepSeek / Qwen builtin 模型在 compat 缺失时仍有 reasoning_content 重放字段
    const needCompat = (
      withBaseUrl.provider === 'deepseek' ||
      withBaseUrl.provider === 'qwen' ||
      provider === 'deepseek' ||
      provider === 'qwen'
    );
    if (needCompat && !(isRecord(withBaseUrl.compat) && withBaseUrl.compat.requiresReasoningContentOnAssistantMessages === true)) {
      return {
        ...withBaseUrl,
        compat: {
          ...(isRecord(withBaseUrl.compat) ? withBaseUrl.compat : {}),
          requiresReasoningContentOnAssistantMessages: true,
        },
      };
    }
    return withBaseUrl;
  }
  const baseUrl = resolveModelBaseUrl(undefined, provider);
  const api = resolveModelApi(fallbackApiForProvider(provider), baseUrl, provider);
  const openAICompat = api === 'openai-completions'
    ? openAICompletionsFallbackCompat(provider, baseUrl, modelId)
    : undefined;
  return {
    id: modelId,
    name: modelId,
    api,
    provider,
    baseUrl,
    reasoning: openAICompat?.reasoning ?? false,
    ...(openAICompat?.thinkingLevelMap ? { thinkingLevelMap: openAICompat.thinkingLevelMap } : {}),
    // 自定义模型的图片能力来自本机注册表；未声明时在运行前明确拒绝图片请求。
    input: modelSupportsImage(provider, modelId) ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.agent.contextTokenBudget,
    maxTokens: config.llm.maxTokens,
    ...(openAICompat?.compat ? { compat: openAICompat.compat } : {}),
  };
}

/**
 * 拉取当前激活 provider 的模型目录。
 *
 * 策略（优先 API，静态目录兜底）：
 * 1. OpenAI 兼容族：`GET {base}/models`（或 `/v1/models`）
 * 2. openai-codex：仅在有 OAuth access token 时请求 ChatGPT backend
 * 3. 合并 Pi 静态 catalog（API 失败或不全时不丢已知 id）
 * 4. 仍为空时回落当前主模型 id；远程明确失败且无任何列表则抛错
 */
export async function listPiProviderModels(): Promise<string[]> {
  // 目录请求必须使用用户实际选择的槽位：`openai-compatible` 经 host 推断后会变成
  // qwen/deepseek 等 id，若拿推断 id 解析 Base URL 会绕过用户填写的网关地址。
  const selectedProvider = config.llm.provider.trim();
  const normalized = normalizePiProvider(selectedProvider);
  const staticIds = listStaticProviderModelIds(normalized);
  let remoteIds: string[] = [];
  let remoteError: Error | undefined;
  let remoteAttempted = false;

  try {
    if (selectedProvider === 'openai-codex') {
      remoteAttempted = true;
      remoteIds = await fetchCodexModelIds();
    } else if (
      selectedProvider === 'openai-compatible'
      || supportsOpenAiStyleModelsApi(selectedProvider)
    ) {
      remoteAttempted = true;
      remoteIds = await fetchOpenAiCompatibleModelIds(selectedProvider);
    }
  } catch (err) {
    remoteError = err instanceof Error ? err : new Error(String(err));
  }

  // 远程有结果：以远程为主，并并入静态（避免官方新 id 覆盖旧静态时丢已知项）
  if (remoteIds.length > 0) {
    const merged = filterChatModelIds([...remoteIds, ...staticIds]);
    return [...new Set(merged)].sort((a, b) => a.localeCompare(b));
  }

  // 远程失败：
  // - openai-compatible 无静态目录 → 必须抛错
  // - 其它有静态目录 → 回落静态，但错误信息在日志层；若静态也空则抛远程错误
  if (remoteAttempted && remoteError) {
    if (selectedProvider === 'openai-compatible' || staticIds.length === 0) {
      throw remoteError;
    }
  }

  const staticOnly = filterChatModelIds(staticIds);
  if (staticOnly.length > 0) {
    return [...new Set(staticOnly)].sort((a, b) => a.localeCompare(b));
  }

  const fallback = config.llm.model.trim();
  return fallback ? [fallback] : [];
}

function listStaticProviderModelIds(provider: string): string[] {
  try {
    return getPiModels()
      .getModels(provider)
      .map((m) => m.id)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 走 OpenAI 风格 `/models` 的 provider（含多数网关）。 */
function supportsOpenAiStyleModelsApi(provider: string): boolean {
  // 明确不走 OpenAI /models 的协议族
  if (
    provider === 'anthropic'
    || provider === 'amazon-bedrock'
    || provider === 'google'
    || provider === 'google-vertex'
    || provider === 'mistral'
    || provider === 'azure-openai-responses'
    || provider === 'openai-codex'
  ) {
    return false;
  }
  return true;
}

async function resolveProviderAuthToken(provider: string): Promise<string | undefined> {
  ensureLlmSchemaMigrated();
  // 先交由 Pi 解析，OAuth token 过期时会在 CredentialStore 内自动刷新。
  const knownModel = getPiModels().getModels(provider)[0];
  if (knownModel) {
    const resolved = await getPiModels().getAuth(knownModel);
    const token = resolved?.auth.apiKey?.trim();
    if (token) return token;
  }

  // 自定义 provider 没有 Pi 静态模型，保留本地凭证与当前槽内存 key 的回退。
  const stored = readLlmCredential(provider);
  if (stored?.type === 'api_key') {
    const key = String((stored as { key?: string }).key ?? '').trim();
    if (key) return key;
  }
  if (stored?.type === 'oauth') {
    const access = String((stored as { access?: string }).access ?? '').trim();
    if (access) return access;
  }
  // 仅当本 provider 是激活槽且内存有 key 时回退（不跨槽）
  if (provider === config.llm.provider && config.llm.apiKey?.trim()) {
    return config.llm.apiKey.trim();
  }
  return undefined;
}

/**
 * 解析 Codex 的 OAuth 访问令牌。
 *
 * 必须通过 Pi 的 `Models.getAuth()` 获取：它会在 access token 过期时使用
 * CredentialStore 串行刷新并落盘，避免模型发现与真实调用使用不同的凭证状态。
 */
async function resolveCodexOauthAccessToken(): Promise<{ token: string; accountId?: string } | undefined> {
  const codexModel = getPiModels().getModels('openai-codex')[0];
  if (!codexModel) return undefined;

  const resolved = await getPiModels().getAuth(codexModel);
  const token = resolved?.auth.apiKey?.trim();
  if (!token || token.split('.').length !== 3) return undefined;

  const stored = readLlmCredential('openai-codex');
  const storedAccountId = (stored as { accountId?: unknown } | undefined)?.accountId;
  const accountId =
    (stored?.type === 'oauth' && typeof storedAccountId === 'string' && storedAccountId.trim())
    || extractCodexAccountId(token);
  return { token, accountId: accountId || undefined };
}

function resolveProviderModelsBaseUrl(provider: string): string {
  const builtin = findBuiltinProviderMeta(provider);
  return resolveModelBaseUrl(builtin?.baseUrl, provider).replace(/\/+$/, '');
}

function findBuiltinProviderMeta(providerId: string) {
  return builtinProviders().find((p) => p.id === providerId);
}

function candidateModelsUrls(baseUrl: string): string[] {
  const base = baseUrl.replace(/\/+$/, '');
  if (!base) return [];
  const urls = new Set<string>();
  if (base.endsWith('/v1')) {
    urls.add(`${base}/models`);
  } else {
    urls.add(`${base}/models`);
    urls.add(`${base}/v1/models`);
  }
  return [...urls];
}

async function fetchOpenAiCompatibleModelIds(provider: string): Promise<string[]> {
  const baseUrl = resolveProviderModelsBaseUrl(provider);
  if (!baseUrl) {
    throw new Error(`Provider "${provider}" 未配置 Base URL，无法拉取模型列表`);
  }
  const token = await resolveProviderAuthToken(provider);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let lastError: Error | undefined;
  for (const url of candidateModelsUrls(baseUrl)) {
    try {
      const ids = await fetchOpenAiModelsJson(url, headers);
      if (ids.length > 0) return ids;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  if (lastError) throw lastError;
  return [];
}

async function fetchOpenAiModelsJson(
  url: string,
  headers: Record<string, string>,
): Promise<string[]> {
  const resp = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(
      `拉取模型列表失败 ${url} (HTTP ${resp.status})${text ? `: ${text.slice(0, 200)}` : ''}`,
    );
  }
  const json = (await resp.json()) as
    | { data?: Array<{ id?: string } | string> }
    | Array<{ id?: string } | string>
    | { models?: Array<{ id?: string; slug?: string } | string> };
  return parseModelListPayload(json);
}

function parseModelListPayload(json: unknown): string[] {
  const out: string[] = [];
  const push = (raw: unknown) => {
    if (typeof raw === 'string' && raw.trim()) {
      out.push(raw.trim());
      return;
    }
    if (raw && typeof raw === 'object') {
      const rec = raw as {
        id?: unknown;
        slug?: unknown;
        name?: unknown;
        model?: unknown;
        models?: unknown;
      };
      const id =
        (typeof rec.id === 'string' && rec.id.trim())
        || (typeof rec.slug === 'string' && rec.slug.trim())
        || (typeof rec.model === 'string' && rec.model.trim())
        || (typeof rec.name === 'string' && rec.name.trim())
        || '';
      if (id) out.push(id);
      // ChatGPT backend 常见嵌套：category.models[]
      if (Array.isArray(rec.models)) {
        for (const nested of rec.models) push(nested);
      }
    }
  };

  if (Array.isArray(json)) {
    for (const item of json) push(item);
    return out;
  }
  if (!json || typeof json !== 'object') return out;
  const obj = json as {
    data?: unknown;
    models?: unknown;
    categories?: unknown;
  };
  if (Array.isArray(obj.data)) {
    for (const item of obj.data) push(item);
  }
  if (Array.isArray(obj.models)) {
    for (const item of obj.models) push(item);
  }
  if (Array.isArray(obj.categories)) {
    for (const cat of obj.categories) push(cat);
  }
  return out;
}

/**
 * Codex 的模型目录不是通用 `/models`：它位于 ChatGPT backend 的
 * `/codex/models`，并要求 `client_version`、账户标识和 Codex 请求头。
 * 这是模型发现协议；实际生成仍由 Pi 的 `openai-codex-responses` 处理。
 */
async function fetchCodexModelIds(): Promise<string[]> {
  const auth = await resolveCodexOauthAccessToken();
  if (!auth) {
    throw new Error(
      'OpenAI Codex 未完成订阅登录（需要有效的 OAuth access token），无法从 API 拉取模型列表。'
      + '请先在提供商页对 Codex 执行订阅登录。',
    );
  }

  const baseUrl = resolveProviderModelsBaseUrl('openai-codex');
  if (!baseUrl) {
    throw new Error('OpenAI Codex 未配置模型目录 Base URL');
  }

  const url = buildCodexModelsUrl(baseUrl);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${auth.token}`,
    // 与 Pi 的 Codex transport 对齐，避免 ChatGPT backend 将目录请求当成网页请求。
    Originator: 'pi',
    'User-Agent': 'pi',
  };
  if (auth.accountId) {
    headers['ChatGPT-Account-Id'] = auth.accountId;
  }

  const models = await fetchCodexModelsJson(url, headers);
  return filterChatModelIds(models);
}

/**
 * Codex backend 根据客户端版本筛选目录。使用协议版本 1.0.0 获取当前可用模型，
 * 避免把 Aurevoy 或 Pi 的发布版本误当成 Codex CLI 版本而过滤掉新模型。
 */
function buildCodexModelsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const codexBase = base.endsWith('/codex') ? base : `${base}/codex`;
  const url = new URL(`${codexBase}/models`);
  url.searchParams.set('client_version', '1.0.0');
  return url.toString();
}

/** 只保留 Codex API 明确标记为可调用的模型，防止目录中隐藏项被写入设置。 */
async function fetchCodexModelsJson(
  url: string,
  headers: Record<string, string>,
): Promise<string[]> {
  const resp = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(
      `拉取 Codex 模型列表失败 ${url} (HTTP ${resp.status})${text ? `: ${text.slice(0, 200)}` : ''}`,
    );
  }

  const json = (await resp.json()) as { models?: unknown };
  if (!Array.isArray(json.models)) return [];
  return json.models.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const model = raw as { slug?: unknown; id?: unknown; supported_in_api?: unknown; visibility?: unknown };
    if (model.supported_in_api !== true || model.visibility === 'hidden') return [];
    const id =
      (typeof model.slug === 'string' && model.slug.trim())
      || (typeof model.id === 'string' && model.id.trim())
      || '';
    return id ? [id] : [];
  });
}

function extractCodexAccountId(accessToken: string): string | undefined {
  try {
    const parts = accessToken.split('.');
    if (parts.length < 2) return undefined;
    const payload = parts[1] ?? '';
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const auth = parsed['https://api.openai.com/auth'];
    if (auth && typeof auth === 'object') {
      const accountId = (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id;
      if (typeof accountId === 'string' && accountId.trim()) return accountId.trim();
    }
  } catch {
    // ignore
  }
  return undefined;
}

export function resetPiProviderCache(): void {
  _piModelsCache = null;
}

function isValidPiProviderId(provider: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(provider.trim().toLowerCase());
}

function normalizePiProvider(provider: string): string {
  if (provider === 'anthropic') return 'anthropic';
  if (provider === 'openai-response' || provider === 'openai') return 'openai';
  if (provider === 'openai-compatible') return inferOpenAICompatibleProvider(config.llm.baseUrl);
  return provider;
}

function fallbackApiForProvider(provider: string): string {
  switch (provider) {
    case 'anthropic':
      return 'anthropic-messages';
    case 'google':
      return 'google-generative-ai';
    case 'google-vertex':
      return 'google-vertex';
    case 'mistral':
      return 'mistral-conversations';
    case 'amazon-bedrock':
      return 'bedrock-converse-stream';
    case 'azure-openai-responses':
      return 'azure-openai-responses';
    case 'openai-codex':
      return 'openai-codex-responses';
    case 'openai-response':
      return 'openai-responses';
    default:
      return 'openai-completions';
  }
}

function inferOpenAICompatibleProvider(baseUrl: string): string {
  const host = safeHost(baseUrl);
  if (host.includes('deepseek')) return 'deepseek';
  if (host.includes('openrouter')) return 'openrouter';
  if (host.includes('api.openai.com')) return 'openai';
  return 'openai-compatible';
}

function openAICompletionsFallbackCompat(provider: string, baseUrl: string, model: string): {
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
} {
  const host = safeHost(baseUrl);
  const modelId = model.toLowerCase();
  const isDeepSeekStyle =
    provider === 'deepseek' ||
    host.includes('deepseek') ||
    host.includes('xiaomimimo') ||
    modelId.includes('deepseek') ||
    modelId.includes('mimo') ||
    modelId.includes('r1');
  const isQwenStyle =
    host.includes('dashscope') ||
    host.includes('aliyuncs') ||
    modelId.includes('qwen');

  if (!isDeepSeekStyle && !isQwenStyle) {
    return { reasoning: false };
  }

  return {
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: null },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: isQwenStyle ? 'qwen-chat-template' : 'deepseek',
    },
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isOfficialOpenAIHost(baseUrl: string): boolean {
  const host = safeHost(baseUrl);
  return host === 'api.openai.com' || host.endsWith('.openai.azure.com');
}

/** ChatGPT / Codex 订阅官方主机（backend-api） */
function isCodexHost(baseUrl: string): boolean {
  const host = safeHost(baseUrl);
  return host === 'chatgpt.com' || host.endsWith('.chatgpt.com');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
