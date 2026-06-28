import './load-env.js';
import { buildServer } from './server.js';
import { config } from './config.js';
 import './tools/builtins.js'; // 副作用导入：注册内置工具（文件/网络）
import './tools/file-basics.js'; // 副作用导入：注册行级视口文件工具（open_file/scroll/search_grep + 新三件套写入原语）
 import './tools/web-search.js'; // 副作用导入：注册 web_search 工具
import { registerLoadSkillTool } from './tools/load-skill.js';
import { registerInstallSkillTool } from './tools/install-skill.js';
import { closeMcpTools, initializeMcpTools } from './tools/mcp.js';
import { loadPersistedSettings } from './runtime/settings.js';
import { ensurePythonReady, getPythonPath, getPythonVersion, isPythonInstalled } from './runtime/python-runtime.js';
import { createLogger, getLogger } from './logging/logger.js';
import { skillRegistry } from './skills/registry.js';
import { startSkillWatcher } from './skills/reload.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

async function main() {
  // 提前确保数据目录存在（安装版 app bundle 内 cwd 只读，数据在 ~/.aurevoy/）
  mkdirSync(dirname(config.dbPath), { recursive: true });
  mkdirSync(config.workspaceDir, { recursive: true });

  const rootLogger = createLogger(config.logging);
  const log = getLogger('server');

  log.info({ provider: config.llm.provider, model: config.llm.model, host: config.host, port: config.port, db: config.dbPath }, '加载配置完成');

  loadPersistedSettings();

  if (config.python.autoSetup) {
    if (!isPythonInstalled()) {
      log.info('Python 运行时未安装，正在自动下载...');
      try {
        await ensurePythonReady();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ err: message }, 'Python 运行时自动安装失败，MCP Python 服务器和 execute_command 中的 python3 将不可用');
      }
    }
    if (isPythonInstalled()) {
      log.info({ python: getPythonPath(), version: getPythonVersion() }, 'Python 运行时就绪');
    }
  }

  skillRegistry.load();
  registerLoadSkillTool();
  registerInstallSkillTool();
  log.info({ count: skillRegistry.list().length }, 'skill 模块已加载');
  const stopSkillWatcher = startSkillWatcher();

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
    stopSkillWatcher();
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

    // M8: 启动后延迟执行一轮 Dreams 维护（不阻塞启动）
    setTimeout(async () => {
      try {
        const { runDreams } = await import('./memory/dreams.js');
        const report = await runDreams({ backfillEmbeddings: true, dedupMerge: true, lowConfidenceSweep: true });
        if (report.backfilled > 0 || report.dedupMerged > 0 || report.lowConfidenceDisabled > 0) {
          log.info(report, 'Dreams 启动维护完成');
        }
      } catch { /* 维护失败不影响引擎运行 */ }
    }, 30_000);
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
