import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyTypeProvider,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
} from 'fastify';
import type { AgentEvent, StreamAgentEvent } from '@aurevoy/shared';
import { config } from '../config.js';
import { taskEvents } from '../agent/events.js';
import { taskStore } from '../store/db.js';

/** SSE 路由只负责快照重放、实时事件订阅和背压；任务生命周期由任务路由处理。 */
export function registerTaskStreamRoutes<
  RawServer extends RawServerBase,
  RawRequest extends RawRequestDefaultExpression<RawServer>,
  RawReply extends RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider,
>(app: FastifyInstance<RawServer, RawRequest, RawReply, Logger, TypeProvider>): void {
  // SSE 事件流：订阅某个任务的实时输出
  app.get<{
    Params: { id: string };
    Querystring: { snapshot?: string; afterSeq?: string };
  }>('/api/tasks/:id/stream', (req, reply) => {
    const { id } = req.params;
    const task = taskStore.get(id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    const headerAfterSeq = Number.parseInt(String(req.headers['last-event-id'] ?? ''), 10);
    const queryAfterSeq = Number.parseInt(req.query.afterSeq ?? '', 10);
    const afterSeq = Number.isFinite(headerAfterSeq)
      ? Math.max(0, headerAfterSeq)
      : Number.isFinite(queryAfterSeq)
        ? Math.max(0, queryAfterSeq)
        : 0;
    const clientHasSnapshot = req.query.snapshot === '0';
    const origin = req.headers.origin;
    const corsOrigin = origin && config.corsOrigins.includes(origin)
      ? origin
      : config.corsOrigins[0];

      // Fastify 泛型允许多种 Node reply 类型；SSE 需要 ServerResponse 的背压 API。
      const raw = reply.raw as unknown as import('node:http').ServerResponse;
      raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': corsOrigin ?? '*',
      'X-Accel-Buffering': 'no',
    });

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribe = () => {};
    let replayingSnapshot = true;
    let streamClosed = false;
    const bufferedLiveEvents: StreamAgentEvent[] = [];
    const snapshotMessageIds = new Set(task.messages.map((message) => message.id));

    // ---- SSE 批量写入 + TCP 背压 ----
    let sseBuf: string[] = [];
    let sseTimer: ReturnType<typeof setImmediate> | null = null;
    const writeQueue: string[] = [];
    let writeQueueIndex = 0;
    let writePaused = false;
    let endRequested = false;

    const drainWriteQueue = () => {
        if (writePaused || raw.writableEnded) return;
      while (writeQueueIndex < writeQueue.length) {
        const chunk = writeQueue[writeQueueIndex++]!;
          if (!raw.write(chunk)) {
          writePaused = true;
            raw.once('drain', () => {
            writePaused = false;
            drainWriteQueue();
          });
          return;
        }
      }
      writeQueue.length = 0;
      writeQueueIndex = 0;
        if (endRequested && !raw.writableEnded) raw.end();
    };

    const enqueueWrite = (chunk: string) => {
      writeQueue.push(chunk);
      drainWriteQueue();
    };

    const sseFlush = () => {
      sseTimer = null;
      if (sseBuf.length === 0) return;
      const batch = sseBuf.join('');
      sseBuf = [];
      enqueueWrite(batch);
    };

    /** 需要立即刷入的事件类型 */
    const DRAIN_EVENTS = new Set([
      'done', 'task_deleted', 'error', 'status',
      'agent_start', 'message_start',
      'context_snapshot',
      'clarification_request', 'clarification_resolved',
      'approval_request',
      'tool_call', 'tool_result', 'message',
      'subagent_updated',
    ]);

    const send = (event: StreamAgentEvent) => {
      if (streamClosed) return;
      const line = `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;

      if (event.type === 'done' || event.type === 'task_deleted') {
        if (sseBuf.length > 0) sseFlush();
        enqueueWrite(line);
        streamClosed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
        endRequested = true;
        drainWriteQueue();
        return;
      }

      sseBuf.push(line);

      if (DRAIN_EVENTS.has(event.type)) {
        if (sseTimer) clearImmediate(sseTimer);
        sseFlush();
      } else if (!sseTimer) {
        sseTimer = setImmediate(sseFlush);
      }
    };

    const sendSnapshot = (event: AgentEvent, seq: number) => send(Object.assign(event, {
      seq,
      emittedAt: new Date().toISOString(),
    }) as StreamAgentEvent);

    const sendLive = (event: StreamAgentEvent) => {
      if (replayingSnapshot) {
        bufferedLiveEvents.push(event);
        return;
      }
      send(event);
    };

    // 先订阅实时事件，再补发任务持久状态快照。
    // 这样快照期间发生的新 message/tool_result 不会落入“快照之后、订阅之前”的空窗。
    // 快照发送期间的实时事件先缓冲，等快照完整发完后再按原顺序补发。
    const replayHighWaterSeq = taskEvents.latestSeq(id);
    unsubscribe = taskEvents.subscribe(id, sendLive);
    const replay = taskEvents.replayAfter(id, afterSeq, replayHighWaterSeq);

    if (clientHasSnapshot && replay.complete) {
      // POST/GET 已提供完整 Task；这里只补建连空窗和短线重连期间的增量事件。
      for (const event of replay.events) {
        if (event.type === 'task_created') continue;
        send(event);
        if (streamClosed) return;
      }
    } else {
      // 外部/旧客户端或事件日志出现缺口时回退完整持久快照。
      sendSnapshot({ type: 'task_created', taskId: task.id, task }, replayHighWaterSeq);
      sendSnapshot({
        type: 'phase',
        taskId: task.id,
        phase: task.phase ?? 'initializing',
      }, replayHighWaterSeq);
    }
    // 终态，或预算触顶暂停（本 run 已结束，前端应解除 busy）
    if (
      ['completed', 'failed', 'cancelled'].includes(task.status) ||
      (task.status === 'paused' &&
        (task.phase === 'waiting_budget' || task.phase === 'waiting_completion'))
    ) {
      replayingSnapshot = false;
      sendSnapshot({ type: 'done', taskId: task.id, status: task.status }, replayHighWaterSeq);
      return;
    }

    // 快照发送完毕，排空缓冲区后再补发快照期间捕获的实时事件。
    if (sseBuf.length > 0) sseFlush();
    replayingSnapshot = false;
    for (const event of bufferedLiveEvents.splice(0)) {
      if (event.type === 'message' && snapshotMessageIds.has(event.message.id)) continue;
      send(event);
      if (streamClosed) return;
    }

    // 心跳，避免连接被中间层断开
    heartbeat = setInterval(() => {
      enqueueWrite(': ping\n\n');
    }, 15000);

    req.raw.on('close', () => {
      if (heartbeat) clearInterval(heartbeat);
      if (sseTimer) clearImmediate(sseTimer);
      sseBuf = [];
      writeQueue.length = 0;
      writeQueueIndex = 0;
      unsubscribe();
    });
  });

  }
