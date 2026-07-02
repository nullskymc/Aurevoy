/**
 * web_search 工具。
 *
 * 执行网页搜索并返回结构化结果（标题、摘要、URL）。
 * 支持多种搜索后端，可在设置中切换，默认使用 DuckDuckGo Lite（免费、无需配置）。
 */
import { toolRegistry } from './registry.js';
import { config } from '../config.js';

const SEARCH_TIMEOUT_MS = 30000;
const MAX_RESULTS = 10;

/** DuckDuckGo Lite 搜索结果的正则 */
const DDG_LITE_RESULT_RE = /<a[^>]*class="result-link"[^>]*href="[^"]*uddg=([^"&]+)[^"]*"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<td class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

toolRegistry.register({
  descriptor: {
    name: 'web_search',
    description:
      '搜索网页并返回结果列表（标题、摘要、URL）。用于查找最新信息、文档、技术方案等。' +
      '返回最多 10 条结果，每条含标题、摘要和 URL。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词或问题。',
        },
        maxResults: {
          type: 'number',
          description: '最多返回结果数（默认 10，最大 20）。',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    riskLevel: 'safe',
  },

  async execute(args) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return { error: 'query 参数不能为空' };

    const maxResults = Math.min(
      typeof args.maxResults === 'number' ? Math.floor(args.maxResults) : MAX_RESULTS,
      20,
    );

    const provider = config.search.provider;

    try {
      switch (provider) {
        case 'duckduckgo_lite':
          return await searchDuckDuckGoLite(query, maxResults);
        case 'tavily':
          return await searchTavily(query, maxResults);
        case 'searxng':
          return await searchJson(query, maxResults, 'SearXNG');
        case 'custom':
          return await searchJson(query, maxResults, '自定义');
        default:
          return await searchDuckDuckGoLite(query, maxResults);
      }
    } catch (err) {
      return {
        error: `搜索请求失败: ${err instanceof Error ? err.message : String(err)}`,
        query,
      };
    }
  },
});

// ===== DuckDuckGo Lite =====

async function searchDuckDuckGoLite(
  query: string,
  maxResults: number,
): Promise<Record<string, unknown>> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html',
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    return { error: `DuckDuckGo 返回 ${res.status}`, query, results: [] };
  }

  const html = await res.text();

  // 检测反爬/CAPTCHA
  if (html.includes('anomaly-modal') || html.includes('challenge-form')) {
    return { error: 'DuckDuckGo 要求人机验证，请切换搜索后端', query, results: [] };
  }

  const results = parseDdgLiteResults(html).slice(0, maxResults);

  return {
    query,
    resultCount: results.length,
    searchedAt: new Date().toISOString(),
    results,
  };
}

function parseDdgLiteResults(html: string): Array<{ title: string; snippet: string; url: string }> {
  const results: Array<{ title: string; snippet: string; url: string }> = [];
  const matches = html.matchAll(DDG_LITE_RESULT_RE);

  for (const match of matches) {
    const encodedUrl = match[1];
    const title = stripHtml(decodeURIEntity(match[2])).trim();
    const snippet = stripHtml(match[3]).trim();

    if (!title) continue;

    let url = encodedUrl;
    try {
      url = decodeURIComponent(encodedUrl);
    } catch { /* keep encoded */ }

    if (url.includes('duckduckgo.com')) continue;

    results.push({ title, snippet, url });
  }

  return results;
}

// ===== Tavily =====

async function searchTavily(
  query: string,
  maxResults: number,
): Promise<Record<string, unknown>> {
  const apiKey = config.search.apiKey.trim();
  if (!apiKey) return { error: 'Tavily API Key 未配置，请在设置中填入', query, results: [] };

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: 'basic',
      include_answer: false,
    }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    return { error: `Tavily 返回 ${res.status}`, query, results: [] };
  }

  const data = await res.json() as { results?: Array<{ title: string; content: string; url: string }> };
  const results = (data.results ?? []).map(r => ({
    title: r.title,
    snippet: r.content,
    url: r.url,
  }));

  return {
    query,
    resultCount: results.length,
    searchedAt: new Date().toISOString(),
    results,
  };
}

// ===== SearXNG / Custom JSON API =====

async function searchJson(
  query: string,
  maxResults: number,
  label: string,
): Promise<Record<string, unknown>> {
  const baseUrl = config.search.baseUrl.trim();
  if (!baseUrl) return { error: `${label}搜索 URL 未配置，请在设置中填入 API 地址`, query, results: [] };

  const url = baseUrl.includes('{{query}}')
    ? baseUrl.replace('{{query}}', encodeURIComponent(query))
    : `${baseUrl}?q=${encodeURIComponent(query)}&format=json`;

  const headers: Record<string, string> = {
    'User-Agent': 'Aurevoy/1.0 (web-search)',
    'Accept': 'application/json',
  };
  const apiKey = config.search.apiKey.trim();
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    return { error: `${label}返回 ${res.status}`, query, results: [] };
  }

  const data = await res.json() as Record<string, unknown>;
  const rawResults = (Array.isArray(data.results) ? data.results : Array.isArray(data) ? data : []) as Array<Record<string, unknown>>;
  const results = rawResults.map(r => ({
    title: stripHtml(String(r.title ?? r.name ?? '')),
    snippet: stripHtml(String(r.content ?? r.snippet ?? r.description ?? '')),
    url: String(r.url ?? r.link ?? ''),
  })).filter(r => r.title || r.url);

  return {
    query,
    resultCount: results.length,
    searchedAt: new Date().toISOString(),
    results: results.slice(0, maxResults),
  };
}

// ===== 工具函数 =====

function stripHtml(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"')
    .replace(/&hellip;/g, '…')
    .replace(/&#x2F;/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeURIEntity(raw: string): string {
  return raw
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
