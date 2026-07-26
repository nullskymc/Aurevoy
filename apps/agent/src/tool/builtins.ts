import { Effect, Layer } from "effect"
import { readTool } from "./tools/read/index.js"
import { writeTool } from "./tools/write/index.js"
import { editTool } from "./tools/edit/index.js"
import { grepTool } from "./tools/grep/index.js"
import { globTool } from "./tools/glob/index.js"
import { bashTool } from "./tools/bash/index.js"
import { webSearchTool } from "./tools/web-search/index.js"
import { webFetchTool } from "./tools/web-fetch/index.js"
import { askUserTool } from "./tools/ask-user/index.js"
import { rememberTool } from "./tools/memory/index.js"
import { runDreamsTool } from "./tools/memory/index.js"
import { indexFilesTool, recallTool } from './tools/knowledge/index.js'
import { attachContentTool, presentUiTool } from './tools/presentation/index.js'
import { copyFileTool, deleteFileTool, getCurrentTimeTool, listDirectoryTool, moveFileTool, renameFileTool } from './tools/workspace/index.js'
import { createArtifactTool, applyArtifactTool } from "./tools/artifact/index.js"
import { delegateTool } from "./tools/delegate/index.js"
import { bundleReportTool } from "./tools/bundle-report/index.js"
import { updatePlanTool } from "./tools/update-plan/index.js"
import { ToolRegistry, toolRegistryLayer } from "./framework/index.js"

export const allTools = [
  readTool,
  writeTool,
  editTool,
  grepTool,
  globTool,
  bashTool,
  webSearchTool,
  webFetchTool,
  askUserTool,
  rememberTool,
  runDreamsTool,
  indexFilesTool,
  recallTool,
  attachContentTool,
  presentUiTool,
  getCurrentTimeTool,
  listDirectoryTool,
  copyFileTool,
  moveFileTool,
  renameFileTool,
  deleteFileTool,
  createArtifactTool,
  applyArtifactTool,
  delegateTool,
  bundleReportTool,
  updatePlanTool,
]

export const builtinsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* ToolRegistry
    yield* registry.register(allTools)
  }),
).pipe(Layer.provide(toolRegistryLayer))
