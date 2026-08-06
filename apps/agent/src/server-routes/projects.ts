import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, resolve } from 'node:path';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyTypeProvider,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
} from 'fastify';
import type {
  CreateProjectRequest,
  ProjectListResponse,
  UpdateProjectRequest,
} from '@aurevoy/shared/contracts';
import { projectStore } from '../store/db.js';

/** 项目 CRUD 路由只负责 HTTP 校验；项目路径和关联任务语义由 repository/任务层维护。 */
export function registerProjectRoutes<
  RawServer extends RawServerBase,
  RawRequest extends RawRequestDefaultExpression<RawServer>,
  RawReply extends RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider,
>(app: FastifyInstance<RawServer, RawRequest, RawReply, Logger, TypeProvider>): void {
  app.get('/api/projects', async (): Promise<ProjectListResponse> => ({
    projects: projectStore.list(),
  }));

  app.post<{ Body: CreateProjectRequest }>('/api/projects', async (req, reply) => {
    const rawPath = req.body?.path?.trim();
    if (!rawPath) return reply.code(400).send({ error: 'path is required' });

    const absPath = resolve(rawPath);
    const stat = await fs.stat(absPath).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      return reply.code(400).send({ error: 'path must be an existing directory' });
    }

    const existing = projectStore.getByPath(absPath);
    if (existing) return reply.code(409).send({ error: 'project with this path already exists' });

    const now = new Date().toISOString();
    const name = req.body?.name?.trim() || basename(absPath);
    const project = projectStore.create({
      id: randomUUID(),
      name,
      path: absPath,
      createdAt: now,
      updatedAt: now,
    });
    return reply.code(201).send(project);
  });

  app.patch<{ Params: { id: string }; Body: UpdateProjectRequest }>(
    '/api/projects/:id',
    async (req, reply) => {
      const name = req.body?.name?.trim();
      if (!name) return reply.code(400).send({ error: 'name is required' });
      const updated = projectStore.update(req.params.id, { name });
      if (!updated) return reply.code(404).send({ error: 'project not found' });
      return reply.send(updated);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const result = projectStore.delete(req.params.id);
    if (!result.deleted) return reply.code(404).send({ error: 'project not found' });
    return reply.send(result);
  });
}
