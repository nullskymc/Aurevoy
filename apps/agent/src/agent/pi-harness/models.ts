import {
  createModels,
  createProvider,
  type ProviderAuth,
  type ProviderStreams,
} from '@earendil-works/pi-ai';
import {
  anthropicMessagesApi,
  azureOpenAIResponsesApi,
  bedrockConverseStreamApi,
  googleGenerativeAIApi,
  googleVertexApi,
  mistralConversationsApi,
  openAICodexResponsesApi,
  openAICompletionsApi,
  openAIResponsesApi,
  type Model as PiModel,
  type Models as PiModels,
} from '@earendil-works/pi-ai/compat';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { config } from '../../config.js';
import { aurevoyCredentialStore } from '../../llm/credential-store.js';
import { readLlmCredential } from '../../llm/llm-store.js';
import { resolveModelApi, resolveModelBaseUrl } from '../../llm/pi-provider.js';
import { xaiGrokOauth } from '../../llm/xai-oauth.js';
import {
  resolveNativeWebSearchModel,
  withNativeWebSearchFallback,
} from './native-web-search.js';

/** 将 Aurevoy 当前模型槽转换成 Pi 的 provider/model 集合。 */
export function createAurevoyPiModels(
  selectedModel: PiModel<any>,
): PiModels {
  const requestBaseUrl = resolveModelBaseUrl(selectedModel.baseUrl, selectedModel.provider);
  const requestApi = resolveModelApi(
    selectedModel.api,
    requestBaseUrl,
    selectedModel.provider,
    selectedModel.id,
  );
  const fallbackModel = {
    ...selectedModel,
    baseUrl: requestBaseUrl || selectedModel.baseUrl,
    api: requestApi as typeof selectedModel.api,
  };
  const nativeSearchModel = resolveNativeWebSearchModel(fallbackModel);
  const modelForRequest = nativeSearchModel ?? fallbackModel;

  const builtin = findBuiltinProvider(modelForRequest.provider);
  const models = createModels({ credentials: aurevoyCredentialStore });
  if (builtin) {
    models.setProvider(createProvider({
      id: builtin.id,
      name: builtin.name || builtin.id,
      baseUrl: modelForRequest.baseUrl || builtin.baseUrl,
      headers: builtin.headers,
      auth: wrapBuiltinAuth(
        augmentProviderAuth(builtin.id, builtin.auth),
        modelForRequest.baseUrl,
        builtin.id,
      ),
      models: [modelForRequest],
      api: getApiForModel(
        modelForRequest,
        nativeSearchModel ? fallbackModel : undefined,
      ),
    }));
    return models;
  }

  models.setProvider(createProvider({
    id: modelForRequest.provider,
    name: modelForRequest.provider,
    baseUrl: modelForRequest.baseUrl,
    auth: {
      apiKey: {
        name: 'Aurevoy API Key',
        resolve: async () => {
          if (!config.llm.apiKey?.trim()) return undefined;
          return {
            auth: {
              apiKey: config.llm.apiKey,
              baseUrl: modelForRequest.baseUrl,
            },
            source: 'settings',
          };
        },
      },
    },
    models: [modelForRequest],
    api: getApiForModel(
      modelForRequest,
      nativeSearchModel ? fallbackModel : undefined,
    ),
  }));
  return models;
}

function findBuiltinProvider(providerId: string) {
  return builtinProviders().find((provider) => provider.id === providerId);
}

/** Pi 未声明 OAuth 时，叠加 Aurevoy 的 provider 扩展。 */
function augmentProviderAuth(providerId: string, auth: ProviderAuth): ProviderAuth {
  if (auth.oauth) return auth;
  return providerId === 'xai' ? { ...auth, oauth: xaiGrokOauth } : auth;
}

/**
 * 保留 Pi 原生 API Key/OAuth，并严格按 model.provider 读取对应凭证槽。
 * 仅 OAuth 的 provider 不注入 API Key 回退。
 */
function wrapBuiltinAuth(
  auth: ProviderAuth,
  requestBaseUrl: string,
  providerId: string,
): ProviderAuth {
  const baseUrl = requestBaseUrl.replace(/\/+$/, '');
  const oauthOnly = Boolean(auth.oauth) && !auth.apiKey;

  const resolveSlotApiKey = (): string | undefined => {
    const credential = readLlmCredential(providerId);
    if (credential?.type === 'api_key') {
      const key = String((credential as { key?: string }).key ?? '').trim();
      if (key) return key;
    }
    if (providerId === config.llm.provider && config.llm.apiKey?.trim()) {
      return config.llm.apiKey.trim();
    }
    return undefined;
  };

  return {
    apiKey: auth.apiKey
      ? {
          ...auth.apiKey,
          resolve: async (input) => {
            const result = await auth.apiKey!.resolve(input);
            if (result) {
              return {
                ...result,
                auth: {
                  ...result.auth,
                  baseUrl: baseUrl || result.auth.baseUrl,
                },
              };
            }
            const slotKey = resolveSlotApiKey();
            return slotKey
              ? {
                  auth: { apiKey: slotKey, baseUrl: baseUrl || undefined },
                  source: 'settings',
                }
              : undefined;
          },
        }
      : oauthOnly
        ? undefined
        : {
            name: 'Aurevoy API Key',
            resolve: async () => {
              const slotKey = resolveSlotApiKey();
              return slotKey
                ? {
                    auth: { apiKey: slotKey, baseUrl: baseUrl || undefined },
                    source: 'settings',
                  }
                : undefined;
            },
          },
    oauth: auth.oauth,
  };
}

function getApiForApiName(api: string) {
  switch (api) {
    case 'anthropic-messages': return anthropicMessagesApi();
    case 'azure-openai-responses': return azureOpenAIResponsesApi();
    case 'bedrock-converse-stream': return bedrockConverseStreamApi();
    case 'google-generative-ai': return googleGenerativeAIApi();
    case 'google-vertex': return googleVertexApi();
    case 'mistral-conversations': return mistralConversationsApi();
    case 'openai-codex-responses': return openAICodexResponsesApi();
    case 'openai-responses': return openAIResponsesApi();
    default: return openAICompletionsApi();
  }
}

/** 在 Provider stream 边界注入 hosted search，并保留原协议/本地工具作为回退。 */
function getApiForModel(
  model: PiModel<any>,
  fallbackModel?: PiModel<any>,
): ProviderStreams {
  const api = getApiForApiName(model.api) as ProviderStreams;
  if (!fallbackModel) return api;
  const fallbackApi = getApiForApiName(fallbackModel.api) as ProviderStreams;
  return withNativeWebSearchFallback(
    api,
    model,
    fallbackApi,
    fallbackModel,
  );
}
