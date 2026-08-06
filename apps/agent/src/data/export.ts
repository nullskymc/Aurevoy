import type {
  DataExportArtifact,
  DataExportKnowledgeBaseDir,
  DataExportMessage,
  DataExportPayload,
  DataExportProject,
  DataExportProviderSlot,
  DataExportSettings,
  DataExportTask,
  DataExportToolCall,
  KbDir,
  KbIndexStatus,
  MemoryEntry,
  Message,
  Project,
  RuntimeSettings,
  Task,
} from '@aurevoy/shared';

export interface BuildDataExportInput {
  appVersion: string;
  exportedAt: string;
  settings: RuntimeSettings;
  projects: Project[];
  memories: MemoryEntry[];
  tasks: Task[];
  kbDirs: KbDir[];
  kbStatus: KbIndexStatus;
  includeTaskMessages: boolean;
}

const REDACTIONS = [
  'API keys, OAuth credentials, MCP JSON, and proxy addresses are excluded.',
  'Configured database, workspace, project, and attachment path fields are excluded; user-authored text may still contain paths.',
  'Image bytes, data URLs, canvas HTML, and rich-content payloads are excluded.',
  'Tool-call arguments and raw task traces are excluded.',
  'User-authored goals, selected task messages, and memory text may contain sensitive content; inspect before sharing.',
] as const;

/**
 * 构建可分享的诊断/迁移 JSON；所有敏感字段在这里显式投影，禁止直接序列化 RuntimeSettings 或 Task。
 */
export function buildDataExportPayload(input: BuildDataExportInput): DataExportPayload {
  return {
    schemaVersion: 1,
    exportedAt: input.exportedAt,
    appVersion: input.appVersion,
    redactions: [...REDACTIONS],
    settings: projectRuntimeSettings(input.settings),
    projects: input.projects.map(projectMetadata),
    memories: input.memories.map(cloneMemory),
    tasks: input.tasks.map((task) => projectTask(task, input.includeTaskMessages)),
    knowledgeBase: {
      dirs: input.kbDirs.map(projectKnowledgeBaseDir),
      status: { ...input.kbStatus },
    },
  };
}

function projectRuntimeSettings(settings: RuntimeSettings): DataExportSettings {
  return {
    llm: {
      provider: settings.llm.provider,
      model: settings.llm.model,
      availableModels: [...settings.llm.availableModels],
      enabledModels: [...settings.llm.enabledModels],
      imageInputModels: [...settings.llm.imageInputModels],
      temperature: settings.llm.temperature,
      timeoutMs: settings.llm.timeoutMs,
      maxTokens: settings.llm.maxTokens,
      apiKeyConfigured: settings.llm.apiKeyConfigured,
      oauthConfigured: settings.llm.oauthConfigured,
      providers: settings.llm.providers.map(projectProviderSlot),
    },
    workspaceConfigured: settings.workspaceDir.trim().length > 0,
    commandExecutionEnabled: settings.commandExecutionEnabled,
    cleanupPolicyDays: settings.cleanupPolicyDays,
    autoModeSafetyEnabled: settings.autoModeSafetyEnabled,
    agentThinkingLevel: settings.agentThinkingLevel,
    agentToolExecution: settings.agentToolExecution,
    agentCacheRetention: settings.agentCacheRetention,
    agentAutoCompact: settings.agentAutoCompact,
    autoResumeInterruptedTasks: settings.autoResumeInterruptedTasks,
    memoryRecallEnabled: settings.memoryRecallEnabled,
    kbRecallEnabled: settings.kbRecallEnabled,
    budget: {
      run: { ...settings.budget.run },
      lifetime: { ...settings.budget.lifetime },
    },
    embedding: {
      provider: settings.embedding.provider,
      model: settings.embedding.model,
      apiKeyConfigured: settings.embedding.apiKeyConfigured,
    },
    search: {
      preferNative: settings.search.preferNative,
      provider: settings.search.provider,
      apiKeyConfigured: settings.search.apiKeyConfigured,
    },
    logging: { level: settings.logging.level },
    proxyEnabled: settings.proxy.enabled,
  };
}

function projectProviderSlot(slot: RuntimeSettings['llm']['providers'][number]): DataExportProviderSlot {
  return {
    provider: slot.provider,
    model: slot.model,
    availableModels: [...slot.availableModels],
    enabledModels: [...slot.enabledModels],
    imageInputModels: [...slot.imageInputModels],
    apiKeyConfigured: slot.apiKeyConfigured,
    oauthConfigured: slot.oauthConfigured,
  };
}

function projectMetadata(project: Project): DataExportProject {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function cloneMemory(memory: MemoryEntry): MemoryEntry {
  return {
    ...memory,
    source: { ...memory.source },
    linkedMemoryIds: memory.linkedMemoryIds ? [...memory.linkedMemoryIds] : undefined,
  };
}

function projectTask(task: Task, includeTaskMessages: boolean): DataExportTask {
  const currentMessages = task.messages.map(projectMessage);
  const archivedMessages = (task.archivedMessages ?? []).map(projectMessage);
  return {
    id: task.id,
    goal: task.goal,
    title: task.title,
    titleSource: task.titleSource,
    status: task.status,
    phase: task.phase,
    plan: task.plan.map((step) => ({ ...step })),
    artifacts: (task.artifacts ?? []).map(projectArtifact),
    tokenUsage: task.tokenUsage ? { ...task.tokenUsage } : undefined,
    budget: task.budget ? { ...task.budget } : undefined,
    budgetUsage: task.budgetUsage ? { ...task.budgetUsage } : undefined,
    lifetimeBudget: task.lifetimeBudget ? { ...task.lifetimeBudget } : undefined,
    lifetimeUsage: task.lifetimeUsage ? { ...task.lifetimeUsage } : undefined,
    projectId: task.projectId,
    automationId: task.automationId,
    parentTaskId: task.parentTaskId,
    executionMode: task.executionMode,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    messageCount: currentMessages.length,
    archivedMessageCount: archivedMessages.length,
    ...(includeTaskMessages ? { messages: currentMessages, archivedMessages } : {}),
  };
}

function projectArtifact(artifact: NonNullable<Task['artifacts']>[number]): DataExportArtifact {
  const { content: _content, appliedPath: _appliedPath, ...metadata } = artifact;
  return metadata;
}

function projectMessage(message: Message): DataExportMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    failure: message.failure ? { ...message.failure } : undefined,
    toolCalls: message.toolCalls?.map(projectToolCall),
    toolCallId: message.toolCallId,
    providerExecuted: message.providerExecuted,
    delivery: message.delivery,
    attachments: message.attachments?.map(({ path: _path, dataUrl: _dataUrl, ...metadata }) => metadata),
    contentBlocks: message.contentBlocks?.map(({ content: _content, props: _props, fallbackText: _fallbackText, ...metadata }) => metadata),
  };
}

function projectToolCall(call: NonNullable<Message['toolCalls']>[number]): DataExportToolCall {
  return {
    id: call.id,
    name: call.function.name,
    summary: call.function.summary,
    planStepId: call.function.planStepId,
    providerExecuted: call.providerExecuted,
  };
}

function projectKnowledgeBaseDir(dir: KbDir): DataExportKnowledgeBaseDir {
  return {
    id: dir.id,
    recursive: dir.recursive,
    enabled: dir.enabled,
    createdAt: dir.createdAt,
    updatedAt: dir.updatedAt,
  };
}
