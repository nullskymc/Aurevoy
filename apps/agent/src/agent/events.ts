import { EventEmitter } from 'node:events';
import type { AgentEvent } from '@aurevoy/shared';

/**
 * 任务事件总线。
 *
 * Agent 循环在执行时 emit 事件，SSE 路由订阅这些事件并推送给前端。
 * 每个任务用 taskId 作为 channel。
 */
class TaskEventBus {
  private emitter = new EventEmitter();

  constructor() {
    // 单进程内可能有多个任务并发订阅
    this.emitter.setMaxListeners(0);
  }

  publish(event: AgentEvent): void {
    this.emitter.emit(event.taskId, event);
  }

  subscribe(taskId: string, listener: (event: AgentEvent) => void): () => void {
    this.emitter.on(taskId, listener);
    // 返回取消订阅函数
    return () => this.emitter.off(taskId, listener);
  }
}

export const taskEvents = new TaskEventBus();
