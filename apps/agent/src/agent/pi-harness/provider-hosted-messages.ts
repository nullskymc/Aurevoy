import { randomUUID } from 'node:crypto';
import type { Message, ToolCall, ToolResult } from '@aurevoy/shared';

/** 将 Provider 托管工具调用投影为产品层标准 assistant 工具消息。 */
export function createProviderHostedCallMessage(
  call: ToolCall,
  createdAt = new Date().toISOString(),
): Message {
  return {
    id: randomUUID(),
    role: 'assistant',
    content: '',
    createdAt,
    providerExecuted: true,
    toolCalls: [{
      id: call.id,
      type: 'function',
      providerExecuted: true,
      function: {
        name: call.toolName,
        arguments: JSON.stringify(call.args),
        planStepId: call.planStepId,
        summary: call.summary,
      },
    }],
  };
}

/** 将 Provider 托管工具完成事件投影为与调用配对的标准 tool 消息。 */
export function createProviderHostedResultMessage(
  result: ToolResult,
  createdAt = new Date().toISOString(),
): Message {
  return {
    id: randomUUID(),
    role: 'tool',
    content: result.ok
      ? '{}'
      : JSON.stringify({
          error: result.error ?? 'Provider 托管工具执行失败',
          errorCode: result.errorCode ?? 'execution_failed',
        }),
    toolCallId: result.callId,
    providerExecuted: true,
    createdAt,
  };
}
