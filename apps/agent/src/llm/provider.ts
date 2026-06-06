import type { Message } from '@aurevoy/shared';

/** LLM 流式输出的增量片段 */
export interface LLMChunk {
  delta: string;
  done: boolean;
}

/**
 * LLM Provider 抽象。
 *
 * 后续接入 OpenAI / Anthropic / 本地模型时，只需实现此接口并在
 * `getProvider()` 中按配置返回对应实现，Agent 循环无需改动。
 */
export interface LLMProvider {
  readonly name: string;
  /** 以流式方式生成回复 */
  stream(messages: Message[]): AsyncIterable<LLMChunk>;
}

/**
 * Mock Provider —— 无需任何 API Key 即可运行整条链路，用于开发期验证
 * "创建任务 → 规划 → 流式输出 → 完成" 的端到端流程。
 */
export class MockProvider implements LLMProvider {
  readonly name = 'mock';

  async *stream(messages: Message[]): AsyncIterable<LLMChunk> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const goal = lastUser?.content ?? '任务';
    const reply = `（Mock 引擎）我已理解你的目标：「${goal}」。这是一个占位回复，接入真实 LLM Provider 后这里会变成真正的推理与执行结果。`;
    for (const ch of reply) {
      await delay(15);
      yield { delta: ch, done: false };
    }
    yield { delta: '', done: true };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 按配置返回 LLM Provider。当前默认 Mock，预留真实 Provider 接入点。 */
export function getProvider(): LLMProvider {
  // TODO: 根据 process.env.AUREVOY_LLM_PROVIDER 返回 OpenAI / Anthropic 等实现
  return new MockProvider();
}
