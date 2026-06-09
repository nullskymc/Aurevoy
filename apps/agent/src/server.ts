import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
  CleanupDataRequest,
  CleanupDataResponse,
  ContinueTaskRequest,
  ContinueTaskResponse,
  CreateMemoryRequest,
  CreateTaskRequest,
  CreateTaskResponse,
  DataStatusResponse,
  HealthResponse,
  MemoryCategory,
  MemoryEntry,
  MemoryListResponse,
  ModelListResponse,
  ResumeTaskResponse,
  TaskTraceListResponse,
  UpdateRuntimeSettingsRequest,
  UpdateToolRequest,
  UpdateMemoryRequest,
} from '@aurevoy/shared';
import { config } from './config.js';
import {
  addUserTurn,
  cancelTask,
  createTask,
  isTaskRunning,
  markInterruptedTasksAfterRestart,
  prepareTaskForResume,
  resolveApproval,
  runTask,
} from './agent/loop.js';
import { taskEvents } from './agent/events.js';
import { taskStore, traceStore, memoryStore, toolSettingsStore } from './store/db.js';
import { toolRegistry } from './tools/registry.js';
import { getProviderName, listProviderModels } from './llm/provider.js';
import { getMcpStatuses, reloadMcpTools } from './tools/mcp.js';
import {
  loadPersistedSettings,
  readCleanupPolicyDays,
  readRuntimeSettings,
  updateRuntimeSettings,
} from './runtime/settings.js';

const startedAt = Date.now();

