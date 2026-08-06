import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import pino, { type Logger } from 'pino';
import cors from '@fastify/cors';
import { config } from './config.js';
import {
  recoverInterruptedTasksOnBoot,
  runHarnessTask,
} from './agent/harness-controller.js';
import { taskEvents } from './agent/events.js';
import { toolSettingsStore } from './store/db.js';
import { unifiedToolRegistry } from './tool/unified-registry.js';
import { AutomationScheduler } from './automation/scheduler.js';
import { createApiToken, isAllowedApiOrigin, isValidApiAuthorization } from './security/api-auth.js';
import { registerAutomationRoutes } from './server-routes/automations.js';
import { registerProjectRoutes } from './server-routes/projects.js';
import { registerSkillRoutes } from './server-routes/skills.js';
import { registerHealthRoutes } from './server-routes/health.js';
import { registerSettingsRoutes } from './server-routes/settings.js';
import { registerWorkspaceRoutes } from './server-routes/workspace.js';
import { registerDataRoutes } from './server-routes/data.js';
import { registerTaskReadRoutes } from './server-routes/tasks-read.js';
import { registerTaskWriteRoutes } from './server-routes/tasks-write.js';
import { registerTaskStreamRoutes } from './server-routes/task-stream.js';
import { registerAuthRoutes } from './server-routes/auth.js';
import { registerMemoryRoutes } from './server-routes/memories.js';
import { registerKnowledgeBaseRoutes } from './server-routes/knowledge-base.js';

const startedAt = Date.now();
/** 每次 Agent 进程启动生成；只存在内存，不写入 SQLite、日志或诊断导出。 */
const apiToken = createApiToken();

export async function buildServer(
  externalLogger?: Logger,
  automationScheduler = new AutomationScheduler(),
) {
  const log = externalLogger ?? pino({ level: 'info' }, pino.destination(1));
  // 默认关闭 access log：/api/health 与 UI 轮询会占日志大半；需要时设 AUREVOY_LOG_HTTP=1
  const app = Fastify({
    loggerInstance: log,
    disableRequestLogging: !config.logging.http,
  });

  app.addHook('onRequest', async (req, reply) => {
    (req.raw as unknown as Record<string, unknown>).requestId = randomUUID();
    if (req.method === 'OPTIONS') return;
    const pathname = req.url.split('?', 1)[0];
    if (pathname === '/api/auth/bootstrap') {
      if (!isAllowedApiOrigin(req.headers.origin, config.corsOrigins)) {
        return reply.code(403).send({ error: 'Origin is not allowed to bootstrap an API session' });
      }
      return;
    }
    if (!pathname.startsWith('/api/')) return;
    const authorization = req.headers.authorization;
    if (!isValidApiAuthorization(authorization, apiToken)) {
      return reply.code(401).send({ error: 'Aurevoy API session token is required' });
    }
  });

  // 未开完整 HTTP 日志时，仍记录 4xx/5xx，避免静默吞客户端错误
  if (!config.logging.http) {
    app.addHook('onResponse', async (req, reply) => {
      if (reply.statusCode < 400) return;
      req.log.warn(
        {
          method: req.method,
          url: req.url,
          statusCode: reply.statusCode,
          responseTime: reply.elapsedTime,
        },
        'request failed',
      );
    });
  }

  // 应用工具设置
  const toolSettings = toolSettingsStore.list();
  for (const [name, enabled] of toolSettings) {
    unifiedToolRegistry.setEnabled(name, enabled);
  }
  unifiedToolRegistry.setEnabled('execute_command', config.sandbox.commandExecutionEnabled);
  const { resumed: autoResumedTasks, manual: manualRecoveryTasks } = recoverInterruptedTasksOnBoot();
  if (manualRecoveryTasks.length > 0) {
    log.warn(`启动恢复：${manualRecoveryTasks.length} 个任务嵌有等待审批/预算等过期状态，已保守标记为待手动恢复`);
  }
  if (autoResumedTasks.length > 0) {
    log.info(`启动恢复：自动续跑 ${autoResumedTasks.length} 个在途任务（对齐 pi -r）`);
    for (const task of autoResumedTasks) {
      taskEvents.publish({ type: 'task_resumed', taskId: task.id, automatic: true });
      void runHarnessTask(task);
    }
  }

  await app.register(cors, { origin: config.corsOrigins });

  registerAuthRoutes(app, apiToken);

  registerHealthRoutes(app, startedAt);

  registerWorkspaceRoutes(app);

  registerAutomationRoutes(app, automationScheduler);
  registerProjectRoutes(app);
  registerSkillRoutes(app);
  registerSettingsRoutes(app);
  registerDataRoutes(app);
  registerMemoryRoutes(app);
  registerKnowledgeBaseRoutes(app);

  registerTaskReadRoutes(app);

  registerTaskWriteRoutes(app);
  registerTaskStreamRoutes(app);

  return app;
}
