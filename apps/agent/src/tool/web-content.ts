import { lookup } from 'node:dns/promises';
import { config } from '../config.js';

const MAX_FETCH_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_REDIRECTS = 3;
const DEFAULT_SEARCH_TIMEOUT_MS = 45_000;
const DEFAULT_SEARCH_MAX_CONCURRENCY = 2;

/** 进程内搜索并发闸：多路 web_search 排队，避免打爆自建 SearXNG。 */
const searchConcurrency = {
  active: 0,
  waiters: [] as Array<() => void>,
};

function searchTimeoutMs(): number {
  const n = config.search.timeoutMs;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1000 ? Math.floor(n) : DEFAULT_SEARCH_TIMEOUT_MS;
}

function searchMaxConcurrency(): number {
  const n = config.search.maxConcurrency;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_SEARCH_MAX_CONCURRENCY;
}

async function acquireSearchSlot(): Promise<() => void> {
  for (;;) {
    if (searchConcurrency.active < searchMaxConcurrency()) {
      searchConcurrency.active += 1;
      return releaseSearchSlot;
    }
    await new Promise<void>((resolve) => {
      searchConcurrency.waiters.push(resolve);
    });
  }
}

function releaseSearchSlot(): void {
  searchConcurrency.active = Math.max(0, searchConcurrency.active - 1);
  const next = searchConcurrency.waiters.shift();
  if (next) next();
}

export interface WebFetchResult {
  url: string;
  fetchedAt: string;
  status: number;
  contentType: string | null;
  redirects: string[];
  content: string;
  links: Array<{ text: string; url: string }>;
  truncated: boolean;
  binary: boolean;
  contentLength?: string | null;
  note?: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  provider: 'duckduckgo_lite' | 'tavily' | 'searxng' | 'custom';
  query: string;
  resultCount: number;
  searchedAt: string;
  results: WebSearchResult[];
}

export async function fetchWebContent(rawUrl: string): Promise<WebFetchResult> {
  const fetched = await fetchWithPolicy(rawUrl);
  const contentType = fetched.res.headers.get('content-type') ?? '';
  const metadata = {
    url: fetched.url.toString(),
    fetchedAt: new Date().toISOString(),
    status: fetched.res.status,
    contentType: contentType || null,
    redirects: fetched.redirects,
  };

  if (!isTextContentType(contentType)) {
    return {
      ...metadata,
      binary: true,
      content: '',
      links: [],
      truncated: false,
      contentLength: fetched.res.headers.get('content-length'),
      note: 'Content-Type 不是文本，未把二进制内容注入模型上下文。',
    };
  }

  const { body, truncated } = await readResponseText(fetched.res);
  if (isHtmlContentType(contentType) || /<html[\s>]/i.test(body)) {
    const cleaned = cleanHtml(body, fetched.url);
    return { ...metadata, binary: false, truncated, content: cleaned.text, links: cleaned.links };
  }

  return { ...metadata, binary: false, truncated, content: body, links: [] };
}

export async function searchWeb(rawQuery: string): Promise<WebSearchResponse> {
  const query = rawQuery.trim();
  if (!query) throw new Error('query 不能为空');
  const release = await acquireSearchSlot();
  try {
    let results: WebSearchResult[];
    switch (config.search.provider) {
      case 'searxng':
        results = await searchSearxng(query);
        break;
      case 'tavily':
        results = await searchTavily(query);
        break;
      case 'custom':
        results = await searchCustomJson(query);
        break;
      case 'duckduckgo_lite':
      default:
        results = await searchDuckDuckGoLite(query);
        break;
    }
    return {
      provider: config.search.provider,
      query,
      resultCount: results.length,
      searchedAt: new Date().toISOString(),
      results,
    };
  } finally {
    release();
  }
}

async function fetchWithPolicy(rawUrl: string): Promise<{ url: URL; res: Response; redirects: string[] }> {
  let url = parseHttpUrl(rawUrl);
  const redirects: string[] = [];
  for (let i = 0; i <= MAX_FETCH_REDIRECTS; i++) {
    await assertPublicHttpTarget(url);
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Aurevoy/1.0)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!isRedirectStatus(res.status)) return { url, res, redirects };
    const location = res.headers.get('location');
    if (!location) return { url, res, redirects };
    if (i === MAX_FETCH_REDIRECTS) throw new Error(`重定向次数超过上限 ${MAX_FETCH_REDIRECTS}`);
    url = parseHttpUrl(new URL(location, url).toString());
    redirects.push(url.toString());
  }
  throw new Error(`重定向次数超过上限 ${MAX_FETCH_REDIRECTS}`);
}

function parseHttpUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`非法 URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('只允许 http/https 协议');
  return parsed;
}

async function assertPublicHttpTarget(url: URL): Promise<void> {
  if (isWebFetchPrivateHostAllowed(url.hostname)) return;
  if (isPrivateHostname(url.hostname)) throw new Error(`拒绝访问本机或私有地址: ${url.hostname}`);
  const records = await lookup(url.hostname, { all: true, verbatim: true });
  if (records.length === 0) throw new Error(`无法解析主机: ${url.hostname}`);
  for (const record of records) {
    if (isPrivateAddress(record.address)) throw new Error(`拒绝访问本机或私有地址: ${record.address}`);
  }
}

function isWebFetchPrivateHostAllowed(hostname: string): boolean {
  return config.network.httpFetchPrivateHostAllowlist.includes(hostname.replace(/^\[|\]$/g, '').toLowerCase());
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized.endsWith('.localhost') || isPrivateAddress(normalized);
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.replace(/^::ffff:/i, '');
  return isPrivateIpv4(normalized) || isPrivateIpv6(address);
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
    normalized.startsWith('fd') || normalized.startsWith('fe80:') || normalized.startsWith('ff');
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isTextContentType(contentType: string): boolean {
  const value = contentType.toLowerCase();
  return value.startsWith('text/') || value.includes('application/json') || value.includes('application/xml') ||
    value.includes('application/xhtml+xml') || value.includes('application/javascript');
}

function isHtmlContentType(contentType: string): boolean {
  const value = contentType.toLowerCase();
  return value.includes('text/html') || value.includes('application/xhtml+xml');
}

async function readResponseText(res: Response): Promise<{ body: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let body = '';
  let truncated = false;
  if (!reader) return { body, truncated };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_FETCH_BYTES) {
      body += decoder.decode(value.slice(0, MAX_FETCH_BYTES - (received - value.byteLength)));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();
  return { body, truncated };
}

function cleanHtml(html: string, baseUrl: URL): { text: string; links: Array<{ text: string; url: string }> } {
  const withoutDangerousBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<object[\s\S]*?<\/object>/gi, ' ')
    .replace(/<embed[\s\S]*?>/gi, ' ');
  const links = extractLinks(withoutDangerousBlocks, baseUrl);
  const text = decodeHtmlEntities(
    withoutDangerousBlocks
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|main|header|footer|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
  return { text, links };
}

function extractLinks(html: string, baseUrl: URL): Array<{ text: string; url: string }> {
  const links: Array<{ text: string; url: string }> = [];
  const pattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (;;) {
    const match = pattern.exec(html);
    if (!match || links.length >= 30) break;
    try {
      const url = new URL(decodeHtmlEntities(match[1]), baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      const text = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      links.push({ text: text.slice(0, 120), url: url.toString() });
    } catch {
      // skip bad href
    }
  }
  return links;
}

export function stripHtml(raw: string): string {
  return decodeHtmlEntities(
    raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' '),
  ).trim();
}

export function parseDuckDuckGoLiteResults(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const linkRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (;;) {
    const match = linkRe.exec(html);
    if (!match || results.length >= 10) break;
    const attrs = match[1];
    if (!hasHtmlClass(attrs, 'result-link')) continue;
    const href = readHtmlAttribute(attrs, 'href');
    if (!href) continue;
    const url = decodeDuckDuckGoUrl(href);
    if (!url || url.includes('duckduckgo.com')) continue;
    results.push({
      title: stripHtml(match[2]),
      url,
      snippet: findNextResultSnippet(html, linkRe.lastIndex),
    });
  }
  return results;
}

async function searchDuckDuckGoLite(query: string): Promise<WebSearchResult[]> {
  const url = new URL('https://lite.duckduckgo.com/lite/');
  url.searchParams.set('q', query);
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Aurevoy/1.0)' },
    signal: AbortSignal.timeout(searchTimeoutMs()),
  });
  if (!resp.ok) throw new Error(`DuckDuckGo Lite 搜索失败: HTTP ${resp.status}`);
  return parseDuckDuckGoLiteResults(await resp.text());
}

async function searchSearxng(query: string): Promise<WebSearchResult[]> {
  const endpoint = searchEndpoint('/search', query);
  if (!hasSearchParam(endpoint, 'q')) endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('format', 'json');
  const resp = await fetch(endpoint, {
    headers: searchHeaders(),
    signal: AbortSignal.timeout(searchTimeoutMs()),
  });
  if (!resp.ok) throw new Error(`SearXNG 搜索失败: HTTP ${resp.status}`);
  return parseSearchJson(await resp.json());
}

async function searchTavily(query: string): Promise<WebSearchResult[]> {
  const endpoint = config.search.baseUrl.trim()
    ? searchEndpoint('/search')
    : new URL('https://api.tavily.com/search');
  if (!config.search.apiKey.trim()) throw new Error('Tavily 搜索需要配置 API Key');
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { ...searchHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: config.search.apiKey, query, max_results: 10 }),
    signal: AbortSignal.timeout(searchTimeoutMs()),
  });
  if (!resp.ok) throw new Error(`Tavily 搜索失败: HTTP ${resp.status}`);
  return parseSearchJson(await resp.json());
}

async function searchCustomJson(query: string): Promise<WebSearchResult[]> {
  const endpoint = searchEndpoint('/search', query);
  if (!hasSearchParam(endpoint, 'q')) endpoint.searchParams.set('q', query);
  const resp = await fetch(endpoint, {
    headers: searchHeaders(),
    signal: AbortSignal.timeout(searchTimeoutMs()),
  });
  if (!resp.ok) throw new Error(`自定义搜索失败: HTTP ${resp.status}`);
  return parseSearchJson(await resp.json());
}

function searchEndpoint(defaultPath: string, query?: string): URL {
  const rawBaseUrl = config.search.baseUrl.trim();
  if (!rawBaseUrl) throw new Error(`${config.search.provider} 搜索需要配置 Base URL`);
  const resolvedBaseUrl = query != null
    ? rawBaseUrl.replaceAll('{{query}}', encodeURIComponent(query))
    : rawBaseUrl;
  let url: URL;
  try {
    url = new URL(resolvedBaseUrl);
  } catch {
    throw new Error(`搜索 Base URL 非法: ${rawBaseUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('搜索 Base URL 只允许 http/https 协议');
  if (!rawBaseUrl.includes('{{query}}') && !url.pathname.endsWith(defaultPath)) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${defaultPath}`;
  }
  return url;
}

function hasSearchParam(url: URL, name: string): boolean {
  return [...url.searchParams.keys()].some((key) => key.toLowerCase() === name.toLowerCase());
}

function searchHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (compatible; Aurevoy/1.0)',
  };
  const apiKey = config.search.apiKey.trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers['X-API-Key'] = apiKey;
  }
  return headers;
}

function parseSearchJson(payload: unknown): WebSearchResult[] {
  const records = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { results?: unknown[] })?.results)
      ? (payload as { results: unknown[] }).results
      : [];
  return records
    .map(normalizeSearchResult)
    .filter((item): item is WebSearchResult => item !== null)
    .slice(0, 10);
}

function normalizeSearchResult(item: unknown): WebSearchResult | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  const title = readString(record.title);
  const url = readString(record.url) || readString(record.link);
  const snippet = readString(record.snippet) || readString(record.content) || readString(record.description);
  if (!title || !url) return null;
  return { title: stripHtml(title), url, snippet: stripHtml(snippet) };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function findNextResultSnippet(html: string, start: number): string {
  const snippetRe = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi;
  snippetRe.lastIndex = start;
  for (;;) {
    const match = snippetRe.exec(html);
    if (!match || match.index - start > 4000) return '';
    if (hasHtmlClass(match[1], 'result-snippet')) return stripHtml(match[2]);
  }
}

function decodeDuckDuckGoUrl(rawUrl: string): string {
  try {
    const withProtocol = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
    const parsed = new URL(decodeHtmlEntities(withProtocol));
    const uddg = parsed.searchParams.get('uddg');
    return uddg ? new URL(uddg).toString() : parsed.toString();
  } catch {
    try {
      return new URL(decodeURIComponent(rawUrl)).toString();
    } catch {
      return '';
    }
  }
}

function hasHtmlClass(attrs: string, className: string): boolean {
  const value = readHtmlAttribute(attrs, 'class');
  return value.split(/\s+/).includes(className);
}

function readHtmlAttribute(attrs: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return decodeHtmlEntities(match?.[2] ?? match?.[3] ?? match?.[4] ?? '');
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/&lsquo;/gi, "'")
    .replace(/&rdquo;/gi, '"')
    .replace(/&ldquo;/gi, '"')
    .replace(/&hellip;/gi, '...')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}
