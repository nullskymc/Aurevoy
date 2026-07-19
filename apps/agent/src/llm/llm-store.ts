/**
 * Multi-provider LLM 持久化真相源。
 *
 * 表：
 * - llm_global：激活 provider + 温度等全局项
 * - llm_providers：每 provider 连接（baseUrl / default model / maxTokens）
 * - llm_credentials：每 provider 唯一鉴权（api_key | oauth 互斥）
 * - llm_models：每 provider 模型目录（available/enabled/default）
 *
 * 旧 app_settings 扁平键（llm.provider / llm.providers / llm.apiKey.* 等）
 * 仅作一次性迁移来源，迁移后不再写入。
 */
import type { Credential } from '@earendil-works/pi-ai';
import { getModel } from '@earendil-works/pi-ai/compat';
import { filterChatModelIds } from '@aurevoy/shared';
import { db, settingsStore } from '../store/db.js';

const SCHEMA_VERSION_KEY = 'schema.llm.version';
const SCHEMA_VERSION = '3';
/** 一次性：把 catalog 可知的图片能力写回 supports_image=0 的旧行。 */
const IMAGE_CAPABILITY_BACKFILL_KEY = 'schema.llm.image_capability_backfill';

export type LlmAuthType = 'api_key' | 'oauth';
export type LlmModelSource = 'remote' | 'static' | 'custom';

export interface LlmGlobalRow {
  activeProvider: string;
  temperature: number;
  timeoutMs: number;
  maxTokens: number;
}

export interface LlmProviderRow {
  providerId: string;
  baseUrl: string;
  defaultModel: string;
  maxTokens: number | null;
  enabled: boolean;
}

