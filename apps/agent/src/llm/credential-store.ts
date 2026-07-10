import type { Credential, CredentialStore } from '@earendil-works/pi-ai';
import { settingsStore } from '../store/db.js';

const CREDENTIAL_KEY_PREFIX = 'llm.credential.';

function credentialKey(providerId: string): string {
  return `${CREDENTIAL_KEY_PREFIX}${providerId}`;
}

function parseCredential(raw: string | undefined): Credential | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as Credential;
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) return undefined;
    if (parsed.type === 'api_key') return parsed;
    if (parsed.type === 'oauth' && typeof parsed.access === 'string' && typeof parsed.refresh === 'string') {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * SQLite 持久化的 Pi CredentialStore。
 * 每 provider 一条凭证（api_key | oauth）；modify 按 provider 串行，供 OAuth refresh 使用。
 * Pi 约定：modify 的 fn 返回 undefined 表示不改写；清除请用 delete()。
 */
class AurevoyCredentialStore implements CredentialStore {
  private chains = new Map<string, Promise<unknown>>();

  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(providerId) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.chains.set(
      providerId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return parseCredential(settingsStore.get(credentialKey(providerId)));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      const current = parseCredential(settingsStore.get(credentialKey(providerId)));
      const next = await fn(current);
      if (next === undefined) return current;
      settingsStore.set(credentialKey(providerId), JSON.stringify(next), true);
      return next;
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.enqueue(providerId, async () => {
      settingsStore.delete(credentialKey(providerId));
    });
  }
}

export const aurevoyCredentialStore: CredentialStore = new AurevoyCredentialStore();

/** 同步探测：是否已有可用凭证（api_key 或 oauth） */
export function hasStoredCredential(providerId: string): boolean {
  const cred = parseCredential(settingsStore.get(credentialKey(providerId)));
  if (!cred) return false;
  if (cred.type === 'api_key') return Boolean(cred.key?.trim());
  if (cred.type === 'oauth') return Boolean(cred.access?.trim() && cred.refresh?.trim());
  return false;
}

export function hasOauthCredential(providerId: string): boolean {
  const cred = parseCredential(settingsStore.get(credentialKey(providerId)));
  return cred?.type === 'oauth' && Boolean(cred.access?.trim());
}

/**
 * 写入 API Key 凭证。
 * - 空 key：仅删除已有 api_key，不动 oauth
 * - 非空：默认不覆盖已有 oauth（Codex/Claude 订阅登录会被 sk- 密钥毁掉）
 * - force=true：用户在设置里显式保存 Key 时允许覆盖 oauth
 */
export async function writeApiKeyCredential(
  providerId: string,
  apiKey: string,
  options?: { force?: boolean },
): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    const current = await aurevoyCredentialStore.read(providerId);
    if (current?.type === 'api_key') {
      await aurevoyCredentialStore.delete(providerId);
    }
    return;
  }
  await aurevoyCredentialStore.modify(providerId, async (current) => {
    if (current?.type === 'oauth' && !options?.force) {
      return undefined; // 保留订阅登录
    }
    return {
      type: 'api_key',
      key: trimmed,
    };
  });
}

export async function clearProviderCredential(providerId: string): Promise<void> {
  await aurevoyCredentialStore.delete(providerId);
}
