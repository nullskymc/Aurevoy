import { toolRegistry as oldRegistry } from "../tools/registry.js"
import { NEW_TOOLS } from "../agent/register-new-tools.js"
import type { Tool } from "../tools/registry.js"

for (const entry of NEW_TOOLS) {
  if (oldRegistry.listAll().find((t) => t.name === entry.name)) continue

  const tool: Tool = {
    descriptor: {
      name: entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
      riskLevel: entry.riskLevel,
      executionPolicy: entry.executionPolicy,
      source: { type: "builtin" },
    },
    execute: async (args, context) => {
      return entry.execute(args, context ?? { workspaceDir: "" })
    },
  }
  oldRegistry.register(tool)
}
