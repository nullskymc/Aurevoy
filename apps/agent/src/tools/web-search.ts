/**
 * web_search 工具。
 *
 * 执行网页搜索并返回结构化结果（标题、摘要、URL）。
 * 默认使用 DuckDuckGo HTML 搜索（免费，无需 API key），
 * 可通过环境变量配置其他搜索后端。
 */

import { toolRegistry } from './registry.js';

const SEARCH_TIMEOUT_MS = 15000;
const MAX_RESULTS = 10;

/** DuckDuckGo HTML 搜索结果的正则 */
const DDG_RESULT_RE = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

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

    const searchUrl = buildSearchUrl(query);

    let res: Response;
    try {
      res = await fetch(searchUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Aurevoy/1.0 (web-search)',
          'Accept': 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
    } catch (err) {
      return {
        error: `搜索请求失败: ${err instanceof Error ? err.message : String(err)}`,
        query,
      };
    }

    if (!res.ok) {
      return {
        error: `搜索服务返回 ${res.status}`,
        query,
        results: [],
      };
    }

    const html = await res.text();
    const results = parseSearchResults(html, query).slice(0, maxResults);

    return {
      query,
      resultCount: results.length,
      searchedAt: new Date().toISOString(),
      results,
    };
  },
});

/** 构建搜索 URL。默认使用 DuckDuckGo HTML 搜索。 */
function buildSearchUrl(query: string): string {
  const base =
    process.env.AUREVOY_SEARCH_BASE_URL ??
    'https://html.duckduckgo.com/html/';
  return `${base}?q=${encodeURIComponent(query)}`;
}

/** 从 HTML 中解析搜索结果。 */
function parseSearchResults(
  html: string,
  _query: string,
): Array<{ title: string; snippet: string; url: string }> {
  const results: Array<{ title: string; snippet: string; url: string }> = [];

  // DuckDuckGo HTML 结果格式
  const matches = html.matchAll(DDG_RESULT_RE);
  for (const match of matches) {
    const rawUrl = match[1];
    const title = stripHtml(match[2]).trim();
    const snippet = stripHtml(match[3]).trim();

    if (!title || !rawUrl) continue;

    // 跳过 DuckDuckGo 内部链接
    const url = decodeURIEntity(rawUrl);
    if (url.includes('duckduckgo.com') && !url.includes('/html/')) continue;

    results.push({ title, snippet, url });
  }

  // 如果未匹配到标准结果，尝试更宽松的匹配
  if (results.length === 0) {
    const fallback = parseFallbackResults(html);
    results.push(...fallback);
  }

  return results;
}

/** 宽松回退解析：匹配任意 <a> 标签 + 相邻文本。 */
function parseFallbackResults(
  html: string,
): Array<{ title: string; snippet: string; url: string }> {
  const results: Array<{ title: string; snippet: string; url: string }> = [];
  // 匹配常见的搜索结果模式: <a href="...">title</a>...snippet...
  const re = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>\s*([^<]{20,300}?)(?:<br|<a|<div|$)/gi;
  const matches = html.matchAll(re);
  for (const match of matches) {
    const url = decodeURIEntity(match[1]);
    if (url.includes('duckduckgo.com')) continue;
    results.push({
      title: stripHtml(match[2]).trim(),
      snippet: stripHtml(match[3]).trim().slice(0, 300),
      url,
    });
  }
  return results.slice(0, MAX_RESULTS);
}

function stripHtml(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeURIEntity(raw: string): string {
  // DuckDuckGo 使用 //duckduckgo.com/l/?uddg=... 格式的重定向 URL
  const uddgMatch = raw.match(/uddg=([^&]+)/);
  if (uddgMatch) {
    try {
      return decodeURIComponent(uddgMatch[1]);
    } catch {
      return raw;
    }
  }
  return raw;
}
