import './load-env.js';
import { buildServer } from './server.js';
import { config } from './config.js';
import { closeMcpTools, initializeMcpTools } from './tool/mcp-integration.js';
import { loadPersistedSettings } from './runtime/settings.js';
import { ensurePythonReady, getPythonPath, getPythonVersion, isPythonInstalled, findSystemPython } from './runtime/python-runtime.js';
import { createLogger, getLogger } from './logging/logger.js';
import { skillRegistry } from './skills/registry.js';
import { startSkillWatcher } from './skills/reload.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { initializeUnifiedToolFramework } from './tool/index.js';

async function main() {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  mkdirSync(config.workspaceDir, { recursive: true });

  const rootLogger = createLogger(config.logging);
  const log = getLogger('server');

  loadPersistedSettings();
  skillRegistry.load();

  // 初始化统一工具框架（Effect-TS + 基础工具 + Skill 工具）
  initializeUnifiedToolFramework();
  const stopSkillWatcher = startSkillWatcher();

  log.info(
    {
      provider: config.llm.provider,
      model: config.llm.model,
      host: config.host,
      port: config.port,
      skills: skillRegistry.list().length,
      apiKeyConfigured: config.llm.apiKey.trim().length > 0,
    },
    '引擎初始化完成',
  );

  const mcp = await initializeMcpTools();

  const app = await buildServer(rootLogger);

  const shutdown = async () => {
    log.info('正在关闭...');
    stopSkillWatcher();
    await closeMcpTools();
    await app.close();
  };
  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });

  try {
    await app.listen({ host: config.host, port: config.port });
    log.info(`Aurevoy Agent 引擎已启动: http://${config.host}:${config.port}`);

    if (isPythonInstalled()) {
      log.info({ python: getPythonPath(), version: getPythonVersion() }, 'Python 运行时就绪');
    } else {
      log.info('Python venv 未就绪，正在后台准备...');
      ensurePythonReady()
        .then((pyPath) => {
          if (pyPath) { log.info({ python: pyPath, version: getPythonVersion() }, 'Python 运行时就绪'); }
          else {
            const sysPy = findSystemPython();
            if (sysPy) { log.warn({ systemPython: sysPy }, '检测到系统 Python 但 venv 创建失败'); }
            else { log.info('未检测到系统 Python，请在设置中配置 Python 解释器路径'); }
          }
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          log.warn({ err: message }, 'Python 环境准备失败');
        });
    }

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
