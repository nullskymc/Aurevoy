import { randomUUID } from 'node:crypto';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyTypeProvider,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
} from 'fastify';
import type {
  CreateMemoryRequest,
  MemoryCategory,
  MemoryEntry,
  MemoryListResponse,
  UpdateMemoryRequest,
} from '@aurevoy/shared';
import { invalidateMemorySummary, memoryStore } from '../store/db.js';

const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  'preference',
  'directory',
  'model',
  'habit',
  'fact',
  'other',
];

function isCategory(value: unknown): value is MemoryCategory {
  return typeof value === 'string' && MEMORY_CATEGORIES.includes(value as MemoryCategory);
}

function clampConfidence(value: unknown): number {
  const numberValue = typeof value === 'number' && Number.isFinite(value) ? value : 1;
  return Math.min(1, Math.max(0, numberValue));
}

/** 长期记忆 CRUD 路由；每次变更都使摘要缓存失效，避免 UI 与召回读取旧结果。 */
export function registerMemoryRoutes<
  RawServer extends RawServerBase,
  RawRequest extends RawRequestDefaultExpression<RawServer>,
  RawReply extends RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider,
>(app: FastifyInstance<RawServer, RawRequest, RawReply, Logger, TypeProvider>): void {
  app.get('/api/memories', async (): Promise<MemoryListResponse> => ({
    memories: memoryStore.list(),
  }));

  app.post<{ Body: CreateMemoryRequest }>('/api/memories', async (req, reply) => {
    const content = req.body?.content?.trim();
    if (!content) return reply.code(400).send({ error: 'content is required' });
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: randomUUID(),
      category: isCategory(req.body?.category) ? req.body.category : 'other',
      content,
      confidence: req.body?.confidence === undefined ? 1 : clampConfidence(req.body.confidence),
      enabled: true,
      source: { origin: 'user', createdAt: now },
      createdAt: now,
      updatedAt: now,
    };
    memoryStore.create(entry);
    invalidateMemorySummary();
    return reply.code(201).send(entry);
  });

  app.patch<{ Params: { id: string }; Body: UpdateMemoryRequest }>(
    '/api/memories/:id',
    async (req, reply) => {
      const existing = memoryStore.get(req.params.id);
      if (!existing) return reply.code(404).send({ error: 'memory not found' });
      const body = req.body ?? {};
      const patch: Partial<Pick<MemoryEntry, 'content' | 'category' | 'confidence' | 'enabled'>> = {};
      if (typeof body.content === 'string') {
        const content = body.content.trim();
        if (!content) return reply.code(400).send({ error: 'content 不能为空' });
        patch.content = content;
      }
      if (body.category !== undefined) {
        if (!isCategory(body.category)) return reply.code(400).send({ error: 'category 非法' });
        patch.category = body.category;
      }
      if (body.confidence !== undefined) patch.confidence = clampConfidence(body.confidence);
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      const updated = memoryStore.update(req.params.id, patch);
      invalidateMemorySummary();
      return reply.send(updated);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/memories/:id', async (req, reply) => {
    const deleted = memoryStore.delete(req.params.id);
    if (!deleted) return reply.code(404).send({ error: 'memory not found' });
    invalidateMemorySummary();
    return reply.send({ id: req.params.id, deleted: true });
  });
}
