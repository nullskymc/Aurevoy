import type { McpServerConfig } from './config.js';
import { parseMcpServers } from './config.js';
import { db } from './store/db.js';

/** MCP 凭据不会进入 mcpServersJson；此占位符可安全出现在设置页与脱敏导出中。 */
export const MCP_SECRET_PLACEHOLDER_PREFIX = '${AUREVOY_MCP_SECRET:';

interface McpSecretKey {
  serverName: string;
  fieldName: string;
}

interface McpSecretRow {
  server_name: string;
  field_name: string;
  value: string;
}

export interface SecuredMcpConfig {
  /** 运行时配置：已尽量替换为本地凭据；缺失凭据的字段不会带占位符发往外部。 */
  servers: McpServerConfig[];
  /** 可持久化配置：敏感字段只含占位符。 */
  persistedJson: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function encodePart(value: string): string {
  return encodeURIComponent(value);
}

function decodePart(value: string): string {
  return decodeURIComponent(value);
}

function placeholderFor(serverName: string, fieldName: string): string {
  return `${MCP_SECRET_PLACEHOLDER_PREFIX}${encodePart(serverName)}:${encodePart(fieldName)}}`;
}

function parsePlaceholder(value: string): McpSecretKey | undefined {
  if (!value.startsWith(MCP_SECRET_PLACEHOLDER_PREFIX) || !value.endsWith('}')) return undefined;
  const body = value.slice(MCP_SECRET_PLACEHOLDER_PREFIX.length, -1);
  const separator = body.indexOf(':');
  if (separator <= 0 || separator === body.length - 1) return undefined;
  try {
    const serverName = decodePart(body.slice(0, separator));
    const fieldName = decodePart(body.slice(separator + 1));
    if (!serverName || !fieldName) return undefined;
    return { serverName, fieldName };
  } catch {
    return undefined;
  }
}

function isSafeHttpHeader(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === 'accept'
    || normalized === 'content-type'
    || normalized === 'user-agent'
    || normalized === 'host';
}

/** 远程 MCP 的自定义头默认按凭据处理，避免漏掉 X-Custom-Auth 之类的约定。 */
function isSecretHttpHeader(name: string): boolean {
  return !isSafeHttpHeader(name);
}

function isSecretStdioEnv(name: string): boolean {
  return /(api[_-]?key|token|secret|password|credential|authorization|auth|cookie|private[_-]?key|client[_-]?secret)/i.test(name);
}

function secretField(server: McpServerConfig, fieldName: string): McpSecretKey {
  return { serverName: server.name, fieldName };
}

function readSecret(key: McpSecretKey): string | undefined {
  const row = db.prepare(
    'SELECT value FROM mcp_credentials WHERE server_name = ? AND field_name = ?',
  ).get(key.serverName, key.fieldName) as { value?: string } | undefined;
  return row?.value;
}

function writeSecret(key: McpSecretKey, value: string): void {
  db.prepare(`
    INSERT INTO mcp_credentials(server_name, field_name, value, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(server_name, field_name) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key.serverName, key.fieldName, value, nowIso());
}

function deleteSecret(key: McpSecretKey): void {
  db.prepare('DELETE FROM mcp_credentials WHERE server_name = ? AND field_name = ?')
    .run(key.serverName, key.fieldName);
}

function listSecrets(): McpSecretKey[] {
  return (db.prepare('SELECT server_name, field_name FROM mcp_credentials').all() as McpSecretRow[])
    .map(({ server_name: serverName, field_name: fieldName }) => ({ serverName, fieldName }));
}

function secureRecord(
  server: McpServerConfig,
  record: Record<string, string> | undefined,
  isSecret: (name: string) => boolean,
): { runtime?: Record<string, string>; persisted?: Record<string, string>; referenced: McpSecretKey[] } {
  if (!record) return { referenced: [] };
  const runtime: Record<string, string> = {};
  const persisted: Record<string, string> = {};
  const referenced: McpSecretKey[] = [];
  for (const [name, value] of Object.entries(record)) {
    if (!isSecret(name)) {
      runtime[name] = value;
      persisted[name] = value;
      continue;
    }

    const key = secretField(server, name);
    if (value.trim() === '') {
      deleteSecret(key);
      continue;
    }
    const token = parsePlaceholder(value);
    if (!token) writeSecret(key, value);
    const stored = readSecret(key);
    referenced.push(key);
    persisted[name] = placeholderFor(server.name, name);
    // 设置页可能只保存了占位符但凭据已被清除；这种字段不能把占位符发给上游。
    if (stored !== undefined) runtime[name] = stored;
  }
  return {
    runtime: Object.keys(runtime).length > 0 ? runtime : undefined,
    persisted: Object.keys(persisted).length > 0 ? persisted : undefined,
    referenced,
  };
}

function secureServer(server: McpServerConfig): { runtime: McpServerConfig; persisted: McpServerConfig; referenced: McpSecretKey[] } {
  if (server.transport === 'streamable-http') {
    const secured = secureRecord(server, server.headers, isSecretHttpHeader);
    return {
      runtime: { ...server, headers: secured.runtime },
      persisted: { ...server, headers: secured.persisted },
      referenced: secured.referenced,
    };
  }
  const secured = secureRecord(server, server.env, isSecretStdioEnv);
  return {
    runtime: { ...server, env: secured.runtime },
    persisted: { ...server, env: secured.persisted },
    referenced: secured.referenced,
  };
}

/**
 * 解析并保护 MCP 设置。
 * 旧版 JSON 中已有的明文凭据会在这里一次性移入 SQLite；之后 API/导出只会看到占位符。
 */
export function secureMcpServersJson(raw: string): SecuredMcpConfig {
  const parsed = parseMcpServers(raw);
  const secured = parsed.map(secureServer);
  const referenced = new Set(secured.flatMap(({ referenced: keys }) => keys.map((key) => `${key.serverName}\0${key.fieldName}`)));
  for (const key of listSecrets()) {
    if (!referenced.has(`${key.serverName}\0${key.fieldName}`)) deleteSecret(key);
  }
  const persistedJson = secured.length === 0
    ? ''
    : JSON.stringify({ mcpServers: Object.fromEntries(secured.map(({ persisted }) => [persisted.name, persisted])) }, null, 2);
  return {
    servers: secured.map(({ runtime }) => runtime),
    persistedJson,
  };
}

/** 测试/诊断只读取非敏感的凭据存在性，不返回 value。 */
export function listMcpCredentialInfo(): Array<{ serverName: string; fieldName: string }> {
  return listSecrets();
}

export function clearMcpServerCredentials(serverName: string): void {
  db.prepare('DELETE FROM mcp_credentials WHERE server_name = ?').run(serverName);
}
