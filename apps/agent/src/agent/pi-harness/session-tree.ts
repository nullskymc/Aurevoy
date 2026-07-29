import { createHash } from 'node:crypto';
import {
  collectEntriesForBranchSummary,
  generateBranchSummary,
  InMemorySessionStorage,
  Session,
  type AgentMessage,
  type SessionTreeEntry,
} from '@earendil-works/pi-agent-core';
import type {
  Message,
  MessageRole,
  PiSessionTreeNavigateResponse,
  PiSessionTreeNode,
  PiSessionTreeResponse,
  Task,
} from '@aurevoy/shared';
import { createPiModel } from '../../llm/pi-provider.js';
import { piSessionTreeStore, taskStore } from '../../store/db.js';
import { createAurevoyPiModels } from './models.js';
import { mergeDurableTaskMessages } from './durable-message-merge.js';

const PI_SESSION_TREE_VERSION = 2;

interface PiSessionTreeMessageLink {
  /** Aurevoy 产品消息 ID。 */
  messageId: string;
  /** 与该产品消息对应的 Pi session entry ID。 */
  entryId: string;
}

export interface PiSessionSeedMessage {
  sourceMessageId: string;
  message: AgentMessage;
}

export interface PiSessionTreeHandle {
  session: Session;
  /** 是否恢复了先前保存的 Pi 树；false 表示根据当前 Task 消息重新建立线性根路径。 */
  reusedSnapshot: boolean;
  /** 上次快照已经覆盖的 Aurevoy 消息数量，用于判断本 run 是否有新用户输入。 */
  persistedMessageCount: number;
  persist(task: Task): Promise<void>;
}

/**
 * 打开任务的 Pi 会话树。
 *
 * 只有当前消息 ID 仍以旧快照为前缀时才恢复树。revert、编辑或历史修复导致
 * 前缀变化时安全重建，避免把错误 leaf 上的上下文交给模型。
 */
export function openPiSessionTree(
  task: Task,
  seedMessages: PiSessionSeedMessage[],
): PiSessionTreeHandle {
  const snapshot = piSessionTreeStore.get(task.id);
  const currentMessageIds = task.messages.map((message) => message.id);
  const persistedMessageIds = snapshot?.messageIds ?? [];
  const snapshotMatchesTask =
    snapshot?.version === PI_SESSION_TREE_VERSION &&
    !task.messages.some((message) => (message.imageParts?.length ?? 0) > 0) &&
    snapshot.entries.every(isSessionTreeEntry) &&
    snapshot.messageCount === persistedMessageIds.length &&
    currentMessageIds.length >= persistedMessageIds.length &&
    persistedMessageIds.every((id, index) => currentMessageIds[index] === id);

  const entries = snapshotMatchesTask
    ? snapshot.entries as SessionTreeEntry[]
    : buildSeedEntries(seedMessages);
  let messageLinks: PiSessionTreeMessageLink[] = snapshotMatchesTask
    ? snapshot!.messageLinks
    : [];
  const storage = new InMemorySessionStorage({
    metadata: {
      id: task.id,
      createdAt: task.createdAt,
    },
    entries,
  });
  const session = new Session(storage);

  return {
    session,
    reusedSnapshot: snapshotMatchesTask,
    persistedMessageCount: snapshotMatchesTask ? snapshot!.messageCount : seedMessages.length,
    persist: async (currentTask) => {
      const currentEntries = (await session.getEntries()).map(sanitizeEntryForStorage);
      // 运行中 steering/follow-up 由 HTTP 路径先写入 SQLite；runtime 手里的 Task
      // 可能尚未同步，因此映射始终以最新耐久消息为产品真相。
      const durableMessages = mergeDurableTaskMessages(
        taskStore.get(currentTask.id)?.messages ?? [],
        currentTask.messages,
      );
      const activeBranch = await session.getBranch();
      messageLinks = reconcileMessageLinks(durableMessages, activeBranch, messageLinks);
      piSessionTreeStore.save(currentTask.id, {
        version: PI_SESSION_TREE_VERSION,
        entries: currentEntries,
        messageCount: durableMessages.length,
        messageIds: durableMessages.map((message) => message.id),
        messageLinks,
      });
    },
  };
}

