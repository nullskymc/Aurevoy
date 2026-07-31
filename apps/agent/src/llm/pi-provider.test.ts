import { describe, expect, it, afterEach } from "vitest"
import { config } from "../config.js"
import {
  assertPiLLMConfigured,
  createPiModel,
  getLlmReadiness,
  getPiProviderName,
  hasPiLLMCredential,
  hasPiLLMModel,
  isPiLLMConfigured,
  resolveModelApi,
  resolveModelBaseUrl,
} from "./pi-provider.js"
import {
  ensureLlmSchemaMigrated,
  getLlmProvider,
  upsertLlmProvider,
} from "./llm-store.js"

const originalLlm = { ...config.llm }

function withLlmConfig(overrides: Partial<typeof config.llm>, fn: () => void): void {
  Object.assign(config.llm, originalLlm, overrides)
  try {
    fn()
  } finally {
    Object.assign(config.llm, originalLlm)
  }
}

/**
 * 通过 llm-store / SQLite 槽位写入 baseUrl（生产路径），并在结束后恢复。
 * 旧 KV `llm.providers` 已不再被 resolveModelBaseUrl 读取。
 */
function withProviderMap(map: Record<string, { baseUrl: string }>, fn: () => void): void {
  ensureLlmSchemaMigrated()
  const previous = new Map<string, { baseUrl: string; existed: boolean }>()
  for (const [id, slot] of Object.entries(map)) {
    const cur = getLlmProvider(id)
    previous.set(id, { baseUrl: cur?.baseUrl ?? "", existed: Boolean(cur) })
    upsertLlmProvider(id, { baseUrl: slot.baseUrl })
  }
  try {
    fn()
  } finally {
    for (const [id, prev] of previous) {
      // 仅恢复 baseUrl；测试不删除可能被 ensureProviderRow 新建的行，
      // 避免误删用户本机真实 provider 记录之外的副作用扩大。
      upsertLlmProvider(id, { baseUrl: prev.baseUrl })
    }
  }
}

describe("isPiLLMConfigured model guard", () => {
  it("treats empty model as unconfigured even when api key is set", () => {
    withLlmConfig({
      provider: "deepseek",
      apiKey: "sk-test",
      model: "",
    }, () => {
      expect(hasPiLLMCredential()).toBe(true)
      expect(hasPiLLMModel()).toBe(false)
      expect(isPiLLMConfigured()).toBe(false)
      expect(getPiProviderName()).toBe("unconfigured")
      expect(getLlmReadiness()).toMatchObject({
        state: "no_model",
        ready: false,
        provider: "deepseek",
        model: "",
      })
      expect(() => assertPiLLMConfigured()).toThrow(/未选择模型/)
    })
  })

  it("requires non-whitespace model id", () => {
    withLlmConfig({
      provider: "deepseek",
      apiKey: "sk-test",
      model: "   ",
    }, () => {
      expect(isPiLLMConfigured()).toBe(false)
      expect(getLlmReadiness().state).toBe("no_model")
      expect(() => assertPiLLMConfigured()).toThrow(/未选择模型/)
    })
  })

  it("distinguishes missing credential from missing model", () => {
    withLlmConfig({
      provider: "deepseek",
      apiKey: "",
      model: "deepseek-v4-flash",
    }, () => {
      // 无内存 key 时仍可能命中本机 CredentialStore；只断言「有 model」时 state 不是 no_model
      const readiness = getLlmReadiness()
      if (!hasPiLLMCredential()) {
        expect(readiness.state).toBe("no_credential")
        expect(() => assertPiLLMConfigured()).toThrow(/未配置 LLM 凭证/)
      }
    })
  })

  it("is configured when key and model are both set", () => {
    withLlmConfig({
      provider: "deepseek",
      apiKey: "sk-test",
      model: "deepseek-v4-flash",
    }, () => {
      expect(isPiLLMConfigured()).toBe(true)
      expect(getPiProviderName()).toBe("deepseek:deepseek-v4-flash")
      expect(getLlmReadiness()).toMatchObject({
        state: "ready",
        ready: true,
        provider: "deepseek",
        model: "deepseek-v4-flash",
      })
      expect(() => assertPiLLMConfigured()).not.toThrow()
    })
  })
})

