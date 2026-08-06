import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyTypeProvider,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
} from 'fastify';
import type {
  BrowserRuntimeStatus,
  BrowserRuntimeTestResponse,
  McpConnectionTestResponse,
  ModelListResponse,
  OauthLoginRespondRequest,
  OauthLoginStartRequest,
  OauthLogoutRequest,
  OauthSessionSnapshot,
  UpdateRuntimeSettingsRequest,
  UpdateToolRequest,
} from '@aurevoy/shared';
import { config, parseMcpServers } from '../config.js';
import {
  cancelOauthSession,
  getOauthSession,
  logoutOauthProvider,
  respondOauthSession,
  startOauthLogin,
} from '../llm/oauth-login.js';
import { listPiProviderModels } from '../llm/pi-provider.js';
import { readRuntimeSettings, updateRuntimeSettings } from '../runtime/settings.js';
import { buildBrowserRuntimeStatus, findBrowserServer } from '../runtime/browser-runtime.js';
import { getMcpStatuses, reloadMcpTools, testMcpServer } from '../tool/mcp-integration.js';
import { unifiedToolRegistry } from '../tool/unified-registry.js';
import { skillRegistry } from '../skills/registry.js';
import { toolSettingsStore } from '../store/db.js';

/** 工具、MCP、浏览器和设置路由共享设置域，但不再由 server.ts 维护细节。 */
export function registerSettingsRoutes<
  RawServer extends RawServerBase,
  RawRequest extends RawRequestDefaultExpression<RawServer>,
  RawReply extends RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider,
>(
  app: FastifyInstance<RawServer, RawRequest, RawReply, Logger, TypeProvider>,
): void {
  app.get('/api/tools', async () => unifiedToolRegistry.listDescriptors());

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

  app.get('/api/mcp/status', async () => ({ servers: getMcpStatuses() }));

  app.get('/api/browser/status', async (): Promise<BrowserRuntimeStatus> => {
    const browserSkill = skillRegistry.listAll().find((skill) => skill.name === 'browser');
    return buildBrowserRuntimeStatus(browserSkill, getMcpStatuses());
  });

  app.post<{ Body: { serverName?: string } }>(
    '/api/browser/test',
    async (req, reply): Promise<BrowserRuntimeTestResponse | unknown> => {
      const server = findBrowserServer(config.mcpServers, req.body?.serverName);
      if (!server) return reply.code(404).send({ error: 'browser Playwright MCP server is not configured' });
      try {
        const result = await testMcpServer(server);
        const browserSkill = skillRegistry.listAll().find((skill) => skill.name === 'browser');
        const state = !browserSkill
          ? 'not_configured'
          : !browserSkill.enabled
            ? 'disabled'
            : result.ok
              ? 'ready'
              : 'unhealthy';
        return reply.send({ ...result, state, serverName: server.name });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  app.post<{ Body: { server?: unknown } }>(
    '/api/mcp/test',
    async (req, reply): Promise<McpConnectionTestResponse | unknown> => {
      if (!isRecord(req.body?.server)) return reply.code(400).send({ error: 'server config is required' });
      try {
        const parsed = parseMcpServers(JSON.stringify({ mcpServers: { probe: req.body.server } }))[0];
        if (!parsed) return reply.code(400).send({ error: 'invalid MCP server config' });
        return reply.send(await testMcpServer(parsed));
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

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
        for (const [name, enabled] of toolSettingsStore.list()) {
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

  /** 探测 agent 出站网络；具体代理实现按需加载，避免设置页启动时提前初始化网络模块。 */
  app.post<{ Body?: { probeUrl?: string } }>(
    '/api/settings/proxy/test',
    async (req, reply) => {
      try {
        const { testOutboundProxy } = await import('../runtime/outbound-proxy.js');
        return reply.send(await testOutboundProxy({ probeUrl: req.body?.probeUrl }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ ok: false, latencyMs: 0, error: message });
      }
    },
  );

  app.post<{ Body: OauthLoginStartRequest }>(
    '/api/settings/llm/oauth/login',
    async (req, reply): Promise<OauthSessionSnapshot | unknown> => {
      try {
        const provider = String(req.body?.provider ?? '').trim();
        if (!provider) return reply.code(400).send({ error: 'provider is required' });
        return startOauthLogin(provider);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
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
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/settings/llm/oauth/session/:id/cancel',
    async (req, reply): Promise<OauthSessionSnapshot | unknown> => {
      try {
        return cancelOauthSession(req.params.id);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
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
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
