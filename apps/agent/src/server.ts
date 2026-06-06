import Fastify from 'fastify';
import cors from '@fastify/cors';
import type {
  AgentEvent,
  CreateTaskRequest,
  CreateTaskResponse,
  HealthResponse,
} from '@aurevoy/shared';
import { config } from './config.js';
import { createTask, runTask } from './agent/loop.js';
import { taskEvents } from './agent/events.js';
import { taskStore } from './store/db.js';
import { toolRegistry } from './tools/registry.js';

const startedAt = Date.now();

export async function buildServer() {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: config.corsOrigins });

  // 健康检查
  app.get('/api/health', async (): Promise<HealthResponse> => {
    return { status: 'ok', version: '0.1.0', uptimeMs: Date.now() - startedAt };
  });

  // 已注册工具列表（调试/前端展示用）
  app.get('/api/tools', async () => toolRegistry.list());

  // 任务列表
  app.get('/api/tasks', async () => taskStore.list());

  // 单个任务详情
  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    const task = taskStore.get(req.params.id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    return task;
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
