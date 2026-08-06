import { createReadStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyTypeProvider,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
} from "fastify";
import type {
  CleanupDataRequest,
  CleanupDataResponse,
  DataExportPayload,
  DataExportRequest,
  DataStatusResponse,
  TaskObservabilityReport,
  TokenUsageReport,
} from "@aurevoy/shared";
import { config } from "../config.js";
import { APP_VERSION } from "../version.js";
import { buildTokenUsageReport } from "../agent/token-usage.js";
import { buildTaskObservabilityReport } from "../agent/task-metrics.js";
import { buildDataExportPayload } from "../data/export.js";
import { getKbIndexStatus, listKbDirs } from "../knowledge-base/index.js";
import { readCleanupPolicyDays, readRuntimeSettings } from "../runtime/settings.js";
import { createDatabaseBackup } from "../store/database-maintenance.js";
import { db, memoryStore, projectStore, taskStore, traceStore } from "../store/db.js";
import { readDataStatus } from "./health.js";

/** 数据管理路由集中处理导出、备份、指标和清理，不让 server.ts 混入文件生命周期细节。 */
export function registerDataRoutes<
  RawServer extends RawServerBase,
  RawRequest extends RawRequestDefaultExpression<RawServer>,
  RawReply extends RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider,
>(app: FastifyInstance<RawServer, RawRequest, RawReply, Logger, TypeProvider>): void {
  app.get("/api/data", async (): Promise<DataStatusResponse> => readDataStatus());

  app.post<{ Body: DataExportRequest }>(
    "/api/data/export",
    async (req, reply): Promise<DataExportPayload | unknown> => {
      const exportedAt = new Date().toISOString();
      const knowledgeBase = readKnowledgeBaseSnapshot();
      const payload = buildDataExportPayload({
        appVersion: APP_VERSION,
        exportedAt,
        settings: readRuntimeSettings(),
        projects: projectStore.list(),
        memories: memoryStore.list(),
        tasks: taskStore.list(),
        kbDirs: knowledgeBase.dirs,
        kbStatus: knowledgeBase.status,
        includeTaskMessages: req.body?.includeTaskMessages === true,
      });
      return reply
        .header("Content-Disposition", `attachment; filename="${exportFilename(exportedAt)}"`)
        .type("application/json; charset=utf-8")
        .send(payload);
    },
  );

  /** 生成可恢复的 SQLite 副本并以附件下载；临时文件只在本次响应期间存在。 */
  app.post("/api/data/database-backup", async (_req, reply) => {
    const temporaryDir = await fs.mkdtemp(join(tmpdir(), "aurevoy-db-backup-"));
    const filename = `aurevoy-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`;
    const destination = join(temporaryDir, filename);
    try {
      const backup = await createDatabaseBackup(db, config.dbPath, destination);
      const stream = createReadStream(backup.backupPath);
      stream.once("close", () => { void fs.rm(temporaryDir, { recursive: true, force: true }); });
      return reply
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .type("application/vnd.sqlite3")
        .send(stream);
    } catch (error) {
      await fs.rm(temporaryDir, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(/disk is full|Not enough disk space/i.test(message) ? 507 : 500).send({ error: message });
    }
  });

  app.get("/api/data/token-usage", async (): Promise<TokenUsageReport> => buildTokenUsageReport(taskStore.list()));

  app.get("/api/data/task-metrics", async (): Promise<TaskObservabilityReport> => {
    const tasks = taskStore.list();
    return buildTaskObservabilityReport(tasks, (taskId) => traceStore.list(taskId));
  });

  app.post<{ Body: CleanupDataRequest }>(
    "/api/data/cleanup",
    async (req, reply): Promise<CleanupDataResponse | unknown> => {
      const olderThanDays = req.body?.olderThanDays ?? readCleanupPolicyDays();
      if (!Number.isFinite(olderThanDays) || olderThanDays < 1 || olderThanDays > 3650) {
        return reply.code(400).send({ error: "olderThanDays must be between 1 and 3650" });
      }
      return taskStore.cleanupTerminal(olderThanDays);
    },
  );
}

function readKnowledgeBaseSnapshot(): {
  dirs: ReturnType<typeof listKbDirs>;
  status: ReturnType<typeof getKbIndexStatus>;
} {
  try {
    return { dirs: listKbDirs(), status: getKbIndexStatus() };
  } catch {
    // 旧数据库或 sqlite-vec 降级时，导出仍应带走任务/记忆等主数据。
    return { dirs: [], status: { totalFiles: 0, totalChunks: 0, lastIndexed: null } };
  }
}

function exportFilename(exportedAt: string): string {
  const stamp = exportedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
  return `aurevoy-data-${stamp}.json`;
}
