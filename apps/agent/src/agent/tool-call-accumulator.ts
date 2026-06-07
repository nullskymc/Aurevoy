/**
 * 流式 tool_calls 累积器。
 *
 * OpenAI 兼容 API 在流式响应中把 tool_calls 拆成多个 delta：
 * - 首个 delta 含 id、type、function.name（后续 delta 这些字段为 null）；
 * - 后续 delta 只含 function.arguments 的字符串片段；
 * - 并行调用用不同的 index 区分。
 * 本类按 index 跨 chunk 正确拼接。
 */

/** 上游单个 tool_call delta 片段 */
export interface ToolCallDelta {
  index?: number;
  id?: string | null;
  type?: string | null;
  function?: {
    name?: string | null;
    arguments?: string;
  };
}

/** 累积后的完整 tool_call */
export interface AccumulatedToolCall {
  index: number;
  id: string;
  function: {
    name: string;
    arguments: string; // 原始 JSON 字符串
  };
}

export class ToolCallAccumulator {
  private map = new Map<number, AccumulatedToolCall>();

  /** 处理一个 delta chunk 中的 tool_calls 数组 */
  process(deltas: ToolCallDelta[]): void {
    for (const delta of deltas) {
      // 防御性：某些降级提供商可能漏掉 index
      if (delta.index == null) continue;

      const existing = this.map.get(delta.index);
      if (!existing) {
        this.map.set(delta.index, {
          index: delta.index,
          id: delta.id ?? '',
          function: {
            name: delta.function?.name ?? '',
            arguments: delta.function?.arguments ?? '',
          },
        });
      } else {
        if (delta.function?.arguments) {
          existing.function.arguments += delta.function.arguments;
        }
        // 防御性：某些提供商可能在后续 chunk 才给 id/name
        if (delta.id && !existing.id) existing.id = delta.id;
        if (delta.function?.name && !existing.function.name) {
          existing.function.name = delta.function.name;
        }
      }
    }
  }

  /** 当前快照（按 index 排序） */
  snapshot(): AccumulatedToolCall[] {
    return [...this.map.values()].sort((a, b) => a.index - b.index);
  }

  /** 是否累积到任何 tool_call */
  hasAny(): boolean {
    return this.map.size > 0;
  }

  /** 重置（新一轮循环时调用） */
  reset(): void {
    this.map.clear();
  }
}
