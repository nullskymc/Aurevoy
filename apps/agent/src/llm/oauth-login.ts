import { randomUUID } from 'node:crypto';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { AuthEvent, AuthLoginCallbacks, AuthPrompt, OAuthCredential } from '@earendil-works/pi-ai';
import { aurevoyCredentialStore } from './credential-store.js';

export type OauthSessionStatus = 'running' | 'awaiting_input' | 'done' | 'error' | 'cancelled';

export interface OauthSessionSnapshot {
  sessionId: string;
  provider: string;
  status: OauthSessionStatus;
  events: AuthEvent[];
  pendingPrompt?: AuthPrompt;
  error?: string;
}

interface LiveSession {
  id: string;
  provider: string;
  status: OauthSessionStatus;
  events: AuthEvent[];
  pendingPrompt?: AuthPrompt;
  error?: string;
  abort: AbortController;
  resolvePrompt?: (value: string) => void;
  rejectPrompt?: (err: Error) => void;
  done: Promise<void>;
}

const sessions = new Map<string, LiveSession>();

function findBuiltinProvider(providerId: string) {
  return builtinProviders().find((p) => p.id === providerId);
}

export function providerSupportsOauth(providerId: string): boolean {
  return Boolean(findBuiltinProvider(providerId)?.auth.oauth);
}

function toSnapshot(session: LiveSession): OauthSessionSnapshot {
  return {
    sessionId: session.id,
    provider: session.provider,
    status: session.status,
    events: [...session.events],
    pendingPrompt: session.pendingPrompt,
    error: session.error,
  };
}

/**
 * 启动 Pi OAuth login。浏览器回调在 agent 进程本地监听；
 * 前端通过 poll + respond 驱动 prompt（粘贴 code / 选择登录方式）。
 */
export function startOauthLogin(providerId: string): OauthSessionSnapshot {
  const provider = findBuiltinProvider(providerId);
  const oauth = provider?.auth.oauth;
  if (!oauth) {
    throw new Error(`Provider "${providerId}" 不支持 OAuth 订阅登录`);
  }

  // 取消同 provider 进行中的会话
  for (const existing of sessions.values()) {
    if (existing.provider === providerId && (existing.status === 'running' || existing.status === 'awaiting_input')) {
      existing.abort.abort();
      existing.rejectPrompt?.(new Error('cancelled'));
      existing.status = 'cancelled';
    }
  }

  const id = randomUUID();
  const abort = new AbortController();
  const session: LiveSession = {
    id,
    provider: providerId,
    status: 'running',
    events: [],
    abort,
    done: Promise.resolve(),
  };
  sessions.set(id, session);

  const callbacks: AuthLoginCallbacks = {
    signal: abort.signal,
    notify(event) {
      session.events.push(event);
    },
    prompt(prompt) {
      if (abort.signal.aborted) {
        return Promise.reject(new Error('cancelled'));
      }
      session.pendingPrompt = prompt;
      session.status = 'awaiting_input';
      return new Promise<string>((resolve, reject) => {
        session.resolvePrompt = (value) => {
          session.pendingPrompt = undefined;
          session.resolvePrompt = undefined;
          session.rejectPrompt = undefined;
          session.status = 'running';
          resolve(value);
        };
        session.rejectPrompt = (err) => {
          session.pendingPrompt = undefined;
          session.resolvePrompt = undefined;
          session.rejectPrompt = undefined;
          reject(err);
        };
        abort.signal.addEventListener(
          'abort',
          () => {
            session.rejectPrompt?.(new Error('cancelled'));
          },
          { once: true },
        );
      });
    },
  };

  session.done = (async () => {
    try {
      const credential = (await oauth.login(callbacks)) as OAuthCredential;
      if (abort.signal.aborted) {
        session.status = 'cancelled';
        return;
      }
      await aurevoyCredentialStore.modify(providerId, async () => credential);
      // 确保 Models 路径能 resolve：写入 store 即可
      session.status = 'done';
      session.events.push({ type: 'progress', message: 'Login complete' });
    } catch (err) {
      if (abort.signal.aborted || (err instanceof Error && err.message === 'cancelled')) {
        session.status = 'cancelled';
        return;
      }
      session.status = 'error';
      session.error = err instanceof Error ? err.message : String(err);
    } finally {
      session.pendingPrompt = undefined;
      // 短暂保留会话供前端读最终状态，5 分钟后清理
      setTimeout(() => {
        sessions.delete(id);
      }, 5 * 60_000).unref?.();
    }
  })();

  return toSnapshot(session);
}

export function getOauthSession(sessionId: string): OauthSessionSnapshot | undefined {
  const session = sessions.get(sessionId);
  return session ? toSnapshot(session) : undefined;
}

export function respondOauthSession(sessionId: string, value: string): OauthSessionSnapshot {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('OAuth session not found');
  if (session.status !== 'awaiting_input' || !session.resolvePrompt) {
    throw new Error('OAuth session is not awaiting input');
  }
  session.resolvePrompt(value);
  return toSnapshot(session);
}

export function cancelOauthSession(sessionId: string): OauthSessionSnapshot {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('OAuth session not found');
  session.abort.abort();
  session.rejectPrompt?.(new Error('cancelled'));
  if (session.status === 'running' || session.status === 'awaiting_input') {
    session.status = 'cancelled';
  }
  return toSnapshot(session);
}

export async function logoutOauthProvider(providerId: string): Promise<void> {
  await aurevoyCredentialStore.delete(providerId);
}
