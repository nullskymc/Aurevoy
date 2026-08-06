import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyTypeProvider,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
} from "fastify";
import type {
  PiSessionTreeLabelRequest,
  PiSessionTreeNavigateRequest,
  PiSessionTreeNavigateResponse,
  PiSessionTreeResponse,
  TaskTraceListResponse,
} from "@aurevoy/shared";
import {
  getPiSessionTreeResponse,
  navigatePiSessionTree,
  setPiSessionTreeLabel,
} from "../agent/pi-harness/session-tree.js";
import { isTaskRunning } from "../agent/harness-controller.js";
import { taskStore, traceStore } from "../store/db.js";

/** 任务只读查询和 Pi 会话树导航路由，和创建/执行生命周期分离。 */
export function registerTaskReadRoutes<
  RawServer extends RawServerBase,
  RawRequest extends RawRequestDefaultExpression<RawServer>,
  RawReply extends RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider,
>(app: FastifyInstance<RawServer, RawRequest, RawReply, Logger, TypeProvider>): void {
  app.get<{ Querystring: { projectId?: string } }>("/api/tasks", async (req) => {
    const projectId = req.query?.projectId;
    if (projectId === "standalone") return taskStore.listSummaries(null);
    if (projectId) return taskStore.listSummaries(projectId);
    return taskStore.listSummaries();
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (req, reply) => {
    const task = taskStore.get(req.params.id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    return task;
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/traces", async (req, reply) => {
    const task = taskStore.get(req.params.id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const body: TaskTraceListResponse = {
      taskId: req.params.id,
      traces: traceStore.list(req.params.id),
    };
    return reply.send(body);
  });

  // Pi 原生会话树是只读投影，完整消息内容仍以 Task.messages 为产品级真相。
  app.get<{ Params: { id: string } }>("/api/tasks/:id/session-tree", async (req, reply) => {
    const task = taskStore.get(req.params.id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const body: PiSessionTreeResponse = await getPiSessionTreeResponse(req.params.id);
    return reply.send(body);
  });

  app.post<{
    Params: { id: string };
    Body: PiSessionTreeNavigateRequest;
  }>("/api/tasks/:id/session-tree/navigate", async (req, reply) => {
    const task = taskStore.get(req.params.id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    if (isTaskRunning(req.params.id)) {
      return reply.code(409).send({ error: "任务运行中，不能切换会话分支" });
    }
    const targetId = req.body?.targetId?.trim();
    if (!targetId) return reply.code(400).send({ error: "targetId is required" });
    try {
      const body: PiSessionTreeNavigateResponse = await navigatePiSessionTree(task, targetId, {
        summarize: req.body?.summarize,
        customInstructions: req.body?.customInstructions?.trim() || undefined,
      });
      return reply.send(body);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put<{
    Params: { id: string; targetId: string };
    Body: PiSessionTreeLabelRequest;
  }>("/api/tasks/:id/session-tree/labels/:targetId", async (req, reply) => {
    const task = taskStore.get(req.params.id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    try {
      return reply.send(await setPiSessionTreeLabel(
        task.id,
        req.params.targetId,
        req.body?.label?.trim() || undefined,
      ));
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
