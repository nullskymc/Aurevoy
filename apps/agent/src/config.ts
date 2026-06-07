import { AGENT_DEFAULT_HOST, AGENT_DEFAULT_PORT } from '@aurevoy/shared';

/** 运行时配置，可通过环境变量覆盖（开发期通过 apps/agent/.env 注入） */
export const config = {
  host: process.env.AUREVOY_HOST ?? AGENT_DEFAULT_HOST,
  port: Number(process.env.AUREVOY_PORT ?? AGENT_DEFAULT_PORT),
  /** SQLite 数据文件路径 */
  dbPath: process.env.AUREVOY_DB_PATH ?? './aurevoy.sqlite',
  /** 允许的前端来源（开发期 Vite + 生产期 Tauri） */
  corsOrigins: (process.env.AUREVOY_CORS_ORIGINS ?? '*')
    .split(',')
    .map((s) => s.trim()),

  /** LLM Provider 配置。未配置 apiKey 时引擎会在执行任务时明确报错（不再回退占位实现）。 */
  llm: {
    /** 'openai'（OpenAI 兼容协议，支持 OpenAI/DeepSeek/Ollama 等） */
    provider: (process.env.AUREVOY_LLM_PROVIDER ?? 'openai').toLowerCase(),
    apiKey: process.env.AUREVOY_LLM_API_KEY ?? '',
    /** OpenAI 兼容端点的基础地址，不含 /chat/completions */
    baseUrl: process.env.AUREVOY_LLM_BASE_URL ?? 'https://api.openai.com/v1',
    model: process.env.AUREVOY_LLM_MODEL ?? 'gpt-4o-mini',
    temperature: Number(process.env.AUREVOY_LLM_TEMPERATURE ?? '0.7'),
  },
} as const;
