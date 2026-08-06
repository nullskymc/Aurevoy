import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyTypeProvider,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
} from 'fastify';

/** 认证路由只暴露内存中的启动会话令牌；令牌本身不进入日志或 SQLite。 */
export function registerAuthRoutes<
  RawServer extends RawServerBase,
  RawRequest extends RawRequestDefaultExpression<RawServer>,
  RawReply extends RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider,
>(
  app: FastifyInstance<RawServer, RawRequest, RawReply, Logger, TypeProvider>,
  apiToken: string,
): void {
  app.get('/api/auth/bootstrap', async () => ({ token: apiToken }));
}
