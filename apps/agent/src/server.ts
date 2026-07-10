import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import Fastify from 'fastify';
import pino, { type Logger } from 'pino';
import cors from '@fastify/cors';
import type {
  AgentEvent,
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
  BranchTaskRequest,
  BranchTaskResponse,
  CleanupDataRequest,
  CleanupDataResponse,
  ClarificationAnswerRequest,
  ClarificationAnswerResponse,
  CompactTaskRequest,
  CompactTaskResponse,
  ContinueBudgetRequest,
  ContinueBudgetResponse,
  ContinueTaskRequest,
  ContinueTaskResponse,
  CreateMemoryRequest,
  CreateProjectRequest,
  CreateTaskRequest,
  CreateTaskResponse,
  DataStatusResponse,
  DeleteTaskResponse,
  HealthResponse,
  MemoryCategory,
  MemoryEntry,
  MemoryListResponse,
  ModelListResponse,
  OauthLoginRespondRequest,
  OauthLoginStartRequest,
  OauthLogoutRequest,
  OauthSessionSnapshot,
  PlanApprovalRequest,
  PlanApprovalResponse,
  ProjectListResponse,
  ResumeTaskResponse,
  RevertTaskRequest,
  RevertTaskResponse,
  SkillDescriptor,
  SkillInstallRequest,
  SkillInstallResponse,
  SkillListResponse,
  SkillUninstallResponse,
  UnrevertTaskResponse,
  TaskArtifactContentResponse,
  TaskTraceListResponse,
  TokenUsageReport,
  UpdateProjectRequest,
  UpdateTaskArtifactRequest,
  UpdateRuntimeSettingsRequest,
  UpdateToolRequest,
  UpdateMemoryRequest,
  WorkspaceReadResponse,
} from '@aurevoy/shared';
import { config } from './config.js';
import {
  addUserTurn,
  branchTask,
  cancelTask,
  compactTask,
  createTask,
  isTaskRunning,
  markInterruptedTasksAfterRestart,
  prepareTaskForBudgetContinue,
  prepareTaskForResume,
  queueRunningUserTurn,
  resolveApproval,
  resolveClarificationAnswer,
  resolvePlanApprovalDecision,
  resumeAutoMode,
  revertTask,
  runHarnessTask,
  resolveTaskWorkspace,
  unrevertTask,
} from './agent/harness-controller.js';
import { taskEvents } from './agent/events.js';
import { buildTokenUsageReport } from './agent/token-usage.js';
import { taskStore, traceStore, memoryStore, toolSettingsStore, skillSettingsStore, projectStore, invalidateMemorySummary } from './store/db.js';
import { unifiedToolRegistry } from './tool/unified-registry.js';
import { createToolContext, initializeUnifiedToolFramework } from './tool/index.js';
import { skillRegistry } from './skills/registry.js';
import { installFromGit, uninstallSkill } from './skills/installer.js';
import { reloadSkillsAndTools } from './skills/reload.js';
import { getPiProviderName, listPiProviderModels } from './llm/pi-provider.js';
import {
  cancelOauthSession,
  getOauthSession,
  logoutOauthProvider,
  respondOauthSession,
  startOauthLogin,
} from './llm/oauth-login.js';
import { getMcpStatuses, reloadMcpTools } from './tool/mcp-integration.js';
import {
  readCleanupPolicyDays,
  readRuntimeSettings,
  updateRuntimeSettings,
} from './runtime/settings.js';

const startedAt = Date.now();