/**
 * Pi entry 可能携带 base64 图片；快照只保存树结构和文本上下文。
 * 图片真相仍在 message_parts，含图片的任务下次 run 会从 Task 重建，不复用该快照。
 */
function sanitizeEntryForStorage(entry: SessionTreeEntry): SessionTreeEntry {
  if (entry.type === 'message') {
    return { ...entry, message: sanitizeAgentMessage(entry.message) };
  }
  if (entry.type === 'custom_message') {
    return { ...entry, content: sanitizeContent(entry.content) };
  }
  if (entry.type === 'compaction' && entry.retainedTail) {
    return {
      ...entry,
      retainedTail: entry.retainedTail.map(sanitizeAgentMessage),
    };
  }
  return entry;
}

function sanitizeAgentMessage(message: AgentMessage): AgentMessage {
  if (!('content' in message)) return message;
  return {
    ...message,
    content: sanitizeContent(message.content),
  } as AgentMessage;
}

function sanitizeContent<T>(content: T): T {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (
      typeof block === 'object' &&
      block !== null &&
      'type' in block &&
      block.type === 'image'
    ) {
      return {
        type: 'text',
        text: '[Image omitted from Pi session-tree snapshot; source retained in Task message parts.]',
      };
    }
    return block;
  }) as T;
}

/** 读取供 API/UI 展示的安全树投影，不返回完整提示词、图片或工具结果。 */
export async function getPiSessionTreeResponse(taskId: string): Promise<PiSessionTreeResponse> {
  const snapshot = piSessionTreeStore.get(taskId);
  const task = taskStore.get(taskId);
  if (!snapshot || !task) {
    return { taskId, leafId: null, nodes: [] };
  }

  const entries = snapshot.entries.filter(isSessionTreeEntry);
  const storage = new InMemorySessionStorage({ entries });
  const session = new Session(storage);
  const links = snapshot.messageLinks.length > 0
    ? snapshot.messageLinks
    : reconcileMessageLinks(task.messages, await session.getBranch(), []);
  return buildProductTreeResponse(taskId, task.messages, entries, links, await storage.getLeafId(), snapshot.updatedAt);
}

/**
 * 将当前 leaf 切换到历史节点，并把该分支投影回 Task.messages。
 * 工作区文件不会回滚；该操作只改变后续模型可见的对话分支。
 */
export async function navigatePiSessionTree(
  task: Task,
  targetId: string,
  options: { summarize?: boolean; customInstructions?: string } = {},
): Promise<PiSessionTreeNavigateResponse> {
  if (task.messages.some((message) => (message.imageParts?.length ?? 0) > 0)) {
    throw new Error('含图片的会话暂不支持树导航；图片仍由 message_parts 独立保存。');
  }

  const snapshot = piSessionTreeStore.get(task.id);
  if (!snapshot || (snapshot.version !== 1 && snapshot.version !== PI_SESSION_TREE_VERSION)) {
    throw new Error('当前任务还没有可导航的 Pi 会话树。');
  }
  const entries = snapshot.entries.filter(isSessionTreeEntry);
  const storage = new InMemorySessionStorage({
    metadata: { id: task.id, createdAt: task.createdAt },
    entries,
  });
  const session = new Session(storage);
  const links = snapshot.messageLinks.length > 0
    ? snapshot.messageLinks
    : reconcileMessageLinks(task.messages, await session.getBranch(), []);
  const targetLink = links.find((link) => link.messageId === targetId);
  const target = targetLink ? await session.getEntry(targetLink.entryId) : undefined;
  if (!target) throw new Error('会话树节点不存在。');
  if (!isNavigableEntry(target)) {
    throw new Error('只有用户消息可以作为会话切换节点。');
  }

  let branchSummary:
    | { summary: string; details?: unknown; usage?: import('@earendil-works/pi-ai/compat').Usage }
    | undefined;
  if (options.summarize) {
    const oldLeafId = await session.getLeafId();
    const collected = await collectEntriesForBranchSummary(session, oldLeafId, target.id);
    if (collected.entries.length > 0) {
      const model = createPiModel(task.modelSnapshot?.model, task.modelSnapshot?.provider);
      const generated = await generateBranchSummary(collected.entries, {
        models: createAurevoyPiModels(model),
        model,
        signal: new AbortController().signal,
        customInstructions: options.customInstructions,
      });
      if (!generated.ok) throw new Error(`生成分支摘要失败：${generated.error.message}`);
      branchSummary = {
        summary: generated.value.summary,
        details: {
          readFiles: generated.value.readFiles,
          modifiedFiles: generated.value.modifiedFiles,
        },
        usage: generated.value.usage,
      };
    }
  }
  await session.moveTo(target.id, branchSummary);
  const branchEntries = await session.getBranch();
  const projectedMessages = projectLinkedBranchMessages(branchEntries, links, task.messages);
  if (projectedMessages.length === 0) {
    throw new Error('目标节点没有可恢复的对话消息。');
  }

  task.messages = projectedMessages;
  task.archivedMessages = [];
  task.pendingApprovals = [];
  // 切换完成后任务处于“可继续”状态，而不是审批暂停；前端既可直接续跑，
  // 也可让用户输入新的消息，从所选 leaf 创建下一条分支。
  task.status = 'pending';
  task.phase = null;
  task.updatedAt = new Date().toISOString();
  taskStore.save(task);
  piSessionTreeStore.save(task.id, {
    version: PI_SESSION_TREE_VERSION,
    entries: (await session.getEntries()).map(sanitizeEntryForStorage),
    messageCount: task.messages.length,
    messageIds: task.messages.map((message) => message.id),
    messageLinks: links,
  });

  return {
    task,
    tree: await getPiSessionTreeResponse(task.id),
  };
}