export interface LlmModelRow {
  providerId: string;
  modelId: string;
  source: LlmModelSource;
  enabled: boolean;
  isDefault: boolean;
  supportsImage: boolean;
  sortOrder: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isValidProviderId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Schema migration from app_settings KV
// ---------------------------------------------------------------------------

export function ensureLlmSchemaMigrated(): void {
  ensureImageCapabilityColumn();
  const current = settingsStore.get(SCHEMA_VERSION_KEY);
  if (current === SCHEMA_VERSION) {
    // 表可能在新安装时已建；保证至少有 global 行
    ensureGlobalRow();
    backfillImageCapabilityFromCatalog();
    return;
  }
  // 已迁移过正式表的用户只补充新列，不能再用旧 KV 覆盖现有 Provider/模型设置。
  if (current) {
    settingsStore.set(SCHEMA_VERSION_KEY, SCHEMA_VERSION);
    ensureGlobalRow();
    backfillImageCapabilityFromCatalog();
    return;
  }
  migrateFromAppSettingsKv();
  settingsStore.set(SCHEMA_VERSION_KEY, SCHEMA_VERSION);
  ensureGlobalRow();
  // 首次 KV 迁移已在 insert 时调用 inferSupportsImage；标记回填完成避免重复。
  settingsStore.set(IMAGE_CAPABILITY_BACKFILL_KEY, '1');
}

/** 为已有数据库补上模型图片能力列；能力只在本机注册表中保存。 */
function ensureImageCapabilityColumn(): void {
  const columns = db.prepare('PRAGMA table_info(llm_models)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'supports_image')) {
    db.exec('ALTER TABLE llm_models ADD COLUMN supports_image INTEGER NOT NULL DEFAULT 0');
  }
}

function inferSupportsImage(providerId: string, modelId: string): boolean {
  try {
    return Boolean(
      (getModel as (provider: string, model: string) => { input?: string[] } | undefined)(providerId, modelId)
        ?.input?.includes('image'),
    );
  } catch {
    return false;
  }
}

/**
 * 一次性把 Pi catalog 已知支持图片的模型从 supports_image=0 提升为 1。
 * 只升不降；回填仅跑一次。
 * 目录模型以 Pi 注册表为准；自定义模型仅在「添加」时声明图像能力。
 */
function backfillImageCapabilityFromCatalog(): void {
  if (settingsStore.get(IMAGE_CAPABILITY_BACKFILL_KEY) === '1') return;
  const rows = db
    .prepare(
      `SELECT provider_id, model_id FROM llm_models WHERE supports_image = 0`,
    )
    .all() as Array<{ provider_id: string; model_id: string }>;
  const ts = nowIso();
  const update = db.prepare(
    `UPDATE llm_models SET supports_image = 1, updated_at = ? WHERE provider_id = ? AND model_id = ?`,
  );
  const tx = db.transaction(() => {
    for (const row of rows) {
      if (inferSupportsImage(row.provider_id, row.model_id)) {
        update.run(ts, row.provider_id, row.model_id);
      }
    }
  });
  tx();
  settingsStore.set(IMAGE_CAPABILITY_BACKFILL_KEY, '1');
}

function ensureGlobalRow(): void {
  const row = db.prepare('SELECT id FROM llm_global WHERE id = 1').get() as { id: number } | undefined;
  if (row) return;
  db.prepare(
    `INSERT INTO llm_global (id, active_provider, vision_model, temperature, timeout_ms, max_tokens, updated_at)
     VALUES (1, 'openai', '', 0.7, 120000, 8192, ?)`,
  ).run(nowIso());
}

function migrateFromAppSettingsKv(): void {
  const entries = settingsStore.entries();
  const ts = nowIso();

  const activeProvider = (entries['llm.provider'] || 'openai').trim() || 'openai';
  const temperature = Number(entries['llm.temperature'] ?? 0.7);
  const timeoutMs = Number(entries['llm.timeoutMs'] ?? 120_000);
  const maxTokens = Number(entries['llm.maxTokens'] ?? 8192);

  db.prepare(
    `INSERT INTO llm_global (id, active_provider, vision_model, temperature, timeout_ms, max_tokens, updated_at)
     VALUES (1, @activeProvider, '', @temperature, @timeoutMs, @maxTokens, @ts)
     ON CONFLICT(id) DO UPDATE SET
       active_provider=excluded.active_provider,
       temperature=excluded.temperature,
       timeout_ms=excluded.timeout_ms,
       max_tokens=excluded.max_tokens,
       updated_at=excluded.updated_at`,
  ).run({
    activeProvider,
    temperature: Number.isFinite(temperature) ? temperature : 0.7,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 120_000,
    maxTokens: Number.isFinite(maxTokens) ? maxTokens : 8192,
    ts,
  });

  // 解析旧 multi-provider map
  type OldSlot = {
    baseUrl?: string;
    model?: string;
    availableModels?: string[];
    enabledModels?: string[];
  };
  let map: Record<string, OldSlot> = {};
  try {
    const raw = entries['llm.providers'];
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        map = parsed as Record<string, OldSlot>;
      }
    }
  } catch {
    map = {};
  }

  // 确保激活 provider 在 map 中
  if (!map[activeProvider]) {
    map[activeProvider] = {
      baseUrl: entries['llm.baseUrl'] || '',
      model: entries['llm.model'] || '',
      availableModels: parseJsonStringArray(entries['llm.availableModels']),
      enabledModels: parseJsonStringArray(entries['llm.enabledModels']),
    };
  }

  const upsertProvider = db.prepare(
    `INSERT INTO llm_providers (provider_id, base_url, default_model, max_tokens, enabled, created_at, updated_at)
     VALUES (@providerId, @baseUrl, @defaultModel, NULL, 1, @ts, @ts)
     ON CONFLICT(provider_id) DO UPDATE SET
       base_url=excluded.base_url,
       default_model=excluded.default_model,
       updated_at=excluded.updated_at`,
  );

  const clearModels = db.prepare('DELETE FROM llm_models WHERE provider_id = ?');
  const insertModel = db.prepare(
    `INSERT OR REPLACE INTO llm_models
      (provider_id, model_id, source, enabled, is_default, supports_image, sort_order, updated_at)
     VALUES (@providerId, @modelId, @source, @enabled, @isDefault, @supportsImage, @sortOrder, @ts)`,
  );

  const upsertApiKey = db.prepare(
    `INSERT INTO llm_credentials
      (provider_id, auth_type, api_key, oauth_access, oauth_refresh, oauth_expires_at, oauth_extra_json, updated_at)
     VALUES (@providerId, 'api_key', @apiKey, NULL, NULL, NULL, NULL, @ts)
     ON CONFLICT(provider_id) DO UPDATE SET
       auth_type='api_key',
       api_key=excluded.api_key,
       oauth_access=NULL,
       oauth_refresh=NULL,
       oauth_expires_at=NULL,
       oauth_extra_json=NULL,
       updated_at=excluded.updated_at`,
  );

  const upsertOauth = db.prepare(
    `INSERT INTO llm_credentials
      (provider_id, auth_type, api_key, oauth_access, oauth_refresh, oauth_expires_at, oauth_extra_json, updated_at)
     VALUES (@providerId, 'oauth', NULL, @access, @refresh, @expires, @extra, @ts)
     ON CONFLICT(provider_id) DO UPDATE SET
       auth_type='oauth',
       api_key=NULL,
       oauth_access=excluded.oauth_access,
       oauth_refresh=excluded.oauth_refresh,
       oauth_expires_at=excluded.oauth_expires_at,
       oauth_extra_json=excluded.oauth_extra_json,
       updated_at=excluded.updated_at`,
  );

  const migrateOne = db.transaction(() => {
    for (const [providerId, slot] of Object.entries(map)) {
      if (!isValidProviderId(providerId)) continue;
      const baseUrl = typeof slot.baseUrl === 'string' ? slot.baseUrl : '';
      const defaultModel = typeof slot.model === 'string' ? slot.model : '';
      upsertProvider.run({ providerId, baseUrl, defaultModel, ts });

      const available = filterChatModelIds(
        Array.isArray(slot.availableModels) ? slot.availableModels : [],
      );
      const enabled = new Set(
        filterChatModelIds(Array.isArray(slot.enabledModels) ? slot.enabledModels : []),
      );
      // 激活槽：扁平 available/enabled 可能更新
      let models = available;
      let enabledSet = enabled;
      let defModel = defaultModel;
      if (providerId === activeProvider) {
        const flatAvail = filterChatModelIds(parseJsonStringArray(entries['llm.availableModels']));
        const flatEnabled = filterChatModelIds(parseJsonStringArray(entries['llm.enabledModels']));
        if (flatAvail.length > 0) models = flatAvail;
        if (flatEnabled.length > 0) enabledSet = new Set(flatEnabled);
        if (entries['llm.model']?.trim()) defModel = entries['llm.model'].trim();
      }

      clearModels.run(providerId);
      models.forEach((modelId, index) => {
        insertModel.run({
          providerId,
          modelId,
          source: 'remote',
          enabled: enabledSet.has(modelId) ? 1 : 0,
          isDefault: defModel && modelId === defModel ? 1 : 0,
          supportsImage: inferSupportsImage(providerId, modelId) ? 1 : 0,
          sortOrder: index,
          ts,
        });
      });
      if (defModel && !models.includes(defModel)) {
        insertModel.run({
          providerId,
          modelId: defModel,
          source: 'custom',
          enabled: 1,
          isDefault: 1,
          supportsImage: inferSupportsImage(providerId, defModel) ? 1 : 0,
          sortOrder: models.length,
          ts,
        });
      }

      // 凭证：oauth 优先
      const credRaw = entries[`llm.credential.${providerId}`];
      let wroteCred = false;
      if (credRaw) {
        try {
          const cred = JSON.parse(credRaw) as Credential;
          if (cred?.type === 'oauth' && typeof (cred as { access?: string }).access === 'string') {
            const oauth = cred as {
              access: string;
              refresh?: string;
              expires?: number;
              [k: string]: unknown;
            };
            const { type: _t, access, refresh, expires, ...extra } = oauth;
            upsertOauth.run({
              providerId,
              access: access.trim(),
              refresh: typeof refresh === 'string' ? refresh : '',
              expires:
                typeof expires === 'number' && Number.isFinite(expires)
                  ? new Date(expires).toISOString()
                  : null,
              extra: Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
              ts,
            });
            wroteCred = true;
          } else if (cred?.type === 'api_key' && typeof (cred as { key?: string }).key === 'string') {
            const key = String((cred as { key: string }).key).trim();
            if (key) {
              upsertApiKey.run({ providerId, apiKey: key, ts });
              wroteCred = true;
            }
          }
        } catch {
          // ignore bad json
        }
      }
      if (!wroteCred) {
        const slotKey = entries[`llm.apiKey.${providerId}`]?.trim();
        if (slotKey) {
          upsertApiKey.run({ providerId, apiKey: slotKey, ts });
          wroteCred = true;
        }
      }
    }

    // 遗留全局 llm.apiKey：仅当激活槽仍无凭证
    const legacy = entries['llm.apiKey']?.trim();
    if (legacy && isValidProviderId(activeProvider)) {
      const has = db
        .prepare('SELECT 1 AS ok FROM llm_credentials WHERE provider_id = ?')
        .get(activeProvider) as { ok: number } | undefined;
      if (!has) {
        ensureProviderRow(activeProvider);
        upsertApiKey.run({ providerId: activeProvider, apiKey: legacy, ts });
      }
    }
  });

  migrateOne();
}