export async function buildServer(externalLogger?: Logger) {
  const log = externalLogger ?? pino({ level: 'info' }, pino.destination(1));
  const app = Fastify({ loggerInstance: log });

  app.addHook('onRequest', async (req) => {
    (req.raw as unknown as Record<string, unknown>).requestId = randomUUID();
  });

  // 应用工具设置
  const toolSettings = toolSettingsStore.list();
  for (const [name, enabled] of toolSettings) {
    unifiedToolRegistry.setEnabled(name, enabled);
  }
  unifiedToolRegistry.setEnabled('execute_command', config.sandbox.commandExecutionEnabled);
  const recoveredTasks = markInterruptedTasksAfterRestart();
  if (recoveredTasks.length > 0) {
    log.warn(`启动恢复：${recoveredTasks.length} 个未完成任务已标记为可恢复失败`);
  }

  await app.register(cors, { origin: config.corsOrigins });

  // 健康检查
  app.get('/api/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      version: '0.6.2',
      uptimeMs: Date.now() - startedAt,
      provider: getPiProviderName(),
      contextCharBudget: config.agent.contextCharBudget,
      contextTokenBudget: config.agent.contextTokenBudget,
    };
  });

  app.get<{
    Querystring: {
      path?: string;
      taskId?: string;
      projectId?: string;
      offset?: string;
      limit?: string;
      /** full=1：工作台预览全量读取（更高字节上限，不走 agent 工具分页） */
      full?: string;
    };
  }>('/api/workspace/read', async (req, reply) => {
    const workspace = await resolveWorkspaceForRead(req.query.taskId, req.query.projectId);
    if (!workspace.ok) return reply.code(workspace.status).send({ error: workspace.error });

    const path = req.query.path?.trim() || '.';
    const wantFull = req.query.full === '1' || req.query.full === 'true';

    // 工作台预览：直接读盘，避免 read 工具的 50KB / 2000 行分页截断 HTML·MD 报告
    // 不改写调用方路径身份，避免文件树/标签定位错乱
    if (wantFull) {
      try {
        return await readWorkspaceFileForWorkbench(workspace.workspaceDir, path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: message });
      }
    }

    initializeUnifiedToolFramework();
    const readTool = unifiedToolRegistry.get('read');
    if (!readTool) return reply.code(503).send({ error: 'read tool is unavailable' });

    const offset = parsePositiveInteger(req.query.offset);
    const limit = parsePositiveInteger(req.query.limit);
    try {
      // 与历史行为一致：原样把 path 交给 read 工具，不做绝对路径改写
      const output = await readTool.execute(
        {
          path,
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {}),
        },
        createToolContext('workspace-read', workspace.workspaceDir, { callId: `workspace-read-${Date.now()}` }),
      );
      return await normalizeWorkspaceReadOutput(output, workspace.workspaceDir, path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.delete<{
    Querystring: { path?: string; taskId?: string; projectId?: string };
  }>('/api/workspace/delete', async (req, reply) => {
    const workspace = await resolveWorkspaceForRead(req.query.taskId, req.query.projectId);
    if (!workspace.ok) return reply.code(workspace.status).send({ error: workspace.error });
    const relativePath = req.query.path?.trim();
    if (!relativePath) return reply.code(400).send({ error: 'path is required' });
    const target = resolve(workspace.workspaceDir, relativePath);
    try {
      const stat = await fs.stat(target);
      if (stat.isDirectory()) await fs.rm(target, { recursive: true });
      else await fs.unlink(target);
      return reply.code(204).send();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.post<{
    Body: { path?: string; newName?: string; taskId?: string; projectId?: string };
  }>('/api/workspace/rename', async (req, reply) => {
    const body = req.body ?? {};
    const workspace = await resolveWorkspaceForRead(body.taskId, body.projectId);
    if (!workspace.ok) return reply.code(workspace.status).send({ error: workspace.error });
    const relativePath = body.path?.trim();
    const newName = body.newName?.trim();
    if (!relativePath || !newName) return reply.code(400).send({ error: 'path and newName are required' });
    const oldPath = resolve(workspace.workspaceDir, relativePath);
    const dir = dirname(oldPath);
    const newPath = resolve(dir, newName);
    try {
      await fs.rename(oldPath, newPath);
      return reply.code(204).send();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.post<{
    Body: { path?: string; newName?: string; taskId?: string; projectId?: string };
  }>('/api/workspace/copy', async (req, reply) => {
    const body = req.body ?? {};
    const workspace = await resolveWorkspaceForRead(body.taskId, body.projectId);
    if (!workspace.ok) return reply.code(workspace.status).send({ error: workspace.error });
    const relativePath = body.path?.trim();
    const newName = body.newName?.trim();
    if (!relativePath || !newName) return reply.code(400).send({ error: 'path and newName are required' });
    const srcPath = resolve(workspace.workspaceDir, relativePath);
    const dir = dirname(srcPath);
    const destPath = resolve(dir, newName);
    try {
      await fs.copyFile(srcPath, destPath);
      return reply.code(204).send();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  // 已注册工具列表（调试/前端展示用）
  app.get('/api/tools', async () => unifiedToolRegistry.listDescriptors());

  app.get('/api/skills', async (): Promise<SkillListResponse> => {
    return { skills: skillRegistry.listAll() };
  });

  app.post('/api/skills/reload', async (): Promise<SkillListResponse> => {
    const skills = reloadSkillsAndTools();
    return { skills };
  });

  app.post<{ Body: SkillInstallRequest }>('/api/skills/install', async (req, reply) => {
    const repoUrl = typeof req.body?.repoUrl === 'string' ? req.body.repoUrl.trim() : '';
    if (!repoUrl) {
      return reply.code(400).send({ error: 'repoUrl 不能为空' });
    }

    try {
      const targetDir = resolve(config.skills.userDir);
      const result = await installFromGit(repoUrl, targetDir);
      reloadSkillsAndTools();

      const response: SkillInstallResponse = {
        installedSkills: result.installedSkills,
        repoUrl,
        alreadyExisted: result.alreadyExisted,
        totalFound: result.totalFound,
      };
      return reply.code(201).send(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.delete<{ Params: { name: string } }>('/api/skills/:name', async (req, reply) => {
    const name = req.params.name;
    const entry = skillRegistry.get(name);
    if (!entry) {
      return reply.code(404).send({ error: 'skill 不存在' });
    }
    if (entry.sourceDir !== 'user' && entry.sourceDir !== 'system') {
      return reply.code(403).send({ error: '仅用户或系统级 skill 可以卸载' });
    }

    try {
      // 使用 skill 的 actual skillDir 所在父目录作为卸载目标
      const parentDir = resolve(entry.skillDir, '..');
      await uninstallSkill(name, parentDir);
      reloadSkillsAndTools();
      publishSkillDeactivated(name);

      const response: SkillUninstallResponse = { name, deleted: true };
      return reply.send(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.patch<{ Params: { name: string }; Body: { enabled: boolean } }>(
    '/api/skills/:name',
    async (req, reply) => {
      const name = req.params.name;
      const enabled = req.body?.enabled;
      if (typeof enabled !== 'boolean') {
        return reply.code(400).send({ error: 'enabled(boolean) 必填' });
      }
      const entry = skillRegistry.get(name);
      if (!entry) return reply.code(404).send({ error: 'skill not found' });
      skillSettingsStore.setEnabled(name, enabled);
      // 刷新 load_skill / install_skill 工具注册以同步 catalog
      reloadSkillsAndTools();
      if (!enabled) publishSkillDeactivated(name);
      const updated = skillRegistry.listAll().find((s) => s.name === name);
      return reply.send(updated as SkillDescriptor);
    },
  );

  app.patch<{ Params: { name: string }; Body: UpdateToolRequest }>(
    '/api/tools/:name',
    async (req, reply) => {
      const enabled = req.body?.enabled;
      if (typeof enabled !== 'boolean') {
        return reply.code(400).send({ error: 'enabled(boolean) 必填' });
      }
      const updated = unifiedToolRegistry.setEnabled(req.params.name, enabled);
      if (!updated) return reply.code(404).send({ error: 'tool not found' });
      toolSettingsStore.setEnabled(req.params.name, enabled);
      const tool = unifiedToolRegistry.listDescriptors().find((item) => item.name === req.params.name);
      return reply.send(tool);
    },
  );

  app.get('/api/mcp/status', async () => {
    return { servers: getMcpStatuses() };
  });

  app.get('/api/settings', async () => readRuntimeSettings());

  app.get('/api/settings/models', async (_req, reply): Promise<ModelListResponse | unknown> => {
    try {
      return { models: await listPiProviderModels() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.patch<{ Body: UpdateRuntimeSettingsRequest }>('/api/settings', async (req, reply) => {
    try {
      const result = updateRuntimeSettings(req.body ?? {});
      unifiedToolRegistry.setEnabled('execute_command', result.settings.commandExecutionEnabled);
      if (result.mcpChanged) {
        await reloadMcpTools();
        // 应用工具设置
        const toolSettings = toolSettingsStore.list();
        for (const [name, enabled] of toolSettings) {
          unifiedToolRegistry.setEnabled(name, enabled);
        }
        unifiedToolRegistry.setEnabled('execute_command', result.settings.commandExecutionEnabled);
      }
      return reply.send(result.settings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  // ---- LLM OAuth（订阅登录）----

  app.post<{ Body: OauthLoginStartRequest }>(
    '/api/settings/llm/oauth/login',
    async (req, reply): Promise<OauthSessionSnapshot | unknown> => {
      try {
        const provider = String(req.body?.provider ?? '').trim();
        if (!provider) return reply.code(400).send({ error: 'provider is required' });
        return startOauthLogin(provider);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: message });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/settings/llm/oauth/session/:id',
    async (req, reply): Promise<OauthSessionSnapshot | unknown> => {
      const session = getOauthSession(req.params.id);
      if (!session) return reply.code(404).send({ error: 'OAuth session not found' });
      return session;
    },
  );

  app.post<{ Params: { id: string }; Body: OauthLoginRespondRequest }>(
    '/api/settings/llm/oauth/session/:id/respond',
    async (req, reply): Promise<OauthSessionSnapshot | unknown> => {
      try {
        return respondOauthSession(req.params.id, String(req.body?.value ?? ''));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: message });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/settings/llm/oauth/session/:id/cancel',
    async (req, reply): Promise<OauthSessionSnapshot | unknown> => {
      try {
        return cancelOauthSession(req.params.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: message });
      }
    },
  );

  app.post<{ Body: OauthLogoutRequest }>(
    '/api/settings/llm/oauth/logout',
    async (req, reply) => {
      try {
        const provider = String(req.body?.provider ?? '').trim();
        if (!provider) return reply.code(400).send({ error: 'provider is required' });
        await logoutOauthProvider(provider);
        return readRuntimeSettings();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: message });
      }
    },
  );

  app.get('/api/data', async (): Promise<DataStatusResponse> => {
    return {
      dbPath: config.dbPath,
      workspaceDir: config.workspaceDir,
      cleanupPolicyDays: readCleanupPolicyDays(),
      counts: {
        tasks: taskStore.count(),
        traces: traceStore.count(),
        memories: memoryStore.count(),
        projects: projectStore.count(),
      },
    };
  });

  app.get('/api/data/token-usage', async (): Promise<TokenUsageReport> => {
    return buildTokenUsageReport(taskStore.list());
  });

  app.post<{ Body: CleanupDataRequest }>('/api/data/cleanup', async (req): Promise<CleanupDataResponse> => {
    const olderThanDays = req.body?.olderThanDays ?? readCleanupPolicyDays();
    return taskStore.cleanupTerminal(olderThanDays);
  });

  // 任务列表（支持按项目过滤）
  app.get<{ Querystring: { projectId?: string } }>('/api/tasks', async (req) => {
    const projectId = req.query?.projectId;
    if (projectId === 'standalone') return taskStore.listByProject(null);
    if (projectId) return taskStore.listByProject(projectId);
    return taskStore.list();
  });

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

    const projectId = req.body?.projectId;
    if (projectId) {
      const project = projectStore.get(projectId);
      if (!project) return reply.code(404).send({ error: 'project not found' });
    }

    const task = createTask(
      goal,
      req.body?.budget,
      projectId,
      req.body?.attachments,
      req.body?.lifetimeBudget,
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
    async (req, reply) => {
      const task = taskStore.get(req.params.id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      const message = req.body?.message?.trim();
      if (!message) return reply.code(400).send({ error: 'message is required' });
      if (isTaskRunning(req.params.id)) {
        const delivery = req.body?.delivery === 'follow_up' ? 'follow_up' : 'steering';
        const queued = queueRunningUserTurn(task, message, delivery, req.body?.attachments);
        if (!queued.delivered) {
          return reply.code(409).send({ error: '任务正在运行，但 Pi harness 队列不可用，请等待当前轮结束后再追问' });
        }
        const body: ContinueTaskResponse = {
          task,
          streamUrl: `/api/tasks/${task.id}/stream`,
        };
        return reply.code(202).send(body);
      }

      addUserTurn(task, message, req.body?.attachments);
      // 异步带完整历史重跑循环；前端通过同一 SSE 地址订阅这一轮
      void runHarnessTask(task);

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

  // 审批 /plan 触发的执行计划。Pi harness 只在批准后进入模型调用。
  app.post<{ Params: { id: string }; Body: PlanApprovalRequest }>(
    '/api/tasks/:id/plan-approval',
    async (req, reply) => {
      const task = taskStore.get(req.params.id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      const { approved } = req.body ?? {};
      if (typeof approved !== 'boolean') {
        return reply.code(400).send({ error: 'approved(boolean) 必填' });
      }
      const delivered = resolvePlanApprovalDecision(req.params.id, approved);
      const body: PlanApprovalResponse = { taskId: req.params.id, delivered };
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
      const artifact = { ...artifacts[index], status };
      artifacts[index] = artifact;
      task.artifacts = artifacts;
      task.updatedAt = new Date().toISOString();
      taskStore.save(task);
      taskEvents.publish({ type: 'artifact_updated', taskId: task.id, artifact });
      return reply.send(artifact);
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
    invalidateMemorySummary();
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
      invalidateMemorySummary();
      return reply.send(updated);
    },
  );

  // 删除一条记忆
  app.delete<{ Params: { id: string } }>('/api/memories/:id', async (req, reply) => {
    const deleted = memoryStore.delete(req.params.id);
    if (!deleted) return reply.code(404).send({ error: 'memory not found' });
    invalidateMemorySummary();
    return reply.send({ id: req.params.id, deleted: true });
  });

  // ===== M8: 知识库 API =====
  const { listKbDirs, addKbDir, deleteKbDir, getKbIndexStatus } = await import("./knowledge-base/index.js");

  app.get("/api/knowledge-base/dirs", async () => {
    return { dirs: listKbDirs() };
  });

  app.post<{ Body: { dirPath: string; recursive?: boolean } }>("/api/knowledge-base/dirs", async (req, reply) => {
    const { dirPath, recursive } = req.body ?? {};
    if (!dirPath?.trim()) return reply.code(400).send({ error: "dirPath 不能为空" });
    try {
      return reply.code(201).send(addKbDir(dirPath.trim(), recursive !== false));
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : "添加目录失败" });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/knowledge-base/dirs/:id", async (req, reply) => {
    const deleted = deleteKbDir(req.params.id);
    if (!deleted) return reply.code(404).send({ error: "kb dir not found" });
    return reply.send({ id: req.params.id, deleted: true });
  });

  app.get("/api/knowledge-base/status", async () => {
    return getKbIndexStatus();
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

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribe = () => {};
    let replayingSnapshot = true;
    let streamClosed = false;
    const bufferedLiveEvents: AgentEvent[] = [];
    const snapshotMessageIds = new Set<string>();

    // ---- SSE 批量写入（cork + coalescing） ----
    let sseBuf: string[] = [];
    let sseTimer: ReturnType<typeof setImmediate> | null = null;

    const sseFlush = () => {
      sseTimer = null;
      if (sseBuf.length === 0) return;
      const batch = sseBuf;
      sseBuf = [];
      reply.raw.cork();
      for (const line of batch) reply.raw.write(line);
      reply.raw.uncork();
    };

    /** 需要立即刷入的事件类型 */
    const DRAIN_EVENTS = new Set([
      'done', 'task_deleted', 'error', 'status',
      'agent_start', 'message_start',
      'plan_approval_request', 'plan_approval_resolved',
      'context_snapshot',
      'clarification_request', 'clarification_resolved',
      'approval_request',
      'tool_call', 'tool_result', 'message',
      'subagent_updated',
    ]);

    const send = (event: AgentEvent) => {
      if (streamClosed) return;
      const line = `data: ${JSON.stringify(event)}\n\n`;

      if (event.type === 'done' || event.type === 'task_deleted') {
        streamClosed = true;
        if (sseBuf.length > 0) sseFlush();
        reply.raw.write(line);
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
        taskEvents.cleanup(id);
        reply.raw.end();
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

    const sendSnapshot = (event: AgentEvent) => {
      if (event.type === 'message') snapshotMessageIds.add(event.message.id);
      send(event);
    };

    const sendLive = (event: AgentEvent) => {
      if (replayingSnapshot) {
        bufferedLiveEvents.push(event);
        return;
      }
      send(event);
    };

    // 先订阅实时事件，再补发任务持久状态快照。
    // 这样快照期间发生的新 message/tool_result 不会落入“快照之后、订阅之前”的空窗。
    // 快照发送期间的实时事件先缓冲，等快照完整发完后再按原顺序补发。
    unsubscribe = taskEvents.subscribe(id, sendLive);

    sendSnapshot({ type: 'task_created', taskId: task.id, task });
    sendSnapshot({ type: 'status', taskId: task.id, status: task.status });
    if (task.phase) {
      sendSnapshot({ type: 'phase', taskId: task.id, phase: task.phase });
    }
    if (task.plan.length > 0) {
      sendSnapshot({ type: 'plan', taskId: task.id, plan: task.plan });
    }
    if (task.budgetUsage || task.lifetimeUsage || task.budget || task.lifetimeBudget) {
      sendSnapshot({
        type: 'budget_usage',
        taskId: task.id,
        usage: task.budgetUsage ?? { iterations: 0, toolCalls: 0, wallTimeMs: 0, outputBytes: 0 },
        budget: task.budget,
        lifetimeUsage: task.lifetimeUsage,
        lifetimeBudget: task.lifetimeBudget,
      });
    }
    if (task.budgetExceeded) {
      sendSnapshot({ type: 'budget_exceeded', taskId: task.id, info: task.budgetExceeded });
    }
    if (task.tokenUsage) {
      sendSnapshot({ type: 'token_usage', taskId: task.id, usage: task.tokenUsage });
    }
    if (task.contextTokens !== undefined) {
      sendSnapshot({ type: 'context_snapshot', taskId: task.id, tokens: task.contextTokens });
    }
    for (const message of task.messages) {
      sendSnapshot({ type: 'message', taskId: task.id, message });
    }
    for (const artifact of task.artifacts ?? []) {
      sendSnapshot({ type: 'artifact_updated', taskId: task.id, artifact });
    }
    for (const checkpoint of task.checkpoints ?? []) {
      sendSnapshot({ type: 'checkpoint_created', taskId: task.id, checkpoint });
    }
    for (const clarification of task.clarifications ?? []) {
      sendSnapshot(
        clarification.status === 'pending'
          ? { type: 'clarification_request', taskId: task.id, clarification }
          : { type: 'clarification_resolved', taskId: task.id, clarification },
      );
    }
    for (const approval of task.pendingApprovals ?? []) {
      sendSnapshot({ type: 'approval_request', taskId: task.id, call: approval.call, riskLevel: approval.riskLevel });
    }
    // 终态，或预算触顶暂停（本 run 已结束，前端应解除 busy）
    if (
      ['completed', 'failed', 'cancelled'].includes(task.status) ||
      (task.status === 'paused' && task.phase === 'waiting_budget')
    ) {
      replayingSnapshot = false;
      sendSnapshot({ type: 'done', taskId: task.id, status: task.status });
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
      reply.raw.cork();
      reply.raw.write(': ping\n\n');
      reply.raw.uncork();
    }, 15000);

    req.raw.on('close', () => {
      if (heartbeat) clearInterval(heartbeat);
      if (sseTimer) clearImmediate(sseTimer);
      sseBuf = [];
      unsubscribe();
    });
  });

  // ---- 项目 CRUD ----

  // 列出所有项目
  app.get('/api/projects', async (): Promise<ProjectListResponse> => {
    return { projects: projectStore.list() };
  });

  // 导入文件夹创建项目
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

  // 重命名项目
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

  // 删除项目（关联对话变为独立对话）
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const result = projectStore.delete(req.params.id);
    if (!result.deleted) return reply.code(404).send({ error: 'project not found' });
    return reply.send(result);
  });

  return app;
}

type WorkspaceResolution =
  | { ok: true; workspaceDir: string }
  | { ok: false; status: 400 | 404; error: string };

async function resolveWorkspaceForRead(taskId?: string, projectId?: string): Promise<WorkspaceResolution> {
  const normalizedTaskId = taskId?.trim();
  if (normalizedTaskId) {
    const task = taskStore.get(normalizedTaskId);
    if (!task) return { ok: false, status: 404, error: 'task not found' };
    return { ok: true, workspaceDir: await resolveTaskWorkspace(task) };
  }

  const normalizedProjectId = projectId?.trim();
  if (normalizedProjectId) {
    const project = projectStore.get(normalizedProjectId);
    if (!project) return { ok: false, status: 404, error: 'project not found' };
    return { ok: true, workspaceDir: resolve(project.path) };
  }

  return { ok: true, workspaceDir: resolve(config.workspaceDir) };
}

function parsePositiveInteger(raw?: string): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** 工作台预览允许的文本体积（HTML 报告等）；与 agent read 工具的 50KB 分页上限分离 */
const WORKBENCH_FULL_TEXT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 工作台全量读：在工作区边界内直接读盘。
 * 返回的 path 保持调用方原样（不强制改写成相对路径），避免前端 tab/树定位错乱。
 */
async function readWorkspaceFileForWorkbench(
  workspaceDir: string,
  requestedPath: string,
): Promise<WorkspaceReadResponse> {
  const root = resolve(workspaceDir);
  const raw = requestedPath.trim();
  if (!raw) throw new Error('path required');

  const abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  const relPosix = relative(root, abs).replace(/\\/g, '/');
  if (!relPosix || relPosix === '..' || relPosix.startsWith('../') || isAbsolute(relPosix)) {
    throw new Error(`路径越界：${requestedPath}`);
  }

  const st = await fs.stat(abs);
  if (st.isDirectory()) {
    throw new Error('目录请在文件树中浏览');
  }

  const name = basename(abs);
  const mimeType = inferMimeType(name);
  // 保持调用方 path，不改写
  const displayPath = requestedPath;

  // 图片：与 read 工具一致，走 base64（上限 20MB 由 stat 粗拦）
  if ((mimeType ?? '').startsWith('image/')) {
    if (st.size > 20 * 1024 * 1024) {
      throw new Error('图片过大，无法在工作台预览');
    }
    const buf = await fs.readFile(abs);
    return {
      root: workspaceDir,
      path: displayPath,
      type: 'image',
      content: buf.toString('base64'),
      mimeType: mimeType || 'application/octet-stream',
    };
  }

  if (st.size > WORKBENCH_FULL_TEXT_MAX_BYTES) {
    throw new Error(`文件过大（>${WORKBENCH_FULL_TEXT_MAX_BYTES} 字节），无法全量预览`);
  }

  const content = await fs.readFile(abs, 'utf8');
  return {
    root: workspaceDir,
    path: displayPath,
    type: 'text',
    content,
    truncated: false,
  };
}

async function normalizeWorkspaceReadOutput(output: unknown, workspaceDir: string, requestedPath: string): Promise<WorkspaceReadResponse> {
  if (!isRecord(output) || typeof output.type !== 'string') {
    throw new Error('read tool returned an unsupported response');
  }

  const path = normalizeWorkspacePath(requestedPath);
  if (output.type === 'directory') {
    const rawEntries = Array.isArray(output.entries) ? output.entries : [];
    const entries = rawEntries
      .filter((entry): entry is { path: string; type: 'file' | 'directory' } =>
        isRecord(entry) &&
        typeof entry.path === 'string' &&
        (entry.type === 'file' || entry.type === 'directory'),
      );
    const enriched = await Promise.all(entries.map(async (entry) => {
      const name = entry.path.replace(/\/+$/g, '').split('/').pop() || entry.path;
      const entryPath = normalizeWorkspacePath(path === '.' ? entry.path : join(path, entry.path));
      const absPath = resolve(workspaceDir, entryPath);
      let size: number | undefined;
      let mimeType: string | undefined;
      try {
        const st = await fs.stat(absPath);
        if (entry.type === 'file') {
          size = st.size;
          mimeType = inferMimeType(name);
        }
      } catch { /* best-effort */ }
      return { name, path: entryPath, type: entry.type, ...(size !== undefined ? { size } : {}), ...(mimeType ? { mimeType } : {}) };
    }));
    return {
      root: workspaceDir,
      path,
      type: 'directory',
      entries: enriched,
      truncated: output.truncated === true,
      ...(typeof output.next === 'number' ? { next: output.next } : {}),
    };
  }

  if (output.type === 'full-text') {
    return {
      root: workspaceDir,
      path,
      type: 'text',
      content: typeof output.content === 'string' ? output.content : '',
      truncated: false,
    };
  }

  if (output.type === 'text-page') {
    return {
      root: workspaceDir,
      path,
      type: 'text',
      content: typeof output.content === 'string' ? output.content : '',
      offset: typeof output.offset === 'number' ? output.offset : undefined,
      truncated: output.truncated === true,
      ...(typeof output.next === 'number' ? { next: output.next } : {}),
    };
  }

  if (output.type === 'image') {
    return {
      root: workspaceDir,
      path,
      type: 'image',
      content: typeof output.content === 'string' ? output.content : '',
      mimeType: typeof output.mime === 'string' ? output.mime : 'application/octet-stream',
    };
  }

  throw new Error(`unsupported read result type: ${output.type}`);
}

function normalizeWorkspacePath(input: string): string {
  const normalized = input.replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!normalized || normalized === '.') return '.';
  return normalized.replace(/^\.\//, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MIME_MAP: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', json: 'application/json', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv',
  html: 'text/html', css: 'text/css', js: 'text/javascript', ts: 'text/typescript',
  tsx: 'text/typescript', jsx: 'text/javascript', py: 'text/x-python', go: 'text/x-go', rs: 'text/x-rust',
  yaml: 'text/yaml', yml: 'text/yaml', sh: 'text/x-shellscript',
};

function inferMimeType(name: string): string | undefined {
  const ext = name.split('.').pop()?.toLowerCase();
  if (!ext || ext === name) return undefined;
  return MIME_MAP[ext];
}

function publishSkillDeactivated(skillName: string): void {
  for (const task of taskStore.list()) {
    if (task.status !== 'running' && task.status !== 'paused') continue;
    taskEvents.publish({ type: 'skill_deactivated', taskId: task.id, previousSkill: skillName });
  }
}