describe("createPiModel", () => {
  it("marks custom Qwen-compatible thinking models as reasoning replay compatible", () => {
    withLlmConfig({
      provider: "openai-compatible",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen3-coder-plus",
    }, () => {
      const model = createPiModel()
      const compat = model.compat as Record<string, unknown>

      expect(model.api).toBe("openai-completions")
      expect(model.provider).toBe("openai-compatible")
      expect(model.reasoning).toBe(true)
      expect(compat.requiresReasoningContentOnAssistantMessages).toBe(true)
      expect(compat.thinkingFormat).toBe("qwen-chat-template")
    })
  })

  it("marks custom DeepSeek-style thinking models as reasoning replay compatible", () => {
    withLlmConfig({
      provider: "openai-compatible",
      baseUrl: "https://example.test/v1",
      model: "deepseek-r1-custom",
    }, () => {
      const model = createPiModel()
      const compat = model.compat as Record<string, unknown>

      expect(model.api).toBe("openai-completions")
      expect(model.reasoning).toBe(true)
      expect(compat.requiresReasoningContentOnAssistantMessages).toBe(true)
      expect(compat.thinkingFormat).toBe("deepseek")
    })
  })

  it("uses an explicit model override", () => {
    withLlmConfig({
      provider: "openai-compatible",
      baseUrl: "https://example.test/v1",
      model: "text-model",
    }, () => {
      const model = createPiModel("override-model")

      expect(model.id).toBe("override-model")
      expect(model.name).toBe("override-model")
      expect(model.input).toEqual(["text"])
    })
  })

  it("applies configured baseUrl to builtin openai models (multi-provider gateway)", () => {
    withLlmConfig({
      provider: "openai",
      baseUrl: "https://gateway.example.test/v1",
      model: "gpt-4o-mini",
    }, () => {
      withProviderMap({
        openai: { baseUrl: "https://gateway.example.test/v1" },
      }, () => {
        const model = createPiModel()
        expect(model.baseUrl?.replace(/\/+$/, "")).toBe("https://gateway.example.test/v1")
        // 网关通常只有 chat/completions；不能继续用 catalog 的 responses API
        expect(model.api).toBe("openai-completions")
      })
    })
  })

  it("never downgrades openai-codex to chat/completions (Cloudflare 403 trap)", () => {
    withLlmConfig({
      provider: "openai-codex",
      // 用户可能保存了 catalog 默认 baseUrl，或留空回落到 catalog
      baseUrl: "https://chatgpt.com/backend-api",
      model: "gpt-5.4",
    }, () => {
      const model = createPiModel()
      expect(model.api).toBe("openai-codex-responses")
      expect(model.provider).toBe("openai-codex")
    })
  })

  it("keeps openai-codex api even when baseUrl is empty (catalog default)", () => {
    withLlmConfig({
      provider: "openai-codex",
      baseUrl: "",
      model: "gpt-5.4",
    }, () => {
      const model = createPiModel()
      expect(model.api).toBe("openai-codex-responses")
    })
  })
})

