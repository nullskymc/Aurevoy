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
 * - 回放窗口使用定长环形缓冲：写入 O(1)，避免环满后每次 publish 触发
 *   整体前移（原 Array#splice 在 4096 上限下是 O(n) 热路径成本）
 * - 负载只含原始值的事件用浅拷贝冻结快照，避免高频 token 流的深克隆开销
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

/**
 * 负载只含原始值（string / number / boolean / undefined）的事件类型。
 * 这类事件浅拷贝即已冻结发布时快照，深克隆（structuredClone）纯属浪费；
 * 尤其 token 是最高频事件，每次深克隆 + 序列化的双重遍历会被放大。
 * 其余事件（task / message / tool_result / plan 等）可能被运行态复用并继续改写，
 * 必须走 structuredClone 冻结嵌套对象。
 */
const SHALLOW_CLONE_EVENT_TYPES = new Set<AgentEvent['type']>([
  'agent_start',
  'context_snapshot',
  'done',
  'error',
  'message_start',
  'phase',
  'retry_status',
  'skill_deactivated',
  'status',
  'task_deleted',
  'task_resumed',
  'task_title',
  'token',
  'unreverted',
]);

export interface EventReplay {
  events: StreamAgentEvent[];
  /** false 表示 afterSeq 早于当前环形缓冲，调用方必须回退到持久快照。 */
  complete: boolean;
  latestSeq: number;
}

/** 每任务回放窗口：定长环形缓冲，元素按 seq 严格递增顺序写入。 */
interface ReplayRing {
  /** 定长槽位；未满时元素连续占据 0..size-1，满时按 head 环绕。 */
  buffer: (StreamAgentEvent | undefined)[];
  /** 下一个写入位置；环满时同时是「最旧元素」所在下标（即读取起点）。 */
  head: number;
  /** 有效元素个数，<= buffer.length。 */
  size: number;
}

function createReplayRing(): ReplayRing {
  return { buffer: new Array(MAX_REPLAY_EVENTS), head: 0, size: 0 };
}

/** 写入一条事件；环满时覆盖最旧元素，保证窗口内 seq 连续递增。 */
function ringPush(ring: ReplayRing, event: StreamAgentEvent): void {
  ring.buffer[ring.head] = event;
  if (ring.size < MAX_REPLAY_EVENTS) ring.size += 1;
  ring.head = (ring.head + 1) % MAX_REPLAY_EVENTS;
}

/** 窗口内最新一条事件（写入顺序的末位）。 */
function ringLatest(ring: ReplayRing | undefined): StreamAgentEvent | undefined {
  if (!ring || ring.size === 0) return undefined;
  return ring.buffer[(ring.head - 1 + MAX_REPLAY_EVENTS) % MAX_REPLAY_EVENTS]!;
}

/** 按写入顺序遍历窗口内全部事件。 */
function ringForEach(ring: ReplayRing, visit: (event: StreamAgentEvent) => void): void {
  // 未满时最旧元素恒在 0；满时 head 指向最旧元素，从该处环绕即可得到写入顺序。
  const start = ring.size < MAX_REPLAY_EVENTS ? 0 : ring.head;
  for (let i = 0; i < ring.size; i++) {
    visit(ring.buffer[(start + i) % MAX_REPLAY_EVENTS]!);
  }
}

export class TaskEventBus {
  private emitter = new EventEmitter();

  /** 节流计时器：taskId → type → lastSentAt */
  private lastSent = new Map<string, Map<string, number>>();
  /** 每任务独立序号与短期事件日志，覆盖 POST 返回到 SSE 建连及短线重连空窗。 */
  private latestSeqByTask = new Map<string, number>();
  private replayByTask = new Map<string, ReplayRing>();
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
      if (ringLatest(replay)?.type === 'done') {
        // 同一个任务进入下一轮时，旧轮次的 done 不能继续留在实时回放窗口。
        // 否则新订阅会先收到上一轮终态并立即断开，看不到本轮后续 SSE。
        this.replayByTask.set(event.taskId, createReplayRing());
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
    // 标量负载事件浅拷贝即可，避免高频流（token）每次深克隆的开销。
    const streamEvent = (SHALLOW_CLONE_EVENT_TYPES.has(event.type)
      ? { ...event }
      : structuredClone(event)) as StreamAgentEvent;
    streamEvent.seq = seq;
    streamEvent.emittedAt = new Date().toISOString();

    let replay = this.replayByTask.get(event.taskId);
    if (!replay) {
      replay = createReplayRing();
      this.replayByTask.set(event.taskId, replay);
    }
    ringPush(replay, streamEvent);
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
    const latestSeq = this.latestSeq(taskId);
    const ring = this.replayByTask.get(taskId);
    if (!ring || ring.size === 0) {
      const complete =
        afterSeq <= upToSeq &&
        (afterSeq === upToSeq || afterSeq === latestSeq);
      return { events: [], complete, latestSeq };
    }
    // 环形缓冲按 seq 递增存储；顺序扫描（上限 4096）收集目标区间事件。
    const eligible: StreamAgentEvent[] = [];
    let earliestSeq: number | undefined;
    ringForEach(ring, (event) => {
      if (earliestSeq === undefined) earliestSeq = event.seq;
      if (event.seq > afterSeq && event.seq <= upToSeq) eligible.push(event);
    });
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