/** 为产品消息节点写入/清除 Pi LabelEntry，并保存完整树快照。 */
export async function setPiSessionTreeLabel(
  taskId: string,
  targetId: string,
  label: string | undefined,
): Promise<PiSessionTreeResponse> {
  const snapshot = piSessionTreeStore.get(taskId);
  const task = taskStore.get(taskId);
  if (!snapshot || !task) throw new Error('当前任务还没有可标记的 Pi 会话树。');
  const entries = snapshot.entries.filter(isSessionTreeEntry);
  const storage = new InMemorySessionStorage({ entries });
  const session = new Session(storage);
  const links = snapshot.messageLinks.length > 0
    ? snapshot.messageLinks
    : reconcileMessageLinks(task.messages, await session.getBranch(), []);
  const target = links.find((link) => link.messageId === targetId);
  if (!target) throw new Error('会话树节点不存在。');
  await session.appendLabel(target.entryId, label?.trim() || undefined);
  piSessionTreeStore.save(taskId, {
    version: PI_SESSION_TREE_VERSION,
    entries: (await session.getEntries()).map(sanitizeEntryForStorage),
    messageCount: snapshot.messageCount,
    messageIds: snapshot.messageIds,
    messageLinks: links,
  });
  return await getPiSessionTreeResponse(taskId);
}

/** 把会话执行模式变化写成可审计树节点；没有树快照时由下一次 run 建树。 */
export async function recordPiSessionExecutionMode(
  taskId: string,
  mode: 'auto' | 'plan',
): Promise<boolean> {
  const snapshot = piSessionTreeStore.get(taskId);
  if (!snapshot) return false;
  const storage = new InMemorySessionStorage({
    metadata: { id: taskId, createdAt: snapshot.updatedAt },
    entries: snapshot.entries.filter(isSessionTreeEntry),
  });
  const session = new Session(storage);
  await session.appendCustomMessageEntry(
    'execution_mode_change',
    `Execution mode: ${mode}`,
    true,
    { mode },
  );
  piSessionTreeStore.save(taskId, {
    version: PI_SESSION_TREE_VERSION,
    entries: (await session.getEntries()).map(sanitizeEntryForStorage),
    messageCount: snapshot.messageCount,
    messageIds: snapshot.messageIds,
    messageLinks: snapshot.messageLinks,
  });
  return true;
}