function parseJsonStringArray(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Global
// ---------------------------------------------------------------------------

export function readLlmGlobal(): LlmGlobalRow {
  ensureLlmSchemaMigrated();
  const row = db
    .prepare(
      `SELECT active_provider, temperature, timeout_ms, max_tokens
       FROM llm_global WHERE id = 1`,
    )
    .get() as
    | {
        active_provider: string;
        temperature: number;
        timeout_ms: number;
        max_tokens: number;
      }
    | undefined;
  if (!row) {
    return {
      activeProvider: 'openai',
      temperature: 0.7,
      timeoutMs: 120_000,
      maxTokens: 8192,
    };
  }
  return {
    activeProvider: row.active_provider,
    temperature: row.temperature,
    timeoutMs: row.timeout_ms,
    maxTokens: row.max_tokens,
  };
}

export function writeLlmGlobal(patch: Partial<LlmGlobalRow>): LlmGlobalRow {
  ensureLlmSchemaMigrated();
  const cur = readLlmGlobal();
  const next: LlmGlobalRow = {
    activeProvider: patch.activeProvider?.trim() || cur.activeProvider,
    temperature: patch.temperature ?? cur.temperature,
    timeoutMs: patch.timeoutMs ?? cur.timeoutMs,
    maxTokens: patch.maxTokens ?? cur.maxTokens,
  };
  if (!isValidProviderId(next.activeProvider)) {
    throw new Error(`无效的 provider: ${next.activeProvider}`);
  }
  db.prepare(
    `UPDATE llm_global SET
      active_provider = @activeProvider,
      temperature = @temperature,
      timeout_ms = @timeoutMs,
      max_tokens = @maxTokens,
      updated_at = @ts
     WHERE id = 1`,
  ).run({ ...next, ts: nowIso() });
  return next;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export function ensureProviderRow(providerId: string): void {
  ensureLlmSchemaMigrated();
  const id = providerId.trim();
  if (!isValidProviderId(id)) throw new Error(`无效的 provider: ${id}`);
  const exists = db
    .prepare('SELECT 1 AS ok FROM llm_providers WHERE provider_id = ?')
    .get(id) as { ok: number } | undefined;
  if (exists) return;
  const ts = nowIso();
  db.prepare(
    `INSERT INTO llm_providers (provider_id, base_url, default_model, max_tokens, enabled, created_at, updated_at)
     VALUES (?, '', '', NULL, 1, ?, ?)`,
  ).run(id, ts, ts);
}

export function listLlmProviders(): LlmProviderRow[] {
  ensureLlmSchemaMigrated();
  const rows = db
    .prepare(
      `SELECT provider_id, base_url, default_model, max_tokens, enabled
       FROM llm_providers ORDER BY provider_id`,
    )
    .all() as Array<{
    provider_id: string;
    base_url: string;
    default_model: string;
    max_tokens: number | null;
    enabled: number;
  }>;
  return rows.map((r) => ({
    providerId: r.provider_id,
    baseUrl: r.base_url ?? '',
    defaultModel: r.default_model ?? '',
    maxTokens: r.max_tokens,
    enabled: r.enabled === 1,
  }));
}

export function getLlmProvider(providerId: string): LlmProviderRow | undefined {
  ensureLlmSchemaMigrated();
  const r = db
    .prepare(
      `SELECT provider_id, base_url, default_model, max_tokens, enabled
       FROM llm_providers WHERE provider_id = ?`,
    )
    .get(providerId) as
    | {
        provider_id: string;
        base_url: string;
        default_model: string;
        max_tokens: number | null;
        enabled: number;
      }
    | undefined;
  if (!r) return undefined;
  return {
    providerId: r.provider_id,
    baseUrl: r.base_url ?? '',
    defaultModel: r.default_model ?? '',
    maxTokens: r.max_tokens,
    enabled: r.enabled === 1,
  };
}

export function upsertLlmProvider(
  providerId: string,
  patch: Partial<Pick<LlmProviderRow, 'baseUrl' | 'defaultModel' | 'maxTokens' | 'enabled'>>,
): LlmProviderRow {
  ensureProviderRow(providerId);
  const cur = getLlmProvider(providerId)!;
  const next: LlmProviderRow = {
    providerId,
    baseUrl: patch.baseUrl !== undefined ? patch.baseUrl : cur.baseUrl,
    defaultModel: patch.defaultModel !== undefined ? patch.defaultModel : cur.defaultModel,
    maxTokens: patch.maxTokens !== undefined ? patch.maxTokens : cur.maxTokens,
    enabled: patch.enabled !== undefined ? patch.enabled : cur.enabled,
  };
  db.prepare(
    `UPDATE llm_providers SET
      base_url = @baseUrl,
      default_model = @defaultModel,
      max_tokens = @maxTokens,
      enabled = @enabled,
      updated_at = @ts
     WHERE provider_id = @providerId`,
  ).run({
    providerId,
    baseUrl: next.baseUrl,
    defaultModel: next.defaultModel,
    maxTokens: next.maxTokens,
    enabled: next.enabled ? 1 : 0,
    ts: nowIso(),
  });
  return next;
}

export function deleteLlmProvider(providerId: string): void {
  ensureLlmSchemaMigrated();
  db.prepare('DELETE FROM llm_providers WHERE provider_id = ?').run(providerId);
  // credentials/models cascade
}

// ---------------------------------------------------------------------------
// Credentials (exclusive api_key | oauth)
// ---------------------------------------------------------------------------

export function readLlmCredential(providerId: string): Credential | undefined {
  ensureLlmSchemaMigrated();
  const r = db
    .prepare(
      `SELECT auth_type, api_key, oauth_access, oauth_refresh, oauth_expires_at, oauth_extra_json
       FROM llm_credentials WHERE provider_id = ?`,
    )
    .get(providerId) as
    | {
        auth_type: string;
        api_key: string | null;
        oauth_access: string | null;
        oauth_refresh: string | null;
        oauth_expires_at: string | null;
        oauth_extra_json: string | null;
      }
    | undefined;
  if (!r) return undefined;
  if (r.auth_type === 'api_key' && r.api_key) {
    return { type: 'api_key', key: r.api_key };
  }
  if (r.auth_type === 'oauth' && r.oauth_access) {
    let extra: Record<string, unknown> = {};
    if (r.oauth_extra_json) {
      try {
        extra = JSON.parse(r.oauth_extra_json) as Record<string, unknown>;
      } catch {
        extra = {};
      }
    }
    const expires =
      r.oauth_expires_at && !Number.isNaN(Date.parse(r.oauth_expires_at))
        ? Date.parse(r.oauth_expires_at)
        : undefined;
    return {
      type: 'oauth',
      access: r.oauth_access,
      refresh: r.oauth_refresh ?? '',
      ...(expires !== undefined ? { expires } : {}),
      ...extra,
    } as Credential;
  }
  return undefined;
}

export function writeLlmCredential(providerId: string, credential: Credential): void {
  ensureProviderRow(providerId);
  const ts = nowIso();
  if (credential.type === 'api_key') {
    const key = String((credential as { key?: string }).key ?? '').trim();
    if (!key) {
      deleteLlmCredential(providerId);
      return;
    }
    db.prepare(
      `INSERT INTO llm_credentials
        (provider_id, auth_type, api_key, oauth_access, oauth_refresh, oauth_expires_at, oauth_extra_json, updated_at)
       VALUES (?, 'api_key', ?, NULL, NULL, NULL, NULL, ?)
       ON CONFLICT(provider_id) DO UPDATE SET
         auth_type='api_key',
         api_key=excluded.api_key,
         oauth_access=NULL,
         oauth_refresh=NULL,
         oauth_expires_at=NULL,
         oauth_extra_json=NULL,
         updated_at=excluded.updated_at`,
    ).run(providerId, key, ts);
    return;
  }
  if (credential.type === 'oauth') {
    const oauth = credential as {
      access: string;
      refresh?: string;
      expires?: number;
      [k: string]: unknown;
    };
    const access = String(oauth.access ?? '').trim();
    if (!access) throw new Error('oauth credential missing access');
    const { type: _t, access: _a, refresh, expires, ...extra } = oauth;
    db.prepare(
      `INSERT INTO llm_credentials
        (provider_id, auth_type, api_key, oauth_access, oauth_refresh, oauth_expires_at, oauth_extra_json, updated_at)
       VALUES (?, 'oauth', NULL, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET
         auth_type='oauth',
         api_key=NULL,
         oauth_access=excluded.oauth_access,
         oauth_refresh=excluded.oauth_refresh,
         oauth_expires_at=excluded.oauth_expires_at,
         oauth_extra_json=excluded.oauth_extra_json,
         updated_at=excluded.updated_at`,
    ).run(
      providerId,
      access,
      typeof refresh === 'string' ? refresh : '',
      typeof expires === 'number' && Number.isFinite(expires)
        ? new Date(expires).toISOString()
        : null,
      Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
      ts,
    );
  }
}

export function deleteLlmCredential(providerId: string): void {
  ensureLlmSchemaMigrated();
  db.prepare('DELETE FROM llm_credentials WHERE provider_id = ?').run(providerId);
}

export function hasLlmCredential(providerId: string): boolean {
  return Boolean(readLlmCredential(providerId));
}

export function hasLlmOauthCredential(providerId: string): boolean {
  const c = readLlmCredential(providerId);
  return c?.type === 'oauth' && Boolean((c as { access?: string }).access?.trim());
}

export function hasLlmApiKeyCredential(providerId: string): boolean {
  const c = readLlmCredential(providerId);
  return c?.type === 'api_key' && Boolean((c as { key?: string }).key?.trim());
}

// ---------------------------------------------------------------------------
// Models catalog
// ---------------------------------------------------------------------------

export function listLlmModels(providerId: string): LlmModelRow[] {
  ensureLlmSchemaMigrated();
  const rows = db
    .prepare(
      `SELECT provider_id, model_id, source, enabled, is_default, supports_image, sort_order
       FROM llm_models WHERE provider_id = ? ORDER BY sort_order, model_id`,
    )
    .all(providerId) as Array<{
    provider_id: string;
    model_id: string;
    source: string;
    enabled: number;
    is_default: number;
    supports_image: number;
    sort_order: number;
  }>;
  return rows.map((r) => ({
    providerId: r.provider_id,
    modelId: r.model_id,
    source: (r.source as LlmModelSource) || 'remote',
    enabled: r.enabled === 1,
    isDefault: r.is_default === 1,
    supportsImage: r.supports_image === 1,
    sortOrder: r.sort_order,
  }));
}

export function getAvailableModelIds(providerId: string): string[] {
  return listLlmModels(providerId).map((m) => m.modelId);
}

export function getEnabledModelIds(providerId: string): string[] {
  return listLlmModels(providerId)
    .filter((m) => m.enabled)
    .map((m) => m.modelId);
}

export function getImageInputModelIds(providerId: string): string[] {
  return listLlmModels(providerId)
    .filter((model) => model.supportsImage)
    .map((model) => model.modelId);
}

export function modelSupportsImage(providerId: string, modelId: string): boolean {
  return listLlmModels(providerId).some((model) => model.modelId === modelId && model.supportsImage);
}

export function getDefaultModelId(providerId: string): string {
  const models = listLlmModels(providerId);
  return models.find((m) => m.isDefault)?.modelId
    || getLlmProvider(providerId)?.defaultModel
    || '';
}

/**
 * 替换 provider 的 available 列表；保留仍存在的 enabled/default；
 * 新增 id 默认 source=remote 且 enabled=false（除非在 keepEnabled 中）。
 */
export function replaceAvailableModels(
  providerId: string,
  availableModels: string[],
  options?: { source?: LlmModelSource; enableNew?: boolean },
): void {
  ensureProviderRow(providerId);
  const next = filterChatModelIds(availableModels);
  const prev = listLlmModels(providerId);
  const prevEnabled = new Set(prev.filter((m) => m.enabled).map((m) => m.modelId));
  const prevDefault = prev.find((m) => m.isDefault)?.modelId;
  const prevSource = new Map(prev.map((m) => [m.modelId, m.source]));
  const prevSupportsImage = new Map(prev.map((m) => [m.modelId, m.supportsImage]));
  const source = options?.source ?? 'remote';
  const enableNew = options?.enableNew ?? false;
  const ts = nowIso();

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM llm_models WHERE provider_id = ?').run(providerId);
    next.forEach((modelId, index) => {
      const wasEnabled = prevEnabled.has(modelId);
      const enabled = wasEnabled || enableNew ? 1 : 0;
      const isDefault = prevDefault === modelId ? 1 : 0;
      db.prepare(
        `INSERT INTO llm_models
          (provider_id, model_id, source, enabled, is_default, supports_image, sort_order, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        providerId,
        modelId,
        prevSource.get(modelId) ?? source,
        enabled,
        isDefault,
        // Pi catalog 可知则自动启用；否则保留已有自定义声明（只升不降）
        (inferSupportsImage(providerId, modelId) || prevSupportsImage.get(modelId)) ? 1 : 0,
        index,
        ts,
      );
    });
    // 若默认模型不在列表中，清掉 provider.default_model 或重设第一个
    const provider = getLlmProvider(providerId);
    if (provider?.defaultModel && !next.includes(provider.defaultModel)) {
      upsertLlmProvider(providerId, {
        defaultModel: next[0] ?? '',
      });
      if (next[0]) {
        db.prepare(
          `UPDATE llm_models SET is_default = CASE WHEN model_id = ? THEN 1 ELSE 0 END
           WHERE provider_id = ?`,
        ).run(next[0], providerId);
      }
    }
  });
  tx();
}

/**
 * 为指定模型声明图片输入能力（只升不降）。
 * 仅用于「添加自定义模型」路径；目录模型应靠 Pi 注册表 / 拉取时 inferSupportsImage。
 * 未知模型会先注册为自定义模型。
 */
export function setImageInputModels(providerId: string, imageInputModels: string[]): void {
  ensureProviderRow(providerId);
  const enable = filterChatModelIds(imageInputModels);
  if (enable.length === 0) return;
  const available = getAvailableModelIds(providerId);
  const missing = enable.filter((model) => !available.includes(model));
  if (missing.length > 0) {
    replaceAvailableModels(providerId, [...available, ...missing], { source: 'custom' });
  }
  const ts = nowIso();
  const update = db.prepare(
    `UPDATE llm_models SET supports_image = 1, updated_at = ? WHERE provider_id = ? AND model_id = ?`,
  );
  for (const modelId of enable) {
    update.run(ts, providerId, modelId);
  }
}

export function setEnabledModels(providerId: string, enabledModels: string[]): void {
  ensureProviderRow(providerId);
  const enabled = new Set(filterChatModelIds(enabledModels));
  const available = getAvailableModelIds(providerId);
  // 启用列表中有但不在 available 的，补进 available 为 custom
  const missing = [...enabled].filter((m) => !available.includes(m));
  if (missing.length > 0) {
    replaceAvailableModels(providerId, [...available, ...missing], {
      source: 'custom',
      enableNew: false,
    });
  }
  const ts = nowIso();
  const all = getAvailableModelIds(providerId);
  const tx = db.transaction(() => {
    for (const modelId of all) {
      db.prepare(
        `UPDATE llm_models SET enabled = ?, updated_at = ? WHERE provider_id = ? AND model_id = ?`,
      ).run(enabled.has(modelId) ? 1 : 0, ts, providerId, modelId);
    }
  });
  tx();
  // 防呆：有启用模型却无 default 时，落到第一个启用项
  ensureProviderDefaultModel(providerId);
}

/**
 * 若该槽尚无有效 default：仅从**已启用**列表取首项。
 * 不因 available 有目录就自动当选中（否则保存 Key 后会跳过 Setup 第三步「选模型」）。
 * 不编造远程 id、不拉网。返回最终 default（可能仍为空）。
 */
export function ensureProviderDefaultModel(providerId: string): string {
  ensureProviderRow(providerId);
  const current =
    (getDefaultModelId(providerId) || getLlmProvider(providerId)?.defaultModel || '').trim();
  if (current) return current;
  const pick = getEnabledModelIds(providerId)[0] || '';
  if (!pick) return '';
  setDefaultModel(providerId, pick);
  return pick;
}

export function setDefaultModel(providerId: string, modelId: string): void {
  ensureProviderRow(providerId);
  const id = modelId.trim();
  if (!id) throw new Error('model 不能为空');
  const available = getAvailableModelIds(providerId);
  if (!available.includes(id)) {
    replaceAvailableModels(providerId, [...available, id], { source: 'custom', enableNew: true });
  }
  const ts = nowIso();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE llm_models SET is_default = CASE WHEN model_id = ? THEN 1 ELSE 0 END, updated_at = ?
       WHERE provider_id = ?`,
    ).run(id, ts, providerId);
    upsertLlmProvider(providerId, { defaultModel: id });
  });
  tx();
}

export function addCustomModel(providerId: string, modelId: string, enable = true): void {
  const id = modelId.trim();
  if (!id || !filterChatModelIds([id]).includes(id)) {
    throw new Error(`无效的模型 id: ${modelId}`);
  }
  const available = getAvailableModelIds(providerId);
  if (available.includes(id)) return;
  replaceAvailableModels(providerId, [...available, id], { source: 'custom', enableNew: enable });
  if (enable) {
    setEnabledModels(providerId, [...getEnabledModelIds(providerId), id]);
  }
}

export function removeModel(providerId: string, modelId: string): void {
  ensureLlmSchemaMigrated();
  db.prepare('DELETE FROM llm_models WHERE provider_id = ? AND model_id = ?').run(
    providerId,
    modelId,
  );
  const provider = getLlmProvider(providerId);
  if (provider?.defaultModel === modelId) {
    const rest = getAvailableModelIds(providerId);
    upsertLlmProvider(providerId, { defaultModel: rest[0] ?? '' });
    if (rest[0]) setDefaultModel(providerId, rest[0]);
  }
}
