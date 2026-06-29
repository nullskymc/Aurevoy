import { EventEmitter } from 'node:events';
import type { AgentEvent } from '@aurevoy/shared';

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
 * token / reasoning 不在节流列表中 —— SSE send() 的 setImmediate coalescing
 * + cork/uncork 已提供 socket 级无损批处理，事件总线层不需要丢弃数据。
 * 仅 tool_progress 保留节流（每秒最多 4 次），避免前端工具进度渲染过于频繁。
 */
const THROTTLE_MS: Record<string, number> = {
  tool_progress: 250,    // max 4 fps
};

class TaskEventBus {
  private emitter = new EventEmitter();

  /** 节流计时器：taskId → type → lastSentAt */
  private lastSent = new Map<string, Map<string, number>>();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(event: AgentEvent): void {
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

    this.emitter.emit(event.taskId, event);
  }

  subscribe(taskId: string, listener: (event: AgentEvent) => void): () => void {
    this.emitter.on(taskId, listener);
    return () => this.emitter.off(taskId, listener);
  }

  /** 任务结束时清理节流状态防止内存泄漏 */
  cleanup(taskId: string): void {
    this.lastSent.delete(taskId);
  }
}

export const taskEvents = new TaskEventBus();
