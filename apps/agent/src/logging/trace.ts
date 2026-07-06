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
    this.logger = log().child({ taskId });
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

    traceStore.append(traceEntry);

    const level = entry.ok === false ? 'warn' : 'info';
    this.logger[level]({
      kind,
      phase,
      iteration: entry.iteration,
      callId: entry.callId,
      toolName: entry.toolName,
      riskLevel: entry.riskLevel,
      finishReason: entry.finishReason,
      provider,
      model,
      durationMs,
      ok: entry.ok,
      errorCategory: entry.errorCategory,
      errorMessage: entry.errorMessage,
      summary: entry.summary,
    }, `trace:${kind}`);
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

export function createTaskLogger(taskId: string): TaskLogger {
  return new TaskLogger(taskId);
}
