import { randomBytes } from 'node:crypto';

/** 每次引擎启动生成的内存令牌；显式环境变量只用于受控运维/测试场景。 */
export function createApiToken(configuredToken = process.env.AUREVOY_API_TOKEN): string {
  const token = configuredToken?.trim();
  return token || randomBytes(32).toString('hex');
}

/** CORS 与 token bootstrap 共用同一组 Origin，避免出现“能跨域但拿不到会话”的歧义。 */
export function isAllowedApiOrigin(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  return origin !== undefined && allowedOrigins.includes(origin);
}

export function isValidApiAuthorization(authorization: string | undefined, token: string): boolean {
  return authorization === `Bearer ${token}`;
}
