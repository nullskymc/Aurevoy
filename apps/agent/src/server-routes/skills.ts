import { resolve } from 'node:path';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyTypeProvider,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
} from 'fastify';
import type {
  SkillDescriptor,
  SkillInstallRequest,
  SkillInstallResponse,
  SkillListResponse,
  SkillUninstallResponse,
} from '@aurevoy/shared';
import { config } from '../config.js';
import { taskEvents } from '../agent/events.js';
import { taskStore, skillSettingsStore } from '../store/db.js';
import { skillRegistry } from '../skills/registry.js';
import { installFromGit, uninstallSkill } from '../skills/installer.js';
import { reloadSkillsAndTools } from '../skills/reload.js';

/** Skill 路由只负责 HTTP 适配，安装/扫描/启停真相仍由 skills 模块维护。 */
export function registerSkillRoutes<
  RawServer extends RawServerBase,
  RawRequest extends RawRequestDefaultExpression<RawServer>,
  RawReply extends RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider,
>(app: FastifyInstance<RawServer, RawRequest, RawReply, Logger, TypeProvider>): void {
  app.get('/api/skills', async (): Promise<SkillListResponse> => ({
    skills: skillRegistry.listAll(),
  }));

  app.get<{ Params: { name: string } }>('/api/skills/:name', async (req, reply) => {
    const name = req.params.name;
    const entry = skillRegistry.get(name);
    if (!entry) return reply.code(404).send({ error: 'skill 不存在' });
    const content = skillRegistry.getContent(name);
    const summary = skillRegistry.listAll().find((skill) => skill.name === name);
    if (!summary) return reply.code(404).send({ error: 'skill 不存在' });
    return {
      ...summary,
      body: content?.body ?? '',
      resources: (content?.resources ?? []).map((resource) => ({
        type: resource.type,
        relativePath: resource.relativePath,
      })),
    };
  });

  app.post('/api/skills/reload', async (): Promise<SkillListResponse> => ({
    skills: reloadSkillsAndTools(),
  }));

  app.post<{ Body: SkillInstallRequest }>('/api/skills/install', async (req, reply) => {
    const repoUrl = typeof req.body?.repoUrl === 'string' ? req.body.repoUrl.trim() : '';
    if (!repoUrl) return reply.code(400).send({ error: 'repoUrl 不能为空' });

    // 安装前必须把用户实际检查过的路径和依据传进来，避免仅凭仓库 URL 扫描并加载未知 Skill。
    const skillPaths = Array.isArray(req.body?.skillPaths)
      ? req.body.skillPaths
        .filter((path): path is string => typeof path === 'string')
        .map((path) => path.trim())
        .filter(Boolean)
      : [];
    const inspectionSummary = typeof req.body?.inspectionSummary === 'string'
      ? req.body.inspectionSummary.trim()
      : '';
    const inspectedSource = typeof req.body?.inspectedSource === 'string'
      ? req.body.inspectedSource.trim()
      : undefined;
    if (skillPaths.length === 0 || inspectionSummary.length < 20) {
      return reply.code(400).send({
        error: '安装前请提供已检查的 skillPaths，并说明至少 20 个字符的检查依据',
      });
    }

    try {
      const result = await installFromGit(repoUrl, resolve(config.skills.userDir), {
        expectedSkillPaths: skillPaths,
        inspectedSource,
        inspectionSummary,
        requireExpectedPaths: true,
      });
      reloadSkillsAndTools();
      const response: SkillInstallResponse = {
        installedSkills: result.installedSkills,
        repoUrl,
        alreadyExisted: result.alreadyExisted,
        totalFound: result.totalFound,
        inspectedSkillPaths: result.inspectedSkillPaths,
        inspectedSource,
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
    if (!entry) return reply.code(404).send({ error: 'skill 不存在' });
    if (entry.sourceDir !== 'user' && entry.sourceDir !== 'system') {
      return reply.code(403).send({ error: '仅用户或系统级 skill 可以卸载' });
    }

    try {
      // 卸载使用条目真实目录的父目录，不根据用户输入拼接任意目标路径。
      await uninstallSkill(name, resolve(entry.skillDir, '..'));
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
      const enabled = req.body?.enabled;
      if (typeof enabled !== 'boolean') {
        return reply.code(400).send({ error: 'enabled(boolean) 必填' });
      }
      const entry = skillRegistry.get(req.params.name);
      if (!entry) return reply.code(404).send({ error: 'skill not found' });
      skillSettingsStore.setEnabled(req.params.name, enabled);
      reloadSkillsAndTools();
      if (!enabled) publishSkillDeactivated(req.params.name);
      const updated = skillRegistry.listAll().find((skill) => skill.name === req.params.name);
      return reply.send(updated as SkillDescriptor);
    },
  );
}

/** 禁用 Skill 后通知运行中的任务，避免继续使用已经撤销的上下文能力。 */
function publishSkillDeactivated(skillName: string): void {
  for (const task of taskStore.list()) {
    if (task.status !== 'running' && task.status !== 'paused') continue;
    taskEvents.publish({ type: 'skill_deactivated', taskId: task.id, previousSkill: skillName });
  }
}