function buildSeedEntries(seedMessages: PiSessionSeedMessage[]): SessionTreeEntry[] {
  const entries: SessionTreeEntry[] = [];
  const usedIds = new Set<string>();
  let parentId: string | null = null;

  for (const seed of seedMessages) {
    const id = uniqueEntryId(seed.sourceMessageId, usedIds);
    entries.push({
      type: 'message',
      id,
      parentId,
      timestamp: new Date(seed.message.timestamp).toISOString(),
      message: seed.message,
    });
    usedIds.add(id);
    parentId = id;
  }
  return entries;
}

function isNavigableEntry(entry: SessionTreeEntry): boolean {
  // 产品层只允许从用户输入重新分支。assistant 工具调用节点可能尚未拥有
  // 配对的 toolResult，从这些中间态恢复会形成不完整的模型上下文。
  return entry.type === 'message' && entry.message.role === 'user';
}

/**
 * 将 Aurevoy 产品消息与当前 Pi 分支逐条对齐。
 *
 * Pi 分支中还包含 completion gate、max-steps 等内部 user 消息；它们在
 * Task.messages 中没有对应项，因此不会获得 link，也不会进入产品会话树。
 */
function reconcileMessageLinks(
  messages: Message[],
  branchEntries: SessionTreeEntry[],
  existing: PiSessionTreeMessageLink[],
): PiSessionTreeMessageLink[] {
  const validEntryIds = new Set(branchEntries.map((entry) => entry.id));
  const linksByMessageId = new Map(existing.map((link) => [link.messageId, link]));
  const linkedEntryIds = new Set(existing.map((link) => link.entryId));
  let cursor = 0;

  for (const message of messages) {
    const current = linksByMessageId.get(message.id);
    if (current && validEntryIds.has(current.entryId)) {
      const index = branchEntries.findIndex((entry) => entry.id === current.entryId);
      if (index >= cursor) cursor = index + 1;
      continue;
    }
    for (let index = cursor; index < branchEntries.length; index++) {
      const entry = branchEntries[index];
      if (linkedEntryIds.has(entry.id) || !entryMatchesProductMessage(entry, message)) continue;
      const link = { messageId: message.id, entryId: entry.id };
      linksByMessageId.set(message.id, link);
      linkedEntryIds.add(entry.id);
      cursor = index + 1;
      break;
    }
  }

  // 保留其他历史分支的既有映射；新增映射按 Pi entry 顺序附加。
  const entryOrder = new Map(branchEntries.map((entry, index) => [entry.id, index]));
  const added = [...linksByMessageId.values()].filter((link) =>
    !existing.some((candidate) => candidate.messageId === link.messageId),
  ).sort((a, b) => (entryOrder.get(a.entryId) ?? 0) - (entryOrder.get(b.entryId) ?? 0));
  return [...existing, ...added];
}

function entryMatchesProductMessage(entry: SessionTreeEntry, message: Message): boolean {
  if (entry.type !== 'message') return false;
  const piMessage = entry.message;
  if (message.role === 'user') {
    if (piMessage.role !== 'user') return false;
    const piText = contentText(piMessage.content).trim();
    const productText = message.content.trim();
    return piText === productText || piText.endsWith(`\n\n${productText}`);
  }
  if (message.role === 'assistant') {
    if (piMessage.role !== 'assistant') return false;
    const projected = projectEntryToMessage(entry);
    if (!projected) return false;
    if (projected.content !== message.content) return false;
    const projectedCalls = projected.toolCalls ?? [];
    const productCalls = message.toolCalls ?? [];
    return projectedCalls.length === productCalls.length && projectedCalls.every((call, index) => (
      call.id === productCalls[index]?.id &&
      call.function.name === productCalls[index]?.function.name
    ));
  }
  if (message.role === 'tool') {
    return piMessage.role === 'toolResult' && piMessage.toolCallId === message.toolCallId;
  }
  return false;
}

