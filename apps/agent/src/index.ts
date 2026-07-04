import './load-env.js';
import { buildServer } from './server.js';
import { config } from './config.js';
import './tools/builtins.js'; // 副作用导入：注册旧注册表基础工具（文件/记忆/交互/命令）
import './tools/file-basics.js'; // 副作用导入：注册行级视口文件工具
import './tools/new-tools.js'; // 副作用导入：注册新架构工具 (read/write/edit/grep/glob/bash/web_search/web_fetch)
import { registerLoadSkillTool } from './tools/load-skill.js';
import { registerInstallSkillTool } from './tools/install-skill.js';
import { closeMcpTools, initializeMcpTools } from './tools/mcp.js';
import { loadPersistedSettings } from './runtime/settings.js';
import { ensurePythonReady, getPythonPath, getPythonVersion, isPythonInstalled, findSystemPython } from './runtime/python-runtime.js';
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

    // 后台异步准备 Python 环境（检测系统 Python、创建 venv）
    if (isPythonInstalled()) {
      log.info({ python: getPythonPath(), version: getPythonVersion() }, 'Python 运行时就绪');
    } else {
      log.info('Python venv 未就绪，正在后台准备...');
      ensurePythonReady()
        .then((pyPath) => {
          if (pyPath) {
            log.info({ python: pyPath, version: getPythonVersion() }, 'Python 运行时就绪');
          } else {
            const sysPy = findSystemPython();
            if (sysPy) {
              log.warn({ systemPython: sysPy }, '检测到系统 Python 但 venv 创建失败');
            } else {
              log.info('未检测到系统 Python，请在设置中配置 Python 解释器路径');
            }
          }
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          log.warn({ err: message }, 'Python 环境准备失败');
        });
    }

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