export async function buildServer() {
  const app = Fastify({ logger: true });
  loadPersistedSettings();
  toolRegistry.applySettings(toolSettingsStore.list());
  const recoveredTasks = markInterruptedTasksAfterRestart();
  if (recoveredTasks.length > 0) {
    app.log.warn(`启动恢复：${recoveredTasks.length} 个未完成任务已标记为可恢复失败`);
  }

  await app.register(cors, { origin: config.corsOrigins });

  // 健康检查
  app.get('/api/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      version: '0.1.0',
      uptimeMs: Date.now() - startedAt,
      provider: getProviderName(),
    };
  });

  // 已注册工具列表（调试/前端展示用）
  app.get('/api/tools', async () => toolRegistry.listAll());

  app.patch<{ Params: { name: string }; Body: UpdateToolRequest }>(
    '/api/tools/:name',
    async (req, reply) => {
      const enabled = req.body?.enabled;
      if (typeof enabled !== 'boolean') {
        return reply.code(400).send({ error: 'enabled(boolean) 必填' });
      }
      const updated = toolRegistry.setEnabled(req.params.name, enabled);
      if (!updated) return reply.code(404).send({ error: 'tool not found' });
      toolSettingsStore.setEnabled(req.params.name, enabled);
      const tool = toolRegistry.listAll().find((item) => item.name === req.params.name);
      return reply.send(tool);
    },
  );

  app.get('/api/mcp/status', async () => {
    return { servers: getMcpStatuses() };
  });

  app.get('/api/settings', async () => readRuntimeSettings());

  app.get('/api/settings/models', async (_req, reply): Promise<ModelListResponse | unknown> => {
    try {
      return { models: await listProviderModels() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.patch<{ Body: UpdateRuntimeSettingsRequest }>('/api/settings', async (req, reply) => {
    try {
      const result = updateRuntimeSettings(req.body ?? {});
      if (result.mcpChanged) {
        await reloadMcpTools();
        toolRegistry.applySettings(toolSettingsStore.list());
      }
      return reply.send(result.settings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.get('/api/data', async (): Promise<DataStatusResponse> => {
    return {
      dbPath: config.dbPath,
      workspaceDir: config.workspaceDir,
      cleanupPolicyDays: readCleanupPolicyDays(),
      counts: {
        tasks: taskStore.count(),
        traces: traceStore.count(),
        memories: memoryStore.count(),
      },
    };
  });

  app.post<{ Body: CleanupDataRequest }>('/api/data/cleanup', async (req): Promise<CleanupDataResponse> => {
    const olderThanDays = req.body?.olderThanDays ?? readCleanupPolicyDays();
    return taskStore.cleanupTerminal(olderThanDays);
  });

  // 任务列表
  app.get('/api/tasks', async () => taskStore.list());

  // 单个任务详情
  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    const task = taskStore.get(req.params.id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    return task;
  });

  // 单个任务的持久轨迹
  app.get<{ Params: { id: string } }>('/api/tasks/:id/traces', async (req, reply) => {
    const task = taskStore.get(req.params.id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    const body: TaskTraceListResponse = {
      taskId: req.params.id,
      traces: traceStore.list(req.params.id),
    };
    return reply.send(body);
  });

  // 创建并启动任务
  app.post<{ Body: CreateTaskRequest }>('/api/tasks', async (req, reply) => {
    const goal = req.body?.goal?.trim();
    if (!goal) return reply.code(400).send({ error: 'goal is required' });

    const task = createTask(goal);
    // 异步执行，立即返回；前端通过 SSE 订阅进度
    void runTask(task);

    taskEvents.publish({ type: 'task_created', taskId: task.id, task });

    const body: CreateTaskResponse = {
      task,
      streamUrl: `/api/tasks/${task.id}/stream`,
    };
    return reply.code(201).send(body);
  });

  // 多轮对话：在同一任务内追加一轮用户输入并继续执行（保留完整上下文）
  app.post<{ Params: { id: string }; Body: ContinueTaskRequest }>(
    '/api/tasks/:id/messages',
    async (req, reply) => {
      const task = taskStore.get(req.params.id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      if (isTaskRunning(req.params.id)) {
        return reply.code(409).send({ error: '任务正在运行，请等待当前轮结束后再追问' });
      }
      const message = req.body?.message?.trim();
      if (!message) return reply.code(400).send({ error: 'message is required' });

      addUserTurn(task, message);
      // 异步带完整历史重跑循环；前端通过同一 SSE 地址订阅这一轮
      void runTask(task);

      const body: ContinueTaskResponse = {
        task,
        streamUrl: `/api/tasks/${task.id}/stream`,
      };
      return reply.code(202).send(body);
    },
  );

  // 任务恢复：从持久消息历史重新进入 Agent 循环，不伪造用户输入。
  app.post<{ Params: { id: string } }>('/api/tasks/:id/resume', async (req, reply) => {
    const task = taskStore.get(req.params.id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    if (isTaskRunning(req.params.id)) {
      return reply.code(409).send({ error: '任务正在运行，不能重复恢复' });
    }
    if (task.status === 'completed') {
      return reply.code(409).send({ error: '已完成任务不需要恢复' });
    }

    const resumed = prepareTaskForResume(task);
    void runTask(resumed);

    const body: ResumeTaskResponse = {
      task: resumed,
      streamUrl: `/api/tasks/${resumed.id}/stream`,
    };
    return reply.code(202).send(body);
  });

  // 取消一个进行中的任务
  app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (req, reply) => {
    const task = taskStore.get(req.params.id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    const cancelled = cancelTask(req.params.id);
    // 任务可能已结束（无活跃句柄）；此时返回当前状态即可
    return reply.send({ taskId: req.params.id, cancelling: cancelled, status: task.status });
  });

  // 对一次工具调用做出审批决策（批准/拒绝）
  app.post<{ Params: { id: string }; Body: ApprovalDecisionRequest }>(
    '/api/tasks/:id/approvals',
    async (req, reply) => {
      const task = taskStore.get(req.params.id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      const { callId, approved } = req.body ?? {};
      if (typeof callId !== 'string' || typeof approved !== 'boolean') {
        return reply.code(400).send({ error: 'callId(string) 与 approved(boolean) 必填' });
      }
      const delivered = resolveApproval(req.params.id, callId, approved);
      const body: ApprovalDecisionResponse = { taskId: req.params.id, callId, delivered };
      return reply.send(body);
    },
  );

  // ===== 长期记忆 CRUD (M4.3) =====
  const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
    'preference',
    'directory',
    'model',
    'habit',
    'fact',
    'other',
  ];
  const isCategory = (v: unknown): v is MemoryCategory =>
    typeof v === 'string' && MEMORY_CATEGORIES.includes(v as MemoryCategory);
  const clampConfidence = (v: unknown): number => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : 1;
    return Math.min(1, Math.max(0, n));
  };

  // 列出全部记忆（含禁用，供管理界面查看）
  app.get('/api/memories', async (): Promise<MemoryListResponse> => {
    return { memories: memoryStore.list() };
  });

  // 用户手动新增一条记忆
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
    return reply.code(201).send(entry);
  });

  // 编辑 / 启停一条记忆
  app.patch<{ Params: { id: string }; Body: UpdateMemoryRequest }>(
    '/api/memories/:id',
    async (req, reply) => {
      const existing = memoryStore.get(req.params.id);
      if (!existing) return reply.code(404).send({ error: 'memory not found' });
      const body = req.body ?? {};
      const patch: Partial<Pick<MemoryEntry, 'content' | 'category' | 'confidence' | 'enabled'>> = {};
      if (typeof body.content === 'string') {
        const trimmed = body.content.trim();
        if (!trimmed) return reply.code(400).send({ error: 'content 不能为空' });
        patch.content = trimmed;
      }
      if (body.category !== undefined) {
        if (!isCategory(body.category)) return reply.code(400).send({ error: 'category 非法' });
        patch.category = body.category;
      }
      if (body.confidence !== undefined) patch.confidence = clampConfidence(body.confidence);
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      const updated = memoryStore.update(req.params.id, patch);
      return reply.send(updated);
    },
  );

  // 删除一条记忆
  app.delete<{ Params: { id: string } }>('/api/memories/:id', async (req, reply) => {
    const deleted = memoryStore.delete(req.params.id);
    if (!deleted) return reply.code(404).send({ error: 'memory not found' });
    return reply.send({ id: req.params.id, deleted: true });
  });

  // SSE 事件流：订阅某个任务的实时输出
  app.get<{ Params: { id: string } }>('/api/tasks/:id/stream', (req, reply) => {
    const { id } = req.params;
    const task = taskStore.get(id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    const origin = req.headers.origin;
    const corsOrigin = config.corsOrigins.includes('*')
      ? '*'
      : origin && config.corsOrigins.includes(origin)
        ? origin
        : config.corsOrigins[0];

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': corsOrigin ?? '*',
      'X-Accel-Buffering': 'no',
    });

    let heartbeat: ReturnType<typeof setInterval>;

    const send = (event: AgentEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'done') {
        clearInterval(heartbeat);
        unsubscribe();
        reply.raw.end();
      }
    };

    const unsubscribe = taskEvents.subscribe(id, send);

    // 新订阅者可能错过创建后的快速事件；先补发数据库快照，保证 UI 可恢复。
    send({ type: 'task_created', taskId: task.id, task });
    send({ type: 'status', taskId: task.id, status: task.status });
    if (task.phase) {
      send({ type: 'phase', taskId: task.id, phase: task.phase, detail: '数据库快照' });
    }
    if (task.plan.length > 0) {
      send({ type: 'plan', taskId: task.id, plan: task.plan });
    }
    for (const message of task.messages) {
      send({ type: 'message', taskId: task.id, message });
    }
    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      send({ type: 'done', taskId: task.id, status: task.status });
      return;
    }

    // 心跳，避免连接被中间层断开
    heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return app;
}
