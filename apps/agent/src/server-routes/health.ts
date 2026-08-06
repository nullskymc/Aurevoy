import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyTypeProvider,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
} from 'fastify';
import type {
  DataStatusResponse,
  HealthDiagnosticsResponse,
  HealthResponse,
} from '@aurevoy/shared';
import { config } from '../config.js';
import { APP_VERSION } from '../version.js';
import { getLlmReadiness, getPiProviderName } from '../llm/pi-provider.js';
import { buildHealthDiagnostics, type HealthDiagnosticProbe } from '../diagnostics/health.js';
import { getKbIndexStatus, listKbDirs } from '../knowledge-base/index.js';
import { readCleanupPolicyDays } from '../runtime/settings.js';
import { db, isVecLoaded, memoryStore, projectStore, taskStore, traceStore } from '../store/db.js';
import { readSchemaStatus } from '../store/migrations.js';

/** 健康路由只聚合诊断探针，不把数据库/运行时探针散落在 server.ts。 */
export function registerHealthRoutes<
  RawServer extends RawServerBase,
  RawRequest extends RawRequestDefaultExpression<RawServer>,
  RawReply extends RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider,
>(
  app: FastifyInstance<RawServer, RawRequest, RawReply, Logger, TypeProvider>,
  startedAt: number,
): void {
  app.get('/api/health', async (): Promise<HealthResponse> => {
    const llm = getLlmReadiness();
    return {
      status: 'ok',
      version: APP_VERSION,
      uptimeMs: Date.now() - startedAt,
      provider: getPiProviderName(),
      llm,
      contextCharBudget: config.agent.contextCharBudget,
      contextTokenBudget: config.agent.contextTokenBudget,
    };
  });

  app.get('/api/health/diagnostics', async (): Promise<HealthDiagnosticsResponse> => {
    const llm = getLlmReadiness();
    return buildHealthDiagnostics({
      generatedAt: new Date().toISOString(),
      version: APP_VERSION,
      uptimeMs: Date.now() - startedAt,
      llm,
      data: readDataStatus(),
      database: probeDatabase(),
      workspace: probeWorkspace(),
      embedding: probeEmbedding(),
      vectorStore: probeVectorStore(),
      knowledgeBase: probeKnowledgeBase(),
    });
  });
}

export function readDataStatus(): DataStatusResponse {
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
}

function probeDatabase(): HealthDiagnosticProbe {
  try {
    const result = db.prepare('PRAGMA quick_check(1)').get() as { quick_check?: string } | undefined;
    const schema = readSchemaStatus(db);
    const passed = result?.quick_check === 'ok' && schema.version === schema.expectedVersion;
    return {
      status: passed ? 'ok' : 'error',
      summary: passed
        ? 'SQLite quick check and schema version passed'
        : 'SQLite quick check or schema version returned an unexpected result',
      details: {
        quickCheck: result?.quick_check ?? null,
        schemaVersion: schema.version,
        expectedSchemaVersion: schema.expectedVersion,
        migrationCount: schema.migrationCount,
      },
    };
  } catch (error) {
    return {
      status: 'error',
      summary: 'SQLite quick check failed',
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function probeWorkspace(): HealthDiagnosticProbe {
  try {
    const stat = statSync(config.workspaceDir);
    if (!stat.isDirectory()) {
      return {
        status: 'error',
        summary: 'Workspace path is not a directory',
        details: { exists: true, writable: false },
      };
    }
    accessSync(config.workspaceDir, fsConstants.R_OK | fsConstants.W_OK);
    return {
      status: 'ok',
      summary: 'Workspace directory is readable and writable',
      details: { exists: true, writable: true },
    };
  } catch (error) {
    return {
      status: 'error',
      summary: 'Workspace directory is unavailable or not writable',
      details: {
        exists: false,
        writable: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function probeEmbedding(): HealthDiagnosticProbe {
  const provider = config.embedding.provider;
  const configured = provider !== 'off' && config.embedding.apiKey.trim().length > 0;
  if (provider === 'off') {
    return {
      status: 'warning',
      summary: 'Embedding is disabled; semantic recall will fall back to keywords',
      details: { provider, model: config.embedding.model, apiKeyConfigured: false },
    };
  }
  return {
    status: configured ? 'ok' : 'warning',
    summary: configured
      ? 'Embedding configuration is present'
      : 'Embedding provider has no configured API key',
    details: { provider, model: config.embedding.model, apiKeyConfigured: configured },
  };
}

function probeVectorStore(): HealthDiagnosticProbe {
  const loaded = isVecLoaded();
  return {
    status: loaded ? 'ok' : 'warning',
    summary: loaded
      ? 'sqlite-vec extension is loaded'
      : 'sqlite-vec is unavailable; vector search is degraded',
    details: { loaded },
  };
}

function probeKnowledgeBase(): HealthDiagnosticProbe {
  try {
    const dirs = listKbDirs();
    const status = getKbIndexStatus();
    if (dirs.length === 0) {
      return {
        status: 'warning',
        summary: 'No knowledge-base directory is configured',
        details: { configuredDirs: 0, totalFiles: status.totalFiles, totalChunks: status.totalChunks },
      };
    }
    if (status.totalChunks === 0) {
      return {
        status: 'warning',
        summary: 'Knowledge-base directories exist but no chunks are indexed',
        details: { configuredDirs: dirs.length, totalFiles: status.totalFiles, totalChunks: 0 },
      };
    }
    return {
      status: 'ok',
      summary: 'Knowledge base has indexed content',
      details: { configuredDirs: dirs.length, totalFiles: status.totalFiles, totalChunks: status.totalChunks },
    };
  } catch (error) {
    return {
      status: 'error',
      summary: 'Knowledge-base status could not be read',
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}
