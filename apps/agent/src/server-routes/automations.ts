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
  Automation,
  AutomationCadence,
  AutomationListResponse,
  AutomationRunListResponse,
  CreateAutomationRequest,
  RunAutomationResponse,
  TestAutomationResponse,
  UpdateAutomationRequest,
} from '@aurevoy/shared';
import { automationStore, projectStore } from '../store/db.js';
import type { AutomationScheduler } from '../automation/scheduler.js';

/** 自动化路由只负责 HTTP 校验与响应格式，调度语义继续由 AutomationScheduler 维护。 */
export function registerAutomationRoutes<
  RawServer extends RawServerBase,
  RawRequest extends RawRequestDefaultExpression<RawServer>,
  RawReply extends RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider,
>(
  app: FastifyInstance<RawServer, RawRequest, RawReply, Logger, TypeProvider>,
  automationScheduler: AutomationScheduler,
): void {
  // ---- 本地自动化：持久化配方仍通过普通任务进入 Pi harness ----
  app.get('/api/automations', async (): Promise<AutomationListResponse> => ({
    automations: automationStore.list(),
  }));

  app.post<{ Body: CreateAutomationRequest }>('/api/automations', async (req, reply) => {
    const name = req.body?.name?.trim();
    const goal = req.body?.goal?.trim();
    if (!name || !goal) return reply.code(400).send({ error: 'name and goal are required' });
    if (name.length > 120) return reply.code(400).send({ error: 'name is too long' });
    const cadence = parseAutomationCadence(req.body?.cadence);
    if (!cadence) return reply.code(400).send({ error: 'invalid cadence' });
    if (req.body?.projectId && !projectStore.get(req.body.projectId)) {
      return reply.code(404).send({ error: 'project not found' });
    }
    const now = new Date().toISOString();
    const enabled = req.body?.enabled === true;
    const automation: Automation = {
      id: randomUUID(),
      name,
      goal,
      projectId: req.body?.projectId,
      executionMode: req.body?.executionMode === 'plan' ? 'plan' : 'auto',
      budget: req.body?.budget,
      lifetimeBudget: req.body?.lifetimeBudget,
      cadence,
      enabled,
      nextRunAt: nextAutomationSchedule(enabled, cadence),
      runCount: 0,
      failureCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    return reply.code(201).send(automationStore.create(automation));
  });

  app.get<{ Params: { id: string } }>('/api/automations/:id', async (req, reply) => {
    const automation = automationStore.get(req.params.id);
    return automation ? reply.send(automation) : reply.code(404).send({ error: 'automation not found' });
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/automations/:id/runs',
    async (req, reply): Promise<AutomationRunListResponse | unknown> => {
      if (!automationStore.get(req.params.id)) return reply.code(404).send({ error: 'automation not found' });
      const parsedLimit = Number.parseInt(req.query?.limit ?? '30', 10);
      return { runs: automationStore.listRuns(req.params.id, Number.isFinite(parsedLimit) ? parsedLimit : 30) };
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateAutomationRequest }>(
    '/api/automations/:id',
    async (req, reply) => {
      const current = automationStore.get(req.params.id);
      if (!current) return reply.code(404).send({ error: 'automation not found' });
      const cadence = req.body?.cadence === undefined
        ? current.cadence
        : parseAutomationCadence(req.body.cadence);
      if (!cadence) return reply.code(400).send({ error: 'invalid cadence' });
      if (req.body?.name !== undefined && !req.body.name.trim()) return reply.code(400).send({ error: 'name cannot be empty' });
      if (req.body?.goal !== undefined && !req.body.goal.trim()) return reply.code(400).send({ error: 'goal cannot be empty' });
      if (req.body?.projectId && !projectStore.get(req.body.projectId)) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const enabled = req.body?.enabled ?? current.enabled;
      const cadenceChanged = req.body?.cadence !== undefined && req.body.cadence !== current.cadence;
      const enabledChanged = req.body?.enabled !== undefined && req.body.enabled !== current.enabled;
      const scheduleChanged = cadenceChanged || enabledChanged;
      const nextRunAt = enabled && cadence !== 'manual'
        ? (current.lastStatus === 'running' && !scheduleChanged
          ? current.nextRunAt
          : (scheduleChanged ? new Date().toISOString() : current.nextRunAt ?? new Date().toISOString()))
        : undefined;
      const patch: Parameters<typeof automationStore.update>[1] = {
        name: req.body?.name?.trim(),
        goal: req.body?.goal?.trim(),
        executionMode: req.body?.executionMode,
        budget: req.body?.budget,
        lifetimeBudget: req.body?.lifetimeBudget,
        cadence,
        enabled,
        nextRunAt: nextRunAt ?? null,
      };
      if (req.body?.projectId !== undefined) patch.projectId = req.body.projectId;
      return reply.send(automationStore.update(req.params.id, patch));
    },
  );

  app.delete<{ Params: { id: string } }>('/api/automations/:id', async (req, reply) => {
    if (!automationStore.delete(req.params.id)) return reply.code(404).send({ error: 'automation not found' });
    return reply.send({ deleted: true });
  });

  app.post<{ Params: { id: string } }>('/api/automations/:id/run', async (req, reply): Promise<RunAutomationResponse | unknown> => {
    if (!automationStore.get(req.params.id)) return reply.code(404).send({ error: 'automation not found' });
    try {
      const result = await automationScheduler.runNow(req.params.id);
      return reply.code(202).send({ ...result, streamUrl: `/api/tasks/${result.task.id}/stream` });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Body: CreateAutomationRequest }>('/api/automations/test-run', async (req, reply): Promise<TestAutomationResponse | unknown> => {
    const goal = req.body?.goal?.trim();
    if (!goal) return reply.code(400).send({ error: 'goal is required' });
    if (req.body?.projectId && !projectStore.get(req.body.projectId)) {
      return reply.code(404).send({ error: 'project not found' });
    }
    try {
      const task = await automationScheduler.testDraft({
        goal,
        projectId: req.body?.projectId,
        executionMode: req.body?.executionMode === 'plan' ? 'plan' : 'auto',
        budget: req.body?.budget,
        lifetimeBudget: req.body?.lifetimeBudget,
      });
      return reply.code(202).send({ task, streamUrl: `/api/tasks/${task.id}/stream` });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function parseAutomationCadence(value: unknown): AutomationCadence | undefined {
  if (value === undefined || value === null || value === '') return 'manual';
  if (value === 'manual' || value === 'hourly' || value === 'every_6_hours' || value === 'daily' || value === 'weekly') {
    return value;
  }
  return undefined;
}

function nextAutomationSchedule(enabled: boolean, cadence: AutomationCadence): string | undefined {
  return enabled && cadence !== 'manual' ? new Date().toISOString() : undefined;
}
