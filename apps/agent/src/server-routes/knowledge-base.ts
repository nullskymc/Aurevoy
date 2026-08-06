import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyTypeProvider,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
} from 'fastify';
import { addKbDir, deleteKbDir, getKbIndexStatus, listKbDirs } from '../knowledge-base/index.js';

/** 知识库目录管理路由；索引实现留在 knowledge-base 模块，HTTP 层只做参数与错误映射。 */
export function registerKnowledgeBaseRoutes<
  RawServer extends RawServerBase,
  RawRequest extends RawRequestDefaultExpression<RawServer>,
  RawReply extends RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider,
>(app: FastifyInstance<RawServer, RawRequest, RawReply, Logger, TypeProvider>): void {
  app.get('/api/knowledge-base/dirs', async () => ({ dirs: listKbDirs() }));

  app.post<{ Body: { dirPath: string; recursive?: boolean } }>(
    '/api/knowledge-base/dirs',
    async (req, reply) => {
      const { dirPath, recursive } = req.body ?? {};
      if (!dirPath?.trim()) return reply.code(400).send({ error: 'dirPath 不能为空' });
      try {
        return reply.code(201).send(addKbDir(dirPath.trim(), recursive !== false));
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : '添加目录失败' });
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/knowledge-base/dirs/:id', async (req, reply) => {
    const deleted = deleteKbDir(req.params.id);
    if (!deleted) return reply.code(404).send({ error: 'kb dir not found' });
    return reply.send({ id: req.params.id, deleted: true });
  });

  app.get('/api/knowledge-base/status', async () => getKbIndexStatus());
}
