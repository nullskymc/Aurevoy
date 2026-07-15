import type { Credential, CredentialStore } from '@earendil-works/pi-ai';
import {
  deleteLlmCredential,
  ensureLlmSchemaMigrated,
  ensureProviderRow,
  hasLlmApiKeyCredential,
  hasLlmCredential,
  hasLlmOauthCredential,
  readLlmCredential,
  writeLlmCredential,
} from './llm-store.js';

/**
 * Pi CredentialStore 适配：底层为 llm_credentials 表（每 provider 唯一鉴权）。
 * modify 按 provider 串行，供 OAuth refresh 使用。
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
    ensureLlmSchemaMigrated();
    return readLlmCredential(providerId);
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      ensureProviderRow(providerId);
      const current = readLlmCredential(providerId);
      const next = await fn(current);
      if (next === undefined) return current;
      writeLlmCredential(providerId, next);
      return next;
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.enqueue(providerId, async () => {
      deleteLlmCredential(providerId);
    });
  }
}

export const aurevoyCredentialStore: CredentialStore = new AurevoyCredentialStore();

/** 同步探测：是否已有可用凭证（api_key 或 oauth） */
export function hasStoredCredential(providerId: string): boolean {
  ensureLlmSchemaMigrated();
  return hasLlmCredential(providerId);
}

export function hasOauthCredential(providerId: string): boolean {
  ensureLlmSchemaMigrated();
  return hasLlmOauthCredential(providerId);
}

export function hasApiKeyCredential(providerId: string): boolean {
  ensureLlmSchemaMigrated();
  return hasLlmApiKeyCredential(providerId);
}

/**
 * 写入 API Key 凭证（互斥：覆盖 oauth）。
 * - 空 key：仅删除已有 api_key，不动 oauth
 * - 非空 + force=false：不覆盖已有 oauth
 * - force=true：用户显式保存 Key 时允许覆盖 oauth
 */
export async function writeApiKeyCredential(
  providerId: string,
  apiKey: string,
  options?: { force?: boolean },
): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    const current = readLlmCredential(providerId);
    if (current?.type === 'api_key') {
      deleteLlmCredential(providerId);
    }
    return;
  }
  await aurevoyCredentialStore.modify(providerId, async (current) => {
    if (current?.type === 'oauth' && !options?.force) {
      return undefined;
    }
    return { type: 'api_key', key: trimmed };
  });
}

export async function clearProviderCredential(providerId: string): Promise<void> {
  await aurevoyCredentialStore.delete(providerId);
}
