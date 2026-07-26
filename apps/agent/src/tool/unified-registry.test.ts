import { describe, expect, it } from "vitest"
import { unifiedToolRegistry } from "./unified-registry.js"
import { registerEffectTool } from "./effect-bridge.js"
import { make } from "./framework/definition.js"
import { Schema } from "effect"

describe("unifiedToolRegistry schema bridge", () => {
  it("preserves JSON schema structure when exposing Pi tools", async () => {
    const name = `schema_probe_${Date.now()}`
    let executed = false
    unifiedToolRegistry.register({
      name,
      description: "schema probe",
      inputSchema: {
        type: "object",
        required: ["path", "mode", "items"],
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "target path" },
          mode: { enum: ["read", "write"] },
          items: {
            type: "array",
            items: {
              type: "object",
              required: ["count"],
              properties: {
                count: { type: "integer" },
              },
            },
          },
        },
      },
      riskLevel: "safe",
      execute: async () => {
        executed = true
        return { ok: true }
      },
    })

    try {
      const [tool] = unifiedToolRegistry.toAgentTools([name])
      const parameters = tool.parameters as Record<string, unknown>
      expect(parameters.type).toBe("object")
      expect(parameters.additionalProperties).toBe(false)
      expect(parameters.properties).toBeTruthy()

      await expect(tool.execute("call-1", { path: "x", mode: "read", items: [{ count: "bad" }] }))
        .rejects.toThrow(/schema_validation_failed/)
      expect(executed).toBe(false)

      const result = await tool.execute("call-2", { path: "x", mode: "write", items: [{ count: 1 }] })
      expect(result.details).toEqual({ ok: true })
      expect(executed).toBe(true)
    } finally {
      unifiedToolRegistry.unregister(name)
    }
  })
})

describe("Effect bridge metadata", () => {
  it("uses definition metadata, returns encoded output as details, and respects default disablement", async () => {
    const name = `metadata_probe_${Date.now()}`
    const probe = make({
      name,
      description: "metadata probe",
      riskLevel: "dangerous",
      executionPolicy: { parallelizable: false },
      enabledByDefault: false,
      input: Schema.Struct({ value: Schema.String }),
      output: Schema.Struct({ contentBlock: Schema.Struct({ type: Schema.String, content: Schema.String }) }),
      execute: async (input) => ({ contentBlock: { type: "link", content: input.value } }),
    })
    registerEffectTool(probe)
    try {
      expect(unifiedToolRegistry.get(name)).toMatchObject({ riskLevel: "dangerous", executionPolicy: { parallelizable: false } })
      expect(unifiedToolRegistry.isEnabled(name)).toBe(false)
      unifiedToolRegistry.setEnabled(name, true)
      const [tool] = unifiedToolRegistry.toAgentTools([name])
      expect(tool.executionMode).toBe("sequential")
      await expect(tool.execute("metadata-call", { value: "https://example.com" })).resolves.toMatchObject({
        details: { contentBlock: { type: "link", content: "https://example.com" } },
      })
    } finally {
      unifiedToolRegistry.unregister(name)
    }
  })
})
