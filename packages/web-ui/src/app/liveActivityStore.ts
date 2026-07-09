import type { ToolActivity } from "../components/Conversation";

/**
 * 实时工具活动状态（替代 deriveToolActivityFromEvents 的 events[] 全量扫描）。
 *
 * 每个 tool_call / tool_progress / tool_result SSE 事件直接更新 Map；
 * React 层再按帧批量同步 snapshot，避免工具卡片逐个出现。
 */
export function createLiveActivityStore() {
  const map = new Map<string, ToolActivity>();
  const order: string[] = [];

  function upsert(id: string, patch: Partial<ToolActivity>) {
    const existing = map.get(id);
    if (existing) {
      Object.assign(existing, patch);
    } else {
      order.push(id);
      map.set(id, {
        id,
        name: "",
        args: {} as Record<string, unknown>,
        status: "running",
        ...patch,
      } as ToolActivity);
    }
  }

  function remove(id: string) {
    map.delete(id);
    const idx = order.indexOf(id);
    if (idx >= 0) order.splice(idx, 1);
  }

  function has(id: string): boolean {
    return map.has(id);
  }

  function snapshot(): ToolActivity[] {
    return order.map((id) => map.get(id)!);
  }

  function clear() {
    map.clear();
    order.length = 0;
  }

  return { upsert, remove, has, snapshot, clear };
}