function projectLinkedBranchMessages(
  entries: SessionTreeEntry[],
  links: PiSessionTreeMessageLink[],
  currentMessages: Message[],
): Message[] {
  const linkByEntryId = new Map(links.map((link) => [link.entryId, link]));
  const currentById = new Map(currentMessages.map((message) => [message.id, message]));
  const reusable = new Map<string, Message[]>();
  for (const message of currentMessages) {
    const signature = messageSignature(message);
    reusable.set(signature, [...(reusable.get(signature) ?? []), message]);
  }

  const result: Message[] = [];
  for (const entry of entries) {
    const link = linkByEntryId.get(entry.id);
    if (!link) continue;
    const projected = projectEntryToMessage(entry);
    if (!projected) continue;
    projected.id = link.messageId;
    const byId = currentById.get(link.messageId);
    if (byId) {
      result.push(byId);
      continue;
    }
    const signature = messageSignature(projected);
    const existing = reusable.get(signature)?.shift();
    result.push(existing ?? projected);
  }
  return result;
}

function buildProductTreeResponse(
  taskId: string,
  messages: Message[],
  entries: SessionTreeEntry[],
  links: PiSessionTreeMessageLink[],
  piLeafId: string | null,
  updatedAt?: string,
): PiSessionTreeResponse {
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const linkByEntryId = new Map(links.map((link) => [link.entryId, link]));
  const productById = new Map(messages.map((message) => [message.id, message]));
  const labels = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== 'label') continue;
    if (entry.label) labels.set(entry.targetId, entry.label);
    else labels.delete(entry.targetId);
  }
  const publicId = (entryId: string): string =>
    linkByEntryId.get(entryId)?.messageId ?? safeSessionEntryId(entryId);
  const visibleEntry = (entry: SessionTreeEntry): boolean =>
    entry.type === 'message'
      ? (() => {
          const link = linkByEntryId.get(entry.id);
          if (!link) return false;
          const role = productById.get(link.messageId)?.role ?? toAurevoyRole(entry.message.role);
          return role === 'user' || role === 'assistant';
        })()
      : entry.type === 'branch_summary'
        || entry.type === 'compaction'
        || entry.type === 'custom_message'
        || entry.type === 'model_change'
        || entry.type === 'thinking_level_change'
        || entry.type === 'active_tools_change';
  const nearestVisibleParent = (entry: SessionTreeEntry): string | null => {
    let parentId = entry.parentId;
    while (parentId) {
      const parent = entryById.get(parentId);
      if (parent && visibleEntry(parent)) return publicId(parentId);
      parentId = parent?.parentId ?? null;
    }
    return null;
  };

  const nodes: PiSessionTreeNode[] = [];
  for (const entry of entries) {
    if (!visibleEntry(entry)) continue;
    const link = linkByEntryId.get(entry.id);
    const product = link ? productById.get(link.messageId) : undefined;
    const projected = projectTreeNode(entry, labels);
    const role = product?.role ?? projected.role;
    nodes.push({
      id: publicId(entry.id),
      parentId: nearestVisibleParent(entry),
      type: entry.type,
      timestamp: product?.createdAt ?? entry.timestamp,
      role,
      preview: truncatePreview(product?.content ?? projected.preview ?? ''),
      label: labels.get(entry.id),
      navigable: role === 'user',
    });
  }

  let leafId: string | null = null;
  let cursor = piLeafId;
  while (cursor) {
    const link = linkByEntryId.get(cursor);
    if (link) {
      const entry = entryById.get(cursor);
      const role = productById.get(link.messageId)?.role
        ?? (entry ? projectTreeNode(entry, new Map()).role : undefined);
      if (role === 'user' || role === 'assistant') {
        leafId = link.messageId;
        break;
      }
    }
    cursor = entryById.get(cursor)?.parentId ?? null;
  }
  return { taskId, leafId, nodes, updatedAt };
}

/** 不把 Pi 私有 entry id 暴露给产品 API，同时保持节点 id 跨读取稳定。 */
function safeSessionEntryId(entryId: string): string {
  return `entry-${createHash('sha256').update(entryId).digest('hex').slice(0, 16)}`;
}

