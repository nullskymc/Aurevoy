import { describe, expect, it } from "vitest"
import { config } from "../config.js"
import { createPiModel } from "./pi-provider.js"

const originalLlm = { ...config.llm }

function withLlmConfig(overrides: Partial<typeof config.llm>, fn: () => void): void {
  Object.assign(config.llm, originalLlm, overrides)
  try {
    fn()
  } finally {
    Object.assign(config.llm, originalLlm)
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
})
