import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Model as PiModel,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions,
} from '@earendil-works/pi-ai';
import { config } from '../../config.js';
import { getLogger } from '../../logging/logger.js';

type JsonRecord = Record<string, unknown>;
type StreamMethod = 'stream' | 'streamSimple';

const logger = getLogger('native-web-search');
const RESPONSES_APIS = new Set([
  'openai-responses',
  'openai-codex-responses',
  'azure-openai-responses',
]);

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLocalWebSearchTool(tool: unknown): boolean {
  if (!isRecord(tool) || tool.name !== 'web_search') return false;
  return tool.type === 'function' || tool.input_schema !== undefined;
}

function isHostedResponsesSearch(tool: unknown): boolean {
  return isRecord(tool) && (tool.type === 'web_search' || tool.type === 'web_search_preview');
}

function isHostedAnthropicSearch(tool: unknown): boolean {
  return isRecord(tool)
    && tool.name === 'web_search'
    && typeof tool.type === 'string'
    && tool.type.startsWith('web_search_');
}

/**
 * 在最终 provider payload 才把 Aurevoy 本地函数替换成上游服务器搜索，
 * 避免 hosted tool 进入通用工具注册表或被本地执行器误调。
 */
export function injectNativeWebSearchTool(payload: unknown, api: string): unknown {
  if (!isRecord(payload)) return payload;
  const currentTools = Array.isArray(payload.tools) ? payload.tools : [];
  const tools = currentTools.filter((tool) => !isLocalWebSearchTool(tool));

  if (api === 'anthropic-messages') {
    if (!tools.some(isHostedAnthropicSearch)) {
      tools.push({ type: 'web_search_20250305', name: 'web_search' });
    }
  } else if (RESPONSES_APIS.has(api) && !tools.some(isHostedResponsesSearch)) {
    tools.push({ type: 'web_search' });
  }

  return { ...payload, tools };
}

/**
 * 根据当前实际 wire API 自动选择 hosted search 协议。
 * - Responses 族 / Anthropic Messages 已有服务器搜索，原样使用；
 * - 普通 OpenAI-completions 端先试 Responses hosted search；
 * - DeepSeek 官方已全量走 Responses；防御性兜底：旧快照里仍为 completions 的
 *   deepseek 模型不发 hosted search，直接回落本地搜索后端，避免协议杂糅。
 */
export function resolveNativeWebSearchModel(model: PiModel<any>): PiModel<any> | null {
  if (!config.search.preferNative) return null;
  if (RESPONSES_APIS.has(model.api) || model.api === 'anthropic-messages') return model;

  if (model.api !== 'openai-completions') return null;
  if (model.provider === 'deepseek') return null;
  return { ...model, api: 'openai-responses' };
}

function withNativePayload(
  options: StreamOptions | SimpleStreamOptions | undefined,
  api: string,
): StreamOptions | SimpleStreamOptions {
  return {
    ...options,
    onPayload: async (payload, requestModel) => {
      const prior = options?.onPayload
        ? await options.onPayload(payload, requestModel)
        : undefined;
      return injectNativeWebSearchTool(prior ?? payload, api);
    },
  };
}

function nativeSearchUnsupported(message: AssistantMessage): boolean {
  const detail = message.errorMessage?.toLowerCase() ?? '';
  if (!detail) return false;
  if (detail.includes('web_search') || detail.includes('web search')) return true;
  return (
    detail.includes('tool')
    && (
      detail.includes('unsupported')
      || detail.includes('not supported')
      || detail.includes('unknown')
      || detail.includes('invalid')
      || detail.includes('unrecognized')
    )
  );
}

function streamWithFallback(
  nativeFactory: () => AssistantMessageEventStream,
  fallbackFactory: () => AssistantMessageEventStream,
  model: PiModel<any>,
  fallbackOnAnyRequestError: boolean,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();

  void (async () => {
    let pendingStart: AssistantMessageEvent | undefined;
    let emittedContent = false;
    let outputStarted = false;
    let useFallback = false;
    const pendingHostedCalls = new Map<string, AssistantMessage>();

    for await (const event of nativeFactory()) {
      if (event.type === 'start') {
        pendingStart = event;
        continue;
      }
      if (
        event.type === 'error'
        && !emittedContent
        && (fallbackOnAnyRequestError || nativeSearchUnsupported(event.error))
      ) {
        useFallback = true;
        break;
      }
      // Anthropic 的 pause_turn 在当前 Pi 版本会收敛成空 done；此时回退本地搜索，
      // 避免服务器工具已暂停但没有正文却被误判为任务完成。
      if (event.type === 'done' && !emittedContent && event.message.content.length === 0) {
        useFallback = true;
        break;
      }
      if (pendingStart) {
        output.push(pendingStart);
        pendingStart = undefined;
        outputStarted = true;
      }
      output.push(event);
      if (event.type === 'hosted_tool_start') {
        pendingHostedCalls.set(event.call.id, event.partial);
      } else if (event.type === 'hosted_tool_end') {
        pendingHostedCalls.delete(event.result.callId);
      }
      emittedContent =
        event.type !== 'done'
        && event.type !== 'error'
        && event.type !== 'hosted_tool_start'
        && event.type !== 'hosted_tool_end';
    }

    if (!useFallback) return;

    logger.info(
      { provider: model.provider, model: model.id, api: model.api },
      '上游不支持 API 原生搜索，回退 Aurevoy 本地 web_search',
    );

    // hosted tool 已进入 timeline 时必须先闭合，避免回退后遗留永久“搜索中”状态。
    for (const [callId, partial] of pendingHostedCalls) {
      output.push({
        type: 'hosted_tool_end',
        result: {
          callId,
          ok: false,
          error: '上游搜索未完成，已回退本地搜索',
          providerExecuted: true,
        },
        partial,
      });
    }

    for await (const event of fallbackFactory()) {
      // hosted stream 已经建立过同一条 assistant 消息时，复用它而不是重复发 start。
      if (event.type === 'start' && outputStarted) continue;
      if (event.type === 'start') outputStarted = true;
      output.push(event);
    }
  })();

  return output;
}

/**
 * 包装 hosted search 请求；只有在请求尚未产生正文且错误明确指向工具不兼容时才重试，
 * 避免流式输出一半后重复回答。
 */
export function withNativeWebSearchFallback(
  nativeApi: ProviderStreams,
  nativeModel: PiModel<any>,
  fallbackApi: ProviderStreams,
  fallbackModel: PiModel<any>,
): ProviderStreams {
  const call = (
    method: StreamMethod,
    _requestModel: PiModel<any>,
    context: Parameters<ProviderStreams[StreamMethod]>[1],
    options?: StreamOptions | SimpleStreamOptions,
  ) => streamWithFallback(
    () => nativeApi[method](
      nativeModel,
      context,
      withNativePayload(options, nativeModel.api) as never,
    ),
    () => fallbackApi[method](fallbackModel, context, options as never),
    nativeModel,
    nativeModel.api !== fallbackModel.api,
  );

  return {
    stream: (model, context, options) => call('stream', model, context, options),
    streamSimple: (model, context, options) => call('streamSimple', model, context, options),
  };
}
