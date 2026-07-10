import { describe, expect, it, afterEach } from "vitest"
import { config } from "../config.js"
import { createPiModel, resolveModelBaseUrl } from "./pi-provider.js"
import { settingsStore } from "../store/db.js"

const originalLlm = { ...config.llm }
const PROVIDERS_KEY = "llm.providers"
let previousProviders: string | undefined

function withLlmConfig(overrides: Partial<typeof config.llm>, fn: () => void): void {
  Object.assign(config.llm, originalLlm, overrides)
  try {
    fn()
  } finally {
    Object.assign(config.llm, originalLlm)
  }
}

function withProviderMap(map: Record<string, { baseUrl: string }>, fn: () => void): void {
  previousProviders = settingsStore.get(PROVIDERS_KEY)
  settingsStore.set(
    PROVIDERS_KEY,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(map).map(([id, slot]) => [
          id,
          {
            baseUrl: slot.baseUrl,
            model: "",
            visionModel: "",
            availableModels: [],
            enabledModels: [],
          },
        ]),
      ),
    ),
  )
  try {
    fn()
  } finally {
    if (previousProviders === undefined) settingsStore.delete(PROVIDERS_KEY)
    else settingsStore.set(PROVIDERS_KEY, previousProviders)
  }
}

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

  it("uses an explicit model override for vision routing", () => {
    withLlmConfig({
      provider: "openai-compatible",
      baseUrl: "https://example.test/v1",
      model: "text-model",
    }, () => {
      const model = createPiModel("vision-model")

      expect(model.id).toBe("vision-model")
      expect(model.name).toBe("vision-model")
    })
  })

  it("applies configured baseUrl to builtin openai models (multi-provider gateway)", () => {
    withLlmConfig({
      provider: "openai",
      baseUrl: "https://gateway.example.test/v1",
      model: "gpt-4o-mini",
    }, () => {
      const model = createPiModel()
      expect(model.baseUrl?.replace(/\/+$/, "")).toBe("https://gateway.example.test/v1")
      // 网关通常只有 chat/completions；不能继续用 catalog 的 responses API
      expect(model.api).toBe("openai-completions")
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

  it("createPiModel with provider override uses that slot for vision routing", () => {
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