describe("DeepSeek Responses API routing", () => {
  afterEach(() => {
    Object.assign(config.llm, originalLlm)
  })

  it("routes official DeepSeek flash to the Responses API (completions retired)", () => {
    withLlmConfig({
      provider: "deepseek",
      apiKey: "sk-test",
      baseUrl: "",
      model: "deepseek-v4-flash",
    }, () => {
      withProviderMap({
        deepseek: { baseUrl: "" },
      }, () => {
        const model = createPiModel()
        expect(model.provider).toBe("deepseek")
        expect(model.baseUrl?.replace(/\/+$/, "")).toBe("https://api.deepseek.com")
        expect(model.api).toBe("openai-responses")
        expect(model.reasoning).toBe(true)
      })
    })
  })

  it("routes all official DeepSeek models to the Responses API (completions retired)", () => {
    withLlmConfig({
      provider: "deepseek",
      apiKey: "sk-test",
      baseUrl: "",
      model: "deepseek-v4-pro",
    }, () => {
      withProviderMap({
        deepseek: { baseUrl: "" },
      }, () => {
        const model = createPiModel()
        expect(model.provider).toBe("deepseek")
        // v4-pro 在 DeepSeek 开放前由上游明确报错，不再降级到 chat/completions
        expect(model.api).toBe("openai-responses")
      })
    })
  })

  it("routes a custom openai-compatible slot at the official host to Responses", () => {
    withLlmConfig({
      provider: "openai-compatible",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-flash",
    }, () => {
      withProviderMap({
        deepseek: { baseUrl: "" },
      }, () => {
        const model = createPiModel()
        // 官方主机经 host 推断为 deepseek 内置 provider
        expect(model.provider).toBe("deepseek")
        expect(model.api).toBe("openai-responses")
      })
    })
  })

  it("does not force Responses when a deepseek slot overrides a gateway baseUrl", () => {
    withLlmConfig({
      provider: "deepseek",
      apiKey: "sk-test",
      baseUrl: "https://deepseek-gateway.example.test/v1",
      model: "deepseek-v4-flash",
    }, () => {
      withProviderMap({
        deepseek: { baseUrl: "https://deepseek-gateway.example.test/v1" },
      }, () => {
        const model = createPiModel()
        expect(model.provider).toBe("deepseek")
        expect(model.api).toBe("openai-completions")
      })
    })
  })

  it("does not force Responses on third-party gateways serving deepseek models", () => {
    withLlmConfig({
      provider: "openai-compatible",
      baseUrl: "https://gateway.example.test/v1",
      model: "deepseek-v4-flash",
    }, () => {
      const model = createPiModel()
      const compat = model.compat as Record<string, unknown>
      expect(model.provider).toBe("openai-compatible")
      expect(model.api).toBe("openai-completions")
      expect(model.reasoning).toBe(true)
      expect(compat.requiresReasoningContentOnAssistantMessages).toBe(true)
    })
  })

  it("respects an explicit DeepSeek Anthropic-compatible endpoint", () => {
    withLlmConfig({
      provider: "deepseek",
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com/anthropic",
      model: "deepseek-v4-flash",
    }, () => {
      withProviderMap({
        deepseek: { baseUrl: "https://api.deepseek.com/anthropic" },
      }, () => {
        const model = createPiModel()
        expect(model.api).toBe("anthropic-messages")
      })
    })
  })

  it("keeps deepseek Responses api when Pi catalog later declares it directly", () => {
    // 未来目录直接声明 openai-responses（如 v4-pro 开放后）时不得被非官方主机规则降级
    expect(resolveModelApi("openai-responses", "https://api.deepseek.com", "deepseek", "deepseek-v4-pro"))
      .toBe("openai-responses")
  })
})

describe("resolveModelBaseUrl provider isolation", () => {
  afterEach(() => {
    Object.assign(config.llm, originalLlm)
  })

  it("uses empty opencode-go slot baseUrl over polluted flat config", () => {
    withLlmConfig({
      provider: "opencode-go",
      // 扁平字段被 openai-compatible 残留污染
      baseUrl: "https://newapi.example.test/v1",
      model: "mimo-v2.5",
    }, () => {
      withProviderMap({
        "openai-compatible": { baseUrl: "https://newapi.example.test/v1" },
        "opencode-go": { baseUrl: "" },
      }, () => {
        // 空槽 = 使用 catalog 默认，而不是扁平 newapi
        expect(resolveModelBaseUrl("https://opencode.ai/zen/go/v1", "opencode-go")).toBe(
          "https://opencode.ai/zen/go/v1",
        )
        expect(resolveModelBaseUrl(undefined, "openai-compatible")).toBe(
          "https://newapi.example.test/v1",
        )
      })
    })
  })

  it("createPiModel for opencode-go ignores flat gateway when slot baseUrl is empty", () => {
    withLlmConfig({
      provider: "opencode-go",
      baseUrl: "https://newapi.example.test/v1",
      model: "mimo-v2.5",
    }, () => {
      withProviderMap({
        "opencode-go": { baseUrl: "" },
      }, () => {
        const model = createPiModel()
        expect(model.provider).toBe("opencode-go")
        expect(model.baseUrl?.replace(/\/+$/, "")).toBe("https://opencode.ai/zen/go/v1")
      })
    })
  })

  it("createPiModel with provider override uses that provider slot", () => {
    withLlmConfig({
      provider: "openai-codex",
      baseUrl: "",
      model: "gpt-5.5",
    }, () => {
      withProviderMap({
        "openai-codex": { baseUrl: "" },
        "opencode-go": { baseUrl: "" },
      }, () => {
        const model = createPiModel("mimo-v2.5", "opencode-go")
        expect(model.provider).toBe("opencode-go")
        expect(model.id).toBe("mimo-v2.5")
        expect(model.baseUrl?.replace(/\/+$/, "")).toBe("https://opencode.ai/zen/go/v1")
      })
    })
  })
})
