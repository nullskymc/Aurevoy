/**
 * Embedding Provider 工厂。
 *
 * 只保留 OpenAI 兼容接口，支持 Ollama/LiteLLM/OpenAI 等后端。
 */

import { config } from '../config.js';
import { OpenAIEmbeddingProvider } from './openai.js';
import type { EmbeddingProvider, EmbeddingProviderType } from './types.js';

let cachedProvider: EmbeddingProvider | null | undefined = undefined;

export function getEmbeddingProvider(): EmbeddingProvider | null {
  if (cachedProvider !== undefined) return cachedProvider;

  const provider: EmbeddingProviderType = config.embedding.provider;
  if (provider === 'off') {
    cachedProvider = null;
    console.info('[embedding] 未配置，向量检索将降级为纯关键词');
    return null;
  }

  cachedProvider = new OpenAIEmbeddingProvider({
    baseUrl: config.embedding.baseUrl,
    model: config.embedding.model,
    apiKey: config.embedding.apiKey,
    timeoutMs: config.embedding.timeoutMs,
  });

  console.info(`[embedding] 已加载: ${config.embedding.baseUrl}/${config.embedding.model}`);
  return cachedProvider;
}

export function resetEmbeddingCache(): void {
  cachedProvider = undefined;
}
