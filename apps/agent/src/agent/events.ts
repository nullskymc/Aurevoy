import { EventEmitter } from 'node:events';
import type { AgentEvent, StreamAgentEvent } from '@aurevoy/shared';

/**
 * 任务事件总线。
 *
 * Agent 循环在执行时 emit 事件，SSE 路由订阅这些事件并推送给前端。
 * 每个任务用 taskId 作为 channel。
 *
 * 性能优化：
 * - setMaxListeners(0) 支持多任务并发
 * - 高频事件（tool_progress / token / reasoning）按 type 节流，
 *   避免前端每秒接收数百个 progress 事件导致渲染卡顿
 */

/**
 * 节流配置：每种事件类型的最小发送间隔（毫秒），缺省 0 = 不节流。
 *
 * token 不在事件总线层丢弃；SSE 连接层会在短时间窗内无损拼接 delta，
 * 同时前端按动画帧提交，既保留完整正文又控制逻辑事件/渲染频率。
 * 仅 tool_progress 保留节流（每秒最多 4 次），避免前端工具进度渲染过于频繁。
 */
const THROTTLE_MS: Record<string, number> = {
  tool_progress: 250,    // max 4 fps
};

const MAX_REPLAY_EVENTS = 4096;
const TERMINAL_REPLAY_TTL_MS = 5 * 60_000;

export interface EventReplay {
  events: StreamAgentEvent[];
  /** false 表示 afterSeq 早于当前环形缓冲，调用方必须回退到持久快照。 */
  complete: boolean;
  latestSeq: number;
}

export class TaskEventBus {
  private emitter = new EventEmitter();

  /** 节流计时器：taskId → type → lastSentAt */
  private lastSent = new Map<string, Map<string, number>>();
  /** 每任务独立序号与短期事件日志，覆盖 POST 返回到 SSE 建连及短线重连空窗。 */
  private latestSeqByTask = new Map<string, number>();
  private replayByTask = new Map<string, StreamAgentEvent[]>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(event: AgentEvent): void {
    if (event.type !== 'done' && event.type !== 'task_deleted') {
      const pendingCleanup = this.cleanupTimers.get(event.taskId);
      if (pendingCleanup) {
        clearTimeout(pendingCleanup);
        this.cleanupTimers.delete(event.taskId);
      }

      const replay = this.replayByTask.get(event.taskId);
      if (replay?.at(-1)?.type === 'done') {
        // 同一个任务进入下一轮时，旧轮次的 done 不能继续留在实时回放窗口。
        // 否则新订阅会先收到上一轮终态并立即断开，看不到本轮后续 SSE。
        this.replayByTask.set(event.taskId, []);
      }
    }
    const throttle = THROTTLE_MS[event.type];
    if (throttle) {
      const now = Date.now();
      let byTask = this.lastSent.get(event.taskId);
      if (!byTask) {
        byTask = new Map();
        this.lastSent.set(event.taskId, byTask);
      }
      const last = byTask.get(event.type) ?? 0;
      if (now - last < throttle) return; // 节流丢弃该事件（不序列化、不 emit）
      byTask.set(event.type, now);
    }

    const seq = (this.latestSeqByTask.get(event.taskId) ?? 0) + 1;
    this.latestSeqByTask.set(event.taskId, seq);
    // 事件内含 Task/Message/Plan 等可变对象；日志必须冻结发布时快照，不能随后被运行时改写。
    const streamEvent = Object.assign(structuredClone(event), {
      seq,
      emittedAt: new Date().toISOString(),
    }) as StreamAgentEvent;
    const replay = this.replayByTask.get(event.taskId) ?? [];
    replay.push(streamEvent);
    if (replay.length > MAX_REPLAY_EVENTS) {
      replay.splice(0, replay.length - MAX_REPLAY_EVENTS);
    }
    this.replayByTask.set(event.taskId, replay);
    this.emitter.emit(event.taskId, streamEvent);
    if (event.type === 'done' || event.type === 'task_deleted') {
      this.cleanup(event.taskId);
    }
  }

  subscribe(taskId: string, listener: (event: StreamAgentEvent) => void): () => void {
    this.emitter.on(taskId, listener);
    return () => this.emitter.off(taskId, listener);
  }

  latestSeq(taskId: string): number {
    return this.latestSeqByTask.get(taskId) ?? 0;
  }

  replayAfter(taskId: string, afterSeq: number, upToSeq = this.latestSeq(taskId)): EventReplay {
    const replay = this.replayByTask.get(taskId) ?? [];
    const eligible = replay.filter((event) => event.seq > afterSeq && event.seq <= upToSeq);
    const earliestSeq = replay[0]?.seq;
    const latestSeq = this.latestSeq(taskId);
    const complete =
      afterSeq <= upToSeq &&
      (
        afterSeq === upToSeq ||
        (earliestSeq === undefined ? afterSeq === latestSeq : afterSeq >= earliestSeq - 1)
      );
    return { events: eligible, complete, latestSeq };
  }

  /** 任务结束先清理节流；短期保留事件日志供迟到连接和断线恢复。 */
  cleanup(taskId: string): void {
    this.lastSent.delete(taskId);
    const previous = this.cleanupTimers.get(taskId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.replayByTask.delete(taskId);
      this.latestSeqByTask.delete(taskId);
      this.cleanupTimers.delete(taskId);
    }, TERMINAL_REPLAY_TTL_MS);
    timer.unref?.();
    this.cleanupTimers.set(taskId, timer);
  }
}

export const taskEvents = new TaskEventBus();
