import { randomUUID } from 'node:crypto';
import type { Task, PlanStep, Message } from '@aurevoy/shared';
import { taskEvents } from './events.js';
import { getProvider } from '../llm/provider.js';
import { taskStore } from '../store/db.js';

/** 创建一个新任务并持久化（尚未开始执行） */
export function createTask(goal: string): Task {
  const now = new Date().toISOString();
  const userMsg: Message = {
    id: randomUUID(),
    role: 'user',
    content: goal,
    createdAt: now,
  };
  const task: Task = {
    id: randomUUID(),
    goal,
    status: 'pending',
    plan: [],
    messages: [userMsg],
    createdAt: now,
    updatedAt: now,
  };
  taskStore.save(task);
  return task;
}

/**
 * Agent 主循环（占位实现）。
 *
 * 真实版本会是 "规划 → 选择动作/工具 → 执行 → 观察 → 反思" 的迭代循环，
 * 由 LLM 驱动决策。当前实现跑通端到端事件流：规划 → 流式输出 → 完成。
 */
export async function runTask(task: Task): Promise<void> {
  const touch = () => {
    task.updatedAt = new Date().toISOString();
    taskStore.save(task);
  };

  try {
    // 1) 规划阶段
    task.status = 'planning';
    touch();
    taskEvents.publish({ type: 'status', taskId: task.id, status: 'planning' });

    const plan: PlanStep[] = [
      { id: randomUUID(), description: '理解用户目标', status: 'completed' },
      { id: randomUUID(), description: '生成回应', status: 'running' },
    ];
    task.plan = plan;
    touch();
    taskEvents.publish({ type: 'plan', taskId: task.id, plan });

    // 2) 执行阶段：调用 LLM 流式生成
    task.status = 'running';
    touch();
    taskEvents.publish({ type: 'status', taskId: task.id, status: 'running' });

    const provider = getProvider();
    let buffer = '';
    for await (const chunk of provider.stream(task.messages)) {
      if (chunk.delta) {
        buffer += chunk.delta;
        taskEvents.publish({ type: 'token', taskId: task.id, delta: chunk.delta });
      }
    }

    // 3) 收尾：保存助手消息
    const assistantMsg: Message = {
      id: randomUUID(),
      role: 'assistant',
      content: buffer,
      createdAt: new Date().toISOString(),
    };
    task.messages.push(assistantMsg);
    plan[1].status = 'completed';
    task.status = 'completed';
    touch();

    taskEvents.publish({ type: 'step_update', taskId: task.id, step: plan[1] });
    taskEvents.publish({ type: 'message', taskId: task.id, message: assistantMsg });
    taskEvents.publish({ type: 'done', taskId: task.id, status: 'completed' });
  } catch (err) {
    task.status = 'failed';
    touch();
    const message = err instanceof Error ? err.message : String(err);
    taskEvents.publish({ type: 'error', taskId: task.id, message });
    taskEvents.publish({ type: 'done', taskId: task.id, status: 'failed' });
  }
}
