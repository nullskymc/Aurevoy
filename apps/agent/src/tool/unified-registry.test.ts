import { describe, expect, it } from "vitest"
import { unifiedToolRegistry } from "./unified-registry.js"

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
