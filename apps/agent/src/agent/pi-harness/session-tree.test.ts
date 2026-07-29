import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Message, Task } from '@aurevoy/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { piSessionTreeStore, taskStore } from '../../store/db.js';
import {
  getPiSessionTreeResponse,
  navigatePiSessionTree,
  openPiSessionTree,
  recordPiSessionExecutionMode,
  setPiSessionTreeLabel,
  type PiSessionSeedMessage,
} from './session-tree.js';

const createdTaskIds: string[] = [];

afterEach(() => {
  for (const taskId of createdTaskIds.splice(0)) taskStore.delete(taskId);
});

describe('Pi session tree persistence', () => {
  it('persists Pi entries and resumes the same leaf on the next run', async () => {
    const userMessage = createMessage('user', 'inspect the project');
    const task = createTask([userMessage]);
    taskStore.save(task);

    const first = openPiSessionTree(task, [toSeed(userMessage)]);
    const assistantEntryId = await first.session.appendMessage(createAssistantMessage('inspection complete'));
    const assistantMessage = createMessage('assistant', 'inspection complete');
    task.messages.push(assistantMessage);
    await first.persist(task);

    const response = await getPiSessionTreeResponse(task.id);
    expect(response.leafId).toBe(assistantMessage.id);
    expect(response.nodes).toHaveLength(2);
    expect(response.nodes.map((node) => node.parentId)).toEqual([null, userMessage.id]);
    expect(response.nodes[1]).toMatchObject({
      id: assistantMessage.id,
      role: 'assistant',
      preview: 'inspection complete',
      navigable: false,
    });
    expect(response.nodes[0]).toMatchObject({ id: userMessage.id, navigable: true });

    const resumed = openPiSessionTree(task, []);
    expect(resumed.reusedSnapshot).toBe(true);
    expect(resumed.persistedMessageCount).toBe(2);
    expect(await resumed.session.getLeafId()).toBe(assistantEntryId);
  });

  it('rebuilds from the active messages when the durable prefix changed', async () => {
    const userMessage = createMessage('user', 'original goal');
    const task = createTask([userMessage]);
    taskStore.save(task);

    const first = openPiSessionTree(task, [toSeed(userMessage)]);
    await first.persist(task);

    const editedMessage = { ...userMessage, id: randomUUID(), content: 'edited goal' };
    task.messages = [editedMessage];
    const rebuilt = openPiSessionTree(task, [toSeed(editedMessage)]);

    expect(rebuilt.reusedSnapshot).toBe(false);
    expect(await rebuilt.session.getLeafId()).toBe(editedMessage.id);
  });

  it('moves the active leaf and projects the selected branch back into the task', async () => {
    const firstUser = createMessage('user', 'first question');
    const task = createTask([firstUser]);
    taskStore.save(task);

    const handle = openPiSessionTree(task, [toSeed(firstUser)]);
    await handle.session.appendMessage(createAssistantMessage('first answer'));
    const firstAssistant = createMessage('assistant', 'first answer');
    task.messages.push(firstAssistant);
    await handle.session.appendMessage({
      role: 'user',
      content: 'second question',
      timestamp: Date.now(),
    });
    const secondUser = createMessage('user', 'second question');
    task.messages.push(secondUser);
    await handle.session.appendMessage(createAssistantMessage('second answer'));
    task.messages.push(createMessage('assistant', 'second answer'));
    await handle.persist(task);
    taskStore.save(task);

    // v1 快照没有显式 message link；导航时应按当前产品分支回填并升级。
    const legacySnapshot = piSessionTreeStore.get(task.id)!;
    piSessionTreeStore.save(task.id, {
      version: 1,
      entries: legacySnapshot.entries,
      messageCount: legacySnapshot.messageCount,
      messageIds: legacySnapshot.messageIds,
      messageLinks: [],
    });

    await expect(navigatePiSessionTree(task, firstAssistant.id)).rejects.toThrow(
      '只有用户消息',
    );

    const result = await navigatePiSessionTree(task, secondUser.id);

    expect(result.tree.leafId).toBe(secondUser.id);
    expect(result.task.status).toBe('pending');
    expect(result.task.phase).toBeNull();
    expect(result.task.messages.map((message) => message.content)).toEqual([
      'first question',
      'first answer',
      'second question',
    ]);
    expect(result.tree.nodes.some((node) => node.id === secondUser.id)).toBe(true);
    expect(taskStore.get(task.id)?.messages).toHaveLength(3);
  });

  it('projects only linked Aurevoy messages and hides internal completion-gate entries', async () => {
    const user = createMessage('user', 'write the report');
    const task = createTask([user]);
    taskStore.save(task);

    const handle = openPiSessionTree(task, [toSeed(user)]);
    await handle.session.appendMessage(createAssistantMessage('report complete'));
    const answer = createMessage('assistant', 'report complete');
    task.messages.push(answer);
    await handle.session.appendMessage({
      role: 'user',
      content: '<completion_gate>internal audit</completion_gate>',
      timestamp: Date.now(),
    });
    await handle.session.appendMessage(createAssistantMessage('<!-- aurevoy:completion=complete -->'));
    await handle.persist(task);

    const response = await getPiSessionTreeResponse(task.id);
    expect(response.nodes.map((node) => node.id)).toEqual([user.id, answer.id]);
    expect(response.nodes.map((node) => node.preview)).not.toContain(
      '<completion_gate>internal audit</completion_gate>',
    );
    expect(response.leafId).toBe(answer.id);
  });

  it('persists labels on product message nodes', async () => {
    const user = createMessage('user', 'label this decision');
    const task = createTask([user]);
    taskStore.save(task);
    const handle = openPiSessionTree(task, [toSeed(user)]);
    await handle.persist(task);

    const response = await setPiSessionTreeLabel(task.id, user.id, 'decision');
    expect(response.nodes.find((node) => node.id === user.id)?.label).toBe('decision');

    const cleared = await setPiSessionTreeLabel(task.id, user.id, undefined);
    expect(cleared.nodes.find((node) => node.id === user.id)?.label).toBeUndefined();
  });

  it('records execution mode changes as visible audit nodes', async () => {
    const user = createMessage('user', 'plan then execute');
    const task = createTask([user]);
    taskStore.save(task);
    const handle = openPiSessionTree(task, [toSeed(user)]);
    await handle.persist(task);

    await expect(recordPiSessionExecutionMode(task.id, 'plan')).resolves.toBe(true);
    const response = await getPiSessionTreeResponse(task.id);
    expect(response.nodes.some((node) =>
      node.type === 'custom_message' && node.preview === 'Execution mode: plan',
    )).toBe(true);
  });
});

function createTask(messages: Message[]): Task {
  const now = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    goal: messages[0]?.content ?? 'session tree test',
    title: 'session tree test',
    status: 'pending',
    phase: 'initializing',
    plan: [],
    messages,
    createdAt: now,
    updatedAt: now,
  };
  createdTaskIds.push(task.id);
  return task;
}

function createMessage(role: 'user' | 'assistant', content: string): Message {
  return {
    id: randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}

function toSeed(message: Message): PiSessionSeedMessage {
  return {
    sourceMessageId: message.id,
    message: {
      role: 'user',
      content: message.content,
      timestamp: new Date(message.createdAt).getTime(),
    },
  };
}

function createAssistantMessage(content: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    api: 'openai-responses',
    provider: 'openai',
    model: 'gpt-5',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}
