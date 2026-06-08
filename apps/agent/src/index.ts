import './load-env.js';
import { buildServer } from './server.js';
import { config } from './config.js';
import './tools/builtins.js'; // 副作用导入：注册内置工具（文件/网络）
import { closeMcpTools, initializeMcpTools } from './tools/mcp.js';
import { loadPersistedSettings } from './runtime/settings.js';

async function main() {
  loadPersistedSettings();
  const mcp = await initializeMcpTools();
  const app = await buildServer();

  const shutdown = async () => {
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
    app.log.info(`Aurevoy Agent 引擎已启动: http://${config.host}:${config.port}`);
    if (mcp.configuredServers > 0) {
      app.log.info(
        `MCP 初始化完成：${mcp.connectedServers}/${mcp.configuredServers} servers，${mcp.registeredTools} tools`,
      );
    }
  } catch (err) {
    app.log.error(err);
    await closeMcpTools();
    process.exit(1);
  }
}

void main();
