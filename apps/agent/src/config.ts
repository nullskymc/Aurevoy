import { AGENT_DEFAULT_HOST, AGENT_DEFAULT_PORT } from '@aurevoy/shared';

/** 运行时配置，可通过环境变量覆盖 */
export const config = {
  host: process.env.AUREVOY_HOST ?? AGENT_DEFAULT_HOST,
  port: Number(process.env.AUREVOY_PORT ?? AGENT_DEFAULT_PORT),
  /** SQLite 数据文件路径 */
  dbPath: process.env.AUREVOY_DB_PATH ?? './aurevoy.sqlite',
  /** 允许的前端来源（开发期 Vite + 生产期 Tauri） */
  corsOrigins: (process.env.AUREVOY_CORS_ORIGINS ?? '*')
    .split(',')
    .map((s) => s.trim()),
} as const;
