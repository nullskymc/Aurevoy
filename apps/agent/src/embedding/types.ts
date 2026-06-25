/**
 * Embedding Provider 类型定义。
 *
 * 只保留 OpenAI 兼容接口，Ollama/LiteLLM/OpenAI 等通过同一 baseUrl + 模型配置接入。
 */

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  readonly model: string;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

export type EmbeddingProviderType = 'openai' | 'off';

export const SUPPORTED_EMBEDDING_PROVIDERS: EmbeddingProviderType[] = ['openai', 'off'];

export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
export const DEFAULT_EMBEDDING_BASE_URL = 'http://127.0.0.1:11434/v1';
