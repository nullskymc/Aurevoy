import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { TaskErrorCategory, TaskPhase, TaskTraceEntry, TaskTraceKind, TokenUsage, ToolRiskLevel } from '@aurevoy/shared';
import { traceStore } from '../store/db.js';
import { config } from '../config.js';
import { getPiProviderName } from '../llm/pi-provider.js';
import { getRootLogger } from './logger.js';

let _log: Logger | undefined;
function log(): Logger {
  if (!_log) _log = getRootLogger();
  return _log;
}

export interface TraceEntry {
  iteration?: number;
  callId?: string;
  toolName?: string;
  riskLevel?: ToolRiskLevel;
  finishReason?: string;
  tokenUsage?: TokenUsage | null;
  startedAtMs?: number;
  ok?: boolean;
  errorCategory?: TaskErrorCategory;
  errorMessage?: string;
  summary?: string;
  data?: unknown;
}

export class TaskLogger {
  readonly taskId: string;
  private logger: Logger;

  constructor(taskId: string) {
    this.taskId = taskId;
    // 短 taskId 降低行噪声；完整 id 在 SQLite 轨迹里
    this.logger = log().child({ taskId: taskId.length > 8 ? taskId.slice(0, 8) : taskId });
  }

  get child(): Logger {
    return this.logger;
  }

  trace(kind: TaskTraceKind, phase: TaskPhase | null, entry: TraceEntry = {}): void {
    const endedAtMs = Date.now();
    const startedAtMs = entry.startedAtMs ?? endedAtMs;
    const durationMs = Math.max(0, endedAtMs - startedAtMs);
    const provider = getPiProviderName();
    const model = config.llm.model;

    const traceEntry: TaskTraceEntry = {
      id: randomUUID(),
      taskId: this.taskId,
      kind,
      phase,
      iteration: entry.iteration,
      callId: entry.callId,
      toolName: entry.toolName,
      riskLevel: entry.riskLevel,
      provider,
      model,
      finishReason: entry.finishReason,
      tokenUsage: entry.tokenUsage ?? null,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs,
      ok: entry.ok,
      errorCategory: entry.errorCategory,
      errorMessage: entry.errorMessage,
      summary: entry.summary,
      data: entry.data,
    };

    // 审计真相源：始终落 SQLite
    traceStore.append(traceEntry);

    // 运维日志：成功细节默认 debug，避免与 HTTP/轮询抢视线；失败/收尾保留 info|warn
    const failed = entry.ok === false;
    const level = failed ? 'warn' : isSalientTrace(kind, entry) ? 'info' : 'debug';
    this.logger[level](
      {
        kind,
        ...(phase ? { phase } : {}),
        ...(entry.toolName ? { tool: entry.toolName } : {}),
        ...(failed && entry.errorCategory ? { errCat: entry.errorCategory } : {}),
        // 不用 err/error 键：pino-pretty 会当 Error 对象多行展开
        ...(failed && entry.errorMessage ? { errMsg: entry.errorMessage } : {}),
        ...(durationMs > 0 ? { ms: durationMs } : {}),
        ...(entry.ok !== undefined ? { ok: entry.ok } : {}),
      },
      entry.summary ?? `trace:${kind}`,
    );
  }

  info(msg: string, extra?: Record<string, unknown>): void {
    this.logger.info(extra ?? {}, msg);
  }

  warn(msg: string, extra?: Record<string, unknown>): void {
    this.logger.warn(extra ?? {}, msg);
  }

  error(msg: string, extra?: Record<string, unknown>): void {
    this.logger.error(extra ?? {}, msg);
  }

  debug(msg: string, extra?: Record<string, unknown>): void {
    this.logger.debug(extra ?? {}, msg);
  }
}

/** 默认 info 可见的轨迹：收尾、审批结果；常规 llm/tool 成功走 debug */
function isSalientTrace(kind: TaskTraceKind, entry: TraceEntry): boolean {
  if (kind === 'done' || kind === 'error' || kind === 'approval') return true;
  if (kind === 'phase' && entry.errorCategory === 'budget') return true;
  return false;
}

export function createTaskLogger(taskId: string): TaskLogger {
  return new TaskLogger(taskId);
}
