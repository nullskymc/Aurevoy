import './load-env.js';
import { buildServer } from './server.js';
import { config } from './config.js';
import './tools/builtins.js'; // 副作用导入：注册内置工具（文件/网络）
import { closeMcpTools, initializeMcpTools } from './tools/mcp.js';
import { loadPersistedSettings } from './runtime/settings.js';
import { createLogger, getLogger } from './logging/logger.js';

async function main() {
  const rootLogger = createLogger(config.logging);
  const log = getLogger('server');

  log.info({ provider: config.llm.provider, model: config.llm.model, host: config.host, port: config.port, db: config.dbPath }, '加载配置完成');

  loadPersistedSettings();
  log.info(
    {
      provider: config.llm.provider,
      model: config.llm.model,
      baseUrl: config.llm.baseUrl,
      apiKeyConfigured: config.llm.apiKey.trim().length > 0,
      apiKeySource: process.env.AUREVOY_LLM_API_KEY?.trim() ? 'env' : 'sqlite',
    },
    '运行时配置已加载',
  );

  log.info('初始化 MCP 连接中...');
  const mcp = await initializeMcpTools();

  const app = await buildServer(rootLogger);

  const shutdown = async () => {
    log.info('正在关闭...');
    await closeMcpTools();
    await app.close();
  };
  process.once('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });

  try {
    await app.listen({ host: config.host, port: config.port });
    log.info(`Aurevoy Agent 引擎已启动: http://${config.host}:${config.port}`);
    if (mcp.configuredServers > 0) {
      log.info(
        { connected: mcp.connectedServers, configured: mcp.configuredServers, tools: mcp.registeredTools },
        `MCP 初始化完成：${mcp.connectedServers}/${mcp.configuredServers} servers，${mcp.registeredTools} tools`,
      );
    }
  } catch (err) {
    log.error(err);
    await closeMcpTools();
    process.exit(1);
  }
}

void main();
