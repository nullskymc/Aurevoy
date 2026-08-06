import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyTypeProvider,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
} from 'fastify';
import type {
  AgentThinkingLevel,
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
  BranchTaskRequest,
  BranchTaskResponse,
  ClearTaskQueueRequest,
  ClearTaskQueueResponse,
  ClarificationAnswerRequest,
  ClarificationAnswerResponse,
  CompactTaskRequest,
  CompactTaskResponse,
  ContinueBudgetRequest,
  ContinueBudgetResponse,
  ContinueTaskRequest,
  ContinueTaskResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  DeleteTaskResponse,
  RevertTaskRequest,
  RevertTaskResponse,
  ResumeTaskResponse,
  TaskArtifactContentResponse,
  UnrevertTaskResponse,
  UpdateTaskArtifactRequest,
  UpdateTaskModelRequest,
  UpdateTaskModelResponse,
} from '@aurevoy/shared';
import {
  addUserTurn,
  branchTask,
  cancelTask,
  compactTask,
  clearRunningUserQueue,
  createTask,
  isTaskRunning,
  prepareTaskForBudgetContinue,
  prepareTaskForResume,
  queueRunningUserTurn,
  resolveApproval,
  resolveClarificationAnswer,
  resumeAutoMode,
  revertTask,
  runHarnessTask,
  setTaskExecutionMode,
  updateTaskModel,
  unrevertTask,
} from '../agent/harness-controller.js';
import { taskEvents } from '../agent/events.js';
import { AttachmentUploadError, MAX_UPLOADED_IMAGE_BYTES, splitIncomingAttachments } from '../agent/attachment-upload.js';
import { projectStore, taskStore } from '../store/db.js';

const IMAGE_UPLOAD_BODY_LIMIT = Math.ceil(MAX_UPLOADED_IMAGE_BYTES * 4 / 3) + 1024 * 1024;

/** 任务创建、对话推进、恢复、审批和产物更新路由。 */
export function registerTaskWriteRoutes<
  RawServer extends RawServerBase,
  RawRequest extends RawRequestDefaultExpression<RawServer>,
  RawReply extends RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider,
