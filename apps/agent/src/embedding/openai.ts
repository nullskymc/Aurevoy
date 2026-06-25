/**
 * OpenAI 兼容 Embedding Provider。
 *
 * 调用 OpenAI 兼容的 /v1/embeddings 端点。
 * 适用：OpenAI API、Ollama、LiteLLM、OpenRouter 等任何提供 OpenAI 兼容 embedding API 的后端。
 */

import type { EmbeddingProvider } from './types.js';

export interface OpenAIEmbeddingOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly model: string;
  readonly dimensions: number;
  private baseUrl: string;
  private apiKey: string;
  private timeoutMs: number;

  constructor(options: OpenAIEmbeddingOptions) {
    this.baseUrl = (options.baseUrl || 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
    this.model = options.model;
    this.apiKey = options.apiKey ?? '';
    this.timeoutMs = options.timeoutMs;
    // 多数模型输出 768 维（nomic-embed-text / bge 等）；
    // text-embedding-3-small 输出 1536。首次请求后可动态检测。
    this.dimensions = 0;
  }

  async embed(text: string): Promise<Float32Array> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const url = `${this.baseUrl}/embeddings`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          input: texts,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Embedding 失败 (${response.status}): ${detail.slice(0, 200)}`);
      }

      const json = (await response.json()) as {
        data?: Array<{ embedding: number[] }>;
      };
      if (!json.data || !Array.isArray(json.data)) {
        throw new Error('Embedding API 返回格式异常：缺少 data 字段');
      }

      return json.data.map((d) => new Float32Array(d.embedding));
    } finally {
      clearTimeout(timer);
    }
  }
}
