/**
 * MCP settings JSON ↔ structured form state.
 * Supports stdio and streamable-http (matches agent parseMcpServers).
 */

export type McpRiskLevel = "safe" | "caution" | "dangerous";
export type McpTransport = "stdio" | "streamable-http";

export interface McpServerDraft {
  name: string;
  transport: McpTransport;
  /** stdio */
  command: string;
  args: string[];
  cwd: string;
  env: Array<{ key: string; value: string }>;
  /** streamable-http */
  url: string;
  headers: Array<{ key: string; value: string }>;
  enabled: boolean;
  riskLevel?: McpRiskLevel;
}

export function emptyMcpServerDraft(transport: McpTransport = "stdio"): McpServerDraft {
  return {
    name: "",
    transport,
    command: "",
    args: [],
    cwd: "",
    env: [],
    url: "",
    headers: [],
    enabled: true,
  };
}

export function parseMcpServersJson(raw: string): McpServerDraft[] {
  const text = raw.trim();
  if (!text) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`JSON 无效：${message}`);
  }

  return normalizeEntries(parsed).map(([fallbackName, value]) => parseOne(fallbackName, value));
}

export function stringifyMcpServersJson(servers: McpServerDraft[]): string {
  if (servers.length === 0) return "";
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const server of servers) {
    const name = server.name.trim();
    if (!name) continue;
    mcpServers[name] = draftToJsonBody(server);
  }
  if (Object.keys(mcpServers).length === 0) return "";
  return JSON.stringify({ mcpServers }, null, 2);
}

export function upsertMcpServer(list: McpServerDraft[], next: McpServerDraft, originalName?: string): McpServerDraft[] {
  const name = next.name.trim();
  if (!name) throw new Error("名称不能为空");
  validateDraft(next);

  const key = (originalName ?? name).trim();
  const without = list.filter((s) => s.name.trim() !== key && s.name.trim() !== name);
  if (list.some((s) => s.name.trim() === name && s.name.trim() !== key)) {
    throw new Error(`名称「${name}」已存在`);
  }
  return [...without, { ...next, name, transport: next.transport }];
}

export function setMcpServerEnabled(list: McpServerDraft[], name: string, enabled: boolean): McpServerDraft[] {
  return list.map((s) => (s.name === name ? { ...s, enabled } : s));
}

export function removeMcpServer(list: McpServerDraft[], name: string): McpServerDraft[] {
  return list.filter((s) => s.name !== name);
}

export function mcpServerEndpointLabel(server: McpServerDraft): string {
  if (server.transport === "streamable-http") {
    return server.url.trim() || "streamable-http";
  }
  const cmd = server.command.trim();
  const args = server.args.map((a) => a.trim()).filter(Boolean).join(" ");
  return args ? `${cmd} ${args}` : cmd || "stdio";
}

function validateDraft(next: McpServerDraft): void {
  if (next.transport === "streamable-http") {
    const url = next.url.trim();
    if (!url) throw new Error("URL 不能为空");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("URL 无效");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("URL 须以 http:// 或 https:// 开头");
    }
    return;
  }
  if (!next.command.trim()) throw new Error("启动命令不能为空");
}

function draftToJsonBody(server: McpServerDraft): Record<string, unknown> {
  if (server.transport === "streamable-http") {
    const body: Record<string, unknown> = {
      transport: "streamable-http",
      url: server.url.trim(),
      enabled: server.enabled,
    };
    const headers = envPairsToRecord(server.headers);
    if (headers && Object.keys(headers).length > 0) body.headers = headers;
    if (server.riskLevel) body.riskLevel = server.riskLevel;
    return body;
  }

  const body: Record<string, unknown> = {
    transport: "stdio",
    command: server.command.trim(),
    args: server.args.map((a) => a.trim()).filter(Boolean),
    enabled: server.enabled,
  };
  if (server.cwd.trim()) body.cwd = server.cwd.trim();
  const env = envPairsToRecord(server.env);
  if (env && Object.keys(env).length > 0) body.env = env;
  if (server.riskLevel) body.riskLevel = server.riskLevel;
  return body;
}

function normalizeEntries(parsed: unknown): Array<[string | undefined, unknown]> {
  if (Array.isArray(parsed)) return parsed.map((item) => [undefined, item]);
  if (!isRecord(parsed)) throw new Error("MCP 配置必须是对象或数组");
  if (typeof parsed.command === "string" || typeof parsed.url === "string") return [[undefined, parsed]];
  if (isRecord(parsed.mcpServers)) return Object.entries(parsed.mcpServers);
  return Object.entries(parsed);
}

function parseOne(fallbackName: string | undefined, value: unknown): McpServerDraft {
  if (!isRecord(value)) throw new Error(`MCP server 配置必须是对象：${fallbackName ?? "<unnamed>"}`);
  const name = (typeof value.name === "string" && value.name.trim() ? value.name : fallbackName)?.trim();
  if (!name) throw new Error("MCP server 缺少 name");

  const transport = normalizeTransport(
    typeof value.transport === "string" ? value.transport : undefined,
    typeof value.url === "string" ? value.url : undefined,
  );

  const risk =
    value.riskLevel === "safe" || value.riskLevel === "caution" || value.riskLevel === "dangerous"
      ? value.riskLevel
      : undefined;

  if (transport === "streamable-http") {
    const url = typeof value.url === "string" ? value.url.trim() : "";
    if (!url) throw new Error(`「${name}」缺少 url`);
    const headers = isRecord(value.headers)
      ? Object.entries(value.headers)
          .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
          .map(([key, val]) => ({ key, value: val }))
      : [];
    return {
      ...emptyMcpServerDraft("streamable-http"),
      name,
      url,
      headers,
      enabled: value.enabled !== false,
      riskLevel: risk,
    };
  }

  const command = typeof value.command === "string" ? value.command : "";
  if (!command.trim()) throw new Error(`「${name}」缺少 command`);

  const args = Array.isArray(value.args)
    ? value.args.filter((item): item is string => typeof item === "string")
    : [];
  const cwd = typeof value.cwd === "string" ? value.cwd : "";
  const env = isRecord(value.env)
    ? Object.entries(value.env)
        .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
        .map(([key, val]) => ({ key, value: val }))
    : [];

  return {
    ...emptyMcpServerDraft("stdio"),
    name,
    command,
    args,
    cwd,
    env,
    enabled: value.enabled !== false,
    riskLevel: risk,
  };
}

function normalizeTransport(transport: string | undefined, url: string | undefined): McpTransport {
  if (!transport) return url?.trim() ? "streamable-http" : "stdio";
  const key = transport.trim().toLowerCase();
  if (key === "stdio") return "stdio";
  if (key === "streamable-http" || key === "streamablehttp" || key === "http" || key === "sse") {
    return "streamable-http";
  }
  throw new Error(`不支持的 transport：${transport}（可用 stdio / streamable-http）`);
}

function envPairsToRecord(pairs: Array<{ key: string; value: string }>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const { key, value } of pairs) {
    const k = key.trim();
    if (!k) continue;
    out[k] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