>(app: FastifyInstance<RawServer, RawRequest, RawReply, Logger, TypeProvider>): void {
  // 创建并启动任务
  app.post<{ Body: CreateTaskRequest }>('/api/tasks', { bodyLimit: IMAGE_UPLOAD_BODY_LIMIT }, async (req, reply) => {
    const goal = req.body?.goal?.trim();
    if (!goal) return reply.code(400).send({ error: 'goal is required' });

    const projectId = req.body?.projectId;
    if (projectId) {
      const project = projectStore.get(projectId);
      if (!project) return reply.code(404).send({ error: 'project not found' });
    }

    let messageInput;
    try {
      messageInput = splitIncomingAttachments(req.body?.attachments);
    } catch (err) {
      const message = err instanceof AttachmentUploadError ? err.message : `图片上传失败：${err instanceof Error ? err.message : String(err)}`;
      return reply.code(400).send({ error: message });
    }

    const task = createTask(
      goal,
      req.body?.budget,
      projectId,
      messageInput.attachments,
      req.body?.lifetimeBudget,
      req.body?.executionMode === 'plan' ? 'plan' : 'auto',
      messageInput.imageParts,
    );
    // 异步执行，立即返回；前端通过 SSE 订阅进度
    void runHarnessTask(task);

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
    { bodyLimit: IMAGE_UPLOAD_BODY_LIMIT },
    async (req, reply) => {
      const task = taskStore.get(req.params.id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      const message = req.body?.message?.trim();
      if (!message) return reply.code(400).send({ error: 'message is required' });
      let messageInput;
      try {
        messageInput = splitIncomingAttachments(req.body?.attachments);
      } catch (err) {
        const error = err instanceof AttachmentUploadError ? err.message : `图片上传失败：${err instanceof Error ? err.message : String(err)}`;
        return reply.code(400).send({ error });
      }
      if (isTaskRunning(req.params.id)) {
        const delivery = req.body?.delivery === 'follow_up' ? 'follow_up' : 'steering';
        const queued = await queueRunningUserTurn(task, message, delivery, messageInput.attachments, messageInput.imageParts);
        if (!queued.delivered) {
          return reply.code(409).send({ error: '任务正在运行，但 Pi harness 队列不可用，请等待当前轮结束后再追问' });
        }
        const body: ContinueTaskResponse = {
          task,
          streamUrl: `/api/tasks/${task.id}/stream`,
        };
        return reply.code(202).send(body);
      }

      setTaskExecutionMode(task, req.body?.executionMode === 'plan' ? 'plan' : 'auto');
      addUserTurn(task, message, messageInput.attachments, messageInput.imageParts);
      // 异步带完整历史重跑循环；前端通过同一 SSE 地址订阅这一轮
      void runHarnessTask(task);

      const body: ContinueTaskResponse = {
        task,
        streamUrl: `/api/tasks/${task.id}/stream`,
      };
      return reply.code(202).send(body);
    },
  );

  // 撤回尚未进入模型上下文的 steering / follow-up 队列。
  app.post<{ Params: { id: string }; Body: ClearTaskQueueRequest }>(
    '/api/tasks/:id/queue/clear',
    async (req, reply) => {
      const task = taskStore.get(req.params.id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      if (!isTaskRunning(req.params.id)) {
        return reply.code(409).send({ error: '任务当前没有运行中的待注入队列' });
      }
      const kind = req.body?.kind ?? 'all';
      if (kind !== 'steering' && kind !== 'follow_up' && kind !== 'all') {
        return reply.code(400).send({ error: 'kind 必须是 steering/follow_up/all' });
      }
      const cleared = await clearRunningUserQueue(task, kind);
      if (!cleared) {
        return reply.code(409).send({ error: 'Pi harness 队列不可用，消息可能已经进入模型上下文' });
      }
      const body: ClearTaskQueueResponse = { taskId: task.id, kind, cleared };
      return reply.send(body);
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

    // waiting_budget 走专用续跑路径：自动保证寿命额度够再跑一轮
    const resumed =
      task.phase === 'waiting_budget' || task.budgetExceeded
        ? prepareTaskForBudgetContinue(task)
        : prepareTaskForResume(task);
    void runHarnessTask(resumed);

    const body: ResumeTaskResponse = {
      task: resumed,
      streamUrl: `/api/tasks/${resumed.id}/stream`,
    };
    return reply.code(202).send(body);
  });

  // 预算触顶后续跑：可选扩容寿命 / 覆盖 run 预算，再进入 harness。
  app.post<{ Params: { id: string }; Body: ContinueBudgetRequest }>(
    '/api/tasks/:id/budget/continue',
    async (req, reply) => {
      const task = taskStore.get(req.params.id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      if (isTaskRunning(req.params.id)) {
        return reply.code(409).send({ error: '任务正在运行，不能重复续跑' });
      }
      if (task.status === 'completed') {
        return reply.code(409).send({ error: '已完成任务不需要续跑' });
      }
      if (task.status === 'cancelled') {
        return reply.code(409).send({ error: '已取消任务不能续跑' });
      }

      const continued = prepareTaskForBudgetContinue(task, req.body);
      void runHarnessTask(continued);

      const body: ContinueBudgetResponse = {
        task: continued,
        streamUrl: `/api/tasks/${continued.id}/stream`,
      };
      return reply.code(202).send(body);
    },
  );

  // 恢复已暂停的 auto mode（重置连续计数，继续自动执行）
  app.post<{ Params: { id: string } }>('/api/tasks/:id/auto-mode-resume', (req, reply) => {
    const ok = resumeAutoMode(req.params.id);
    if (!ok) return reply.code(409).send({ error: 'auto mode 未处于暂停状态' });
    return reply.code(200).send({ ok: true });
  });

  // 编辑重试截断：移除目标消息及其之后的历史；前端内联确认后立刻 continue 编辑稿。
  app.post<{ Params: { id: string }; Body: RevertTaskRequest }>(
    '/api/tasks/:id/revert',
    async (req, reply) => {
      const task = taskStore.get(req.params.id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      if (isTaskRunning(req.params.id)) {
        return reply.code(409).send({ error: '任务正在运行，请等待当前轮结束后再编辑' });
      }
      const messageId = req.body?.messageId?.trim();
      if (!messageId) return reply.code(400).send({ error: 'messageId is required' });
      const mode = req.body?.mode ?? 'code_and_conv';

      const result = revertTask(task, messageId, mode);
      if (result.removedCount === 0) {
        return reply.code(404).send({ error: 'message not found in task history' });
      }
      const body: RevertTaskResponse = {
        task: result.task,
        removedContent: result.removedContent,
        removedMessageId: result.removedMessageId,
        removedCount: result.removedCount,
      };
      return reply.code(200).send(body);
    },
  );

  // 撤销上一次 revert：从归档恢复。仅当 archivedMessages 仍在（continue 尚未写入）时可用。
  app.post<{ Params: { id: string } }>('/api/tasks/:id/unrevert', async (req, reply) => {
    const task = taskStore.get(req.params.id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    if (isTaskRunning(req.params.id)) {
      return reply.code(409).send({ error: '任务正在运行，不能撤销编辑' });
    }
    const result = unrevertTask(task);
    if (result.restoredCount === 0) {
      return reply.code(409).send({ error: '没有可撤销的编辑操作' });
    }
    const body: UnrevertTaskResponse = {
      task: result.task,
      restoredCount: result.restoredCount,
    };
    return reply.code(200).send(body);
  });

  // 分支：从指定消息处克隆出一个新任务（非破坏性 fork）
  app.post<{ Params: { id: string }; Body: BranchTaskRequest }>(
    '/api/tasks/:id/branch',
    async (req, reply) => {
      const task = taskStore.get(req.params.id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      const messageId = req.body?.messageId?.trim();
      if (!messageId) return reply.code(400).send({ error: 'messageId is required' });

      const result = branchTask(task, messageId, req.body?.goal?.trim() || undefined);
      if (result.messageCount === 0) {
        return reply.code(404).send({ error: 'message not found in task history' });
      }
      taskEvents.publish({ type: 'task_created', taskId: result.task.id, task: result.task });
      const body: BranchTaskResponse = {
        task: result.task,
        streamUrl: `/api/tasks/${result.task.id}/stream`,
      };
      return reply.code(201).send(body);
    },
  );

  // 压缩：将指定消息范围压缩为 LLM 摘要，释放上下文空间
  app.post<{ Params: { id: string }; Body: CompactTaskRequest }>(
    '/api/tasks/:id/compact',
    async (req, reply) => {
      const task = taskStore.get(req.params.id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      if (isTaskRunning(req.params.id)) {
        return reply.code(409).send({ error: '任务正在运行，请等待当前轮结束后再压缩' });
      }

      const result = await compactTask(
        task,
        req.body?.fromMessageId?.trim() || undefined,
        req.body?.toMessageId?.trim() || undefined,
        req.body?.instructions?.trim() || undefined,
      );
      if (result.originalCount === 0) {
        return reply.code(400).send({ error: '指定的消息范围无效' });
      }
      const body: CompactTaskResponse = {
        task: result.task,
        originalCount: result.originalCount,
        summaryLength: result.summaryLength,
      };
      return reply.code(200).send(body);
    },
  );

  // 会话内即时切换模型 / 推理档（P1-2 模型粘性）；运行中同步到 harness，空闲则下一次 run 生效。
  app.patch<{ Params: { id: string }; Body: UpdateTaskModelRequest }>(
    '/api/tasks/:id/model',
    async (req, reply) => {
      const task = taskStore.get(req.params.id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      const thinkingLevel = req.body?.thinkingLevel;
      const allowedLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
      if (thinkingLevel !== undefined && !allowedLevels.includes(thinkingLevel)) {
        return reply.code(400).send({ error: `thinkingLevel 必须是 ${allowedLevels.join('/')}` });
      }
      const result = await updateTaskModel(task, {
        provider: req.body?.provider?.trim() || undefined,
        model: req.body?.model?.trim() || undefined,
        thinkingLevel: thinkingLevel as AgentThinkingLevel | undefined,
      });
      const body: UpdateTaskModelResponse = { task: result.task, modelSnapshot: result.modelSnapshot };
      return reply.code(200).send(body);
    },
  );

  // 取消一个进行中的任务
  app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (req, reply) => {
    const task = taskStore.get(req.params.id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    const cancelled = cancelTask(req.params.id);
    // 任务可能已结束（无活跃句柄）；此时返回当前状态即可
    return reply.send({ taskId: req.params.id, cancelling: cancelled, status: task.status });
  });

  // 删除任务及其关联数据
  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    const task = taskStore.get(req.params.id);
    if (!task) return reply.code(404).send({ error: 'task not found' });

    // 先取消进行中的任务，避免并发写入
    cancelTask(req.params.id);

    const result = taskStore.delete(req.params.id);

    // 通知 SSE 订阅者该任务已删除
    taskEvents.publish({ type: 'task_deleted', taskId: req.params.id });

    const body: DeleteTaskResponse = {
      taskId: req.params.id,
      deleted: result.deleted,
    };
    return reply.send(body);
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

  app.post<{ Params: { id: string; clarificationId: string }; Body: ClarificationAnswerRequest }>(
    '/api/tasks/:id/clarifications/:clarificationId',
    async (req, reply) => {
      const task = taskStore.get(req.params.id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      const { answer } = req.body ?? {};
      if (typeof answer !== 'string') {
        return reply.code(400).send({ error: 'answer(string) 必填' });
      }
      const delivered = resolveClarificationAnswer(req.params.id, req.params.clarificationId, answer);
      const body: ClarificationAnswerResponse = {
        taskId: req.params.id,
        clarificationId: req.params.clarificationId,
        delivered,
      };
      return reply.send(body);
    },
  );

  app.get<{ Params: { id: string; artifactId: string } }>(
    '/api/tasks/:id/artifacts/:artifactId/content',
    async (req, reply) => {
      const task = taskStore.get(req.params.id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      const artifact = task.artifacts?.find((item) => item.id === req.params.artifactId);
      if (!artifact) return reply.code(404).send({ error: 'artifact not found' });
      const body: TaskArtifactContentResponse = {
        taskId: req.params.id,
        artifactId: req.params.artifactId,
        content: artifact.content,
        mimeType: artifact.mimeType,
      };
      return reply.send(body);
    },
  );

  app.patch<{ Params: { id: string; artifactId: string }; Body: UpdateTaskArtifactRequest }>(
    '/api/tasks/:id/artifacts/:artifactId',
    async (req, reply) => {
      const task = taskStore.get(req.params.id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      const status = req.body?.status;
      if (status !== 'confirmed' && status !== 'rejected') {
        return reply.code(400).send({ error: 'status 只能是 confirmed 或 rejected' });
      }
      const artifacts = task.artifacts ?? [];
      const index = artifacts.findIndex((item) => item.id === req.params.artifactId);
      if (index < 0) return reply.code(404).send({ error: 'artifact not found' });
      const artifact = { ...artifacts[index], status, updatedAt: new Date().toISOString() };
      artifacts[index] = artifact;
      task.artifacts = artifacts;
      task.updatedAt = new Date().toISOString();
      taskStore.save(task);
      taskEvents.publish({ type: 'artifact_updated', taskId: task.id, artifact });
      return reply.send(artifact);
    },
  );

  }