function projectEntryToMessage(entry: SessionTreeEntry): Message | null {
  if (entry.type === 'branch_summary') {
    return {
      id: entry.id,
      role: 'system',
      content: `[分支摘要]\n${entry.summary}`,
      createdAt: entry.timestamp,
    };
  }
  if (entry.type === 'compaction') {
    return {
      id: entry.id,
      role: 'system',
      content: `[上下文摘要]\n${entry.summary}`,
      createdAt: entry.timestamp,
    };
  }
  if (entry.type === 'custom_message') {
    return {
      id: entry.id,
      role: 'system',
      content: contentText(entry.content),
      createdAt: entry.timestamp,
    };
  }
  if (entry.type !== 'message') return null;

  const message = entry.message;
  if (message.role === 'user') {
    return {
      id: entry.id,
      role: 'user',
      content: contentText(message.content),
      createdAt: entry.timestamp,
    };
  }
  if (message.role === 'assistant') {
    const toolCalls = message.content.flatMap((block) =>
      block.type === 'toolCall'
        ? [{
            id: block.id,
            type: 'function' as const,
            function: {
              name: block.name,
              arguments: JSON.stringify(block.arguments ?? {}),
            },
          }]
        : [],
    );
    return {
      id: entry.id,
      role: 'assistant',
      content: contentText(message.content),
      createdAt: entry.timestamp,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      failure: message.errorMessage
        ? {
            message: message.errorMessage,
            category: message.stopReason === 'aborted' ? 'cancelled' : 'model',
          }
        : undefined,
    };
  }
  if (message.role === 'toolResult') {
    return {
      id: entry.id,
      role: 'tool',
      content: contentText(message.content),
      createdAt: entry.timestamp,
      toolCallId: message.toolCallId,
    };
  }
  return null;
}

function messageSignature(message: Message): string {
  return JSON.stringify({
    role: message.role,
    content: message.content,
    toolCallId: message.toolCallId,
    toolCalls: message.toolCalls?.map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })),
  });
}

function uniqueEntryId(preferred: string, usedIds: Set<string>): string {
  if (!usedIds.has(preferred)) return preferred;
  let suffix = 1;
  while (usedIds.has(`${preferred}-${suffix}`)) suffix++;
  return `${preferred}-${suffix}`;
}

function projectTreeNode(
  entry: SessionTreeEntry,
  labels: Map<string, string>,
): PiSessionTreeNode {
  const base: PiSessionTreeNode = {
    id: entry.id,
    parentId: entry.parentId,
    type: entry.type,
    timestamp: entry.timestamp,
    label: labels.get(entry.id),
  };

  switch (entry.type) {
    case 'message':
      return {
        ...base,
        role: toAurevoyRole(entry.message.role),
        preview: truncatePreview(agentMessageText(entry.message)),
      };
    case 'branch_summary':
    case 'compaction':
      return { ...base, preview: truncatePreview(entry.summary) };
    case 'custom_message':
      return { ...base, preview: truncatePreview(contentText(entry.content)) };
    case 'label':
      return { ...base, preview: entry.label ? `Label: ${entry.label}` : 'Label removed' };
    case 'leaf':
      return { ...base, preview: entry.targetId ? `Leaf → ${entry.targetId}` : 'Leaf → root' };
    case 'session_info':
      return { ...base, preview: entry.name ? `Session: ${entry.name}` : 'Session name cleared' };
    case 'model_change':
      return { ...base, preview: `${entry.provider}:${entry.modelId}` };
    case 'thinking_level_change':
      return { ...base, preview: `Thinking: ${entry.thinkingLevel}` };
    case 'active_tools_change':
      return { ...base, preview: `Tools: ${entry.activeToolNames.join(', ')}` };
    case 'custom':
      return { ...base, preview: entry.customType };
  }
}

function toAurevoyRole(role: AgentMessage['role']): MessageRole | undefined {
  if (role === 'user' || role === 'assistant') return role;
  if (role === 'toolResult') return 'tool';
  return undefined;
}

function agentMessageText(message: AgentMessage): string {
  return 'content' in message ? contentText(message.content) : '';
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (
      typeof block === 'object' &&
      block !== null &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block &&
      typeof block.text === 'string'
    ) {
      return block.text;
    }
    return '';
  }).join('');
}

function truncatePreview(value: string, limit = 160): string | undefined {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

function isSessionTreeEntry(value: unknown): value is SessionTreeEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string' &&
    'id' in value &&
    typeof value.id === 'string' &&
    'parentId' in value &&
    (typeof value.parentId === 'string' || value.parentId === null) &&
    'timestamp' in value &&
    typeof value.timestamp === 'string'
  );
}
