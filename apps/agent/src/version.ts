/**
 * Agent 对外展示的应用版本。
 *
 * 桌面壳会通过环境变量注入 Cargo 包版本；直接用 npm/tsx 开发时使用同一迭代的
 * fallback，避免健康接口继续返回历史硬编码版本。
 */
export const APP_VERSION = process.env.AUREVOY_VERSION?.trim() || '0.6.15';
