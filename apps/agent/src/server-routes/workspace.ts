import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyTypeProvider,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
} from 'fastify';
import type { WorkspaceReadResponse } from '@aurevoy/shared';
import { config } from '../config.js';
import { resolveTaskWorkspace } from '../agent/harness-controller.js';
import { projectStore, taskStore } from '../store/db.js';
import { createToolContext, initializeUnifiedToolFramework } from '../tool/index.js';
import { unifiedToolRegistry } from '../tool/unified-registry.js';

/** 工作台路由只负责文件读写适配；路径解析和大文件边界集中在本模块。 */
export function registerWorkspaceRoutes<
  RawServer extends RawServerBase,
  RawRequest extends RawRequestDefaultExpression<RawServer>,
  RawReply extends RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider,
>(
  app: FastifyInstance<RawServer, RawRequest, RawReply, Logger, TypeProvider>,
): void {
  app.get<{
    Querystring: {
      path?: string;
      taskId?: string;
      projectId?: string;
      offset?: string;
      limit?: string;
      /** full=1：工作台预览全量读取（更高字节上限，不走 agent 工具分页） */
      full?: string;
    };
  }>('/api/workspace/read', async (req, reply) => {
    const workspace = await resolveWorkspaceForRead(req.query.taskId, req.query.projectId);
    if (!workspace.ok) return reply.code(workspace.status).send({ error: workspace.error });

    const path = req.query.path?.trim() || '.';
    const wantFull = req.query.full === '1' || req.query.full === 'true';
    if (wantFull) {
      try {
        return await readWorkspaceFileForWorkbench(workspace.workspaceDir, path);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    }

    initializeUnifiedToolFramework();
    const readTool = unifiedToolRegistry.get('read');
    if (!readTool) return reply.code(503).send({ error: 'read tool is unavailable' });

    const offset = parsePositiveInteger(req.query.offset);
    const limit = parsePositiveInteger(req.query.limit);
    try {
      const output = await readTool.execute(
        {
          path,
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {}),
        },
        createToolContext('workspace-read', workspace.workspaceDir, { callId: 'workspace-read-' + Date.now() }),
      );
      return await normalizeWorkspaceReadOutput(output, workspace.workspaceDir, path);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete<{
    Querystring: { path?: string; taskId?: string; projectId?: string };
  }>('/api/workspace/delete', async (req, reply) => {
    const workspace = await resolveWorkspaceForRead(req.query.taskId, req.query.projectId);
    if (!workspace.ok) return reply.code(workspace.status).send({ error: workspace.error });
    const relativePath = req.query.path?.trim();
    if (!relativePath) return reply.code(400).send({ error: 'path is required' });
    const target = resolve(workspace.workspaceDir, relativePath);
    try {
      const stat = await fs.stat(target);
      if (stat.isDirectory()) await fs.rm(target, { recursive: true });
      else await fs.unlink(target);
      return reply.code(204).send();
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post<{
    Body: { path?: string; newName?: string; taskId?: string; projectId?: string };
  }>('/api/workspace/rename', async (req, reply) => {
    const body = req.body ?? {};
    const workspace = await resolveWorkspaceForRead(body.taskId, body.projectId);
    if (!workspace.ok) return reply.code(workspace.status).send({ error: workspace.error });
    const relativePath = body.path?.trim();
    const newName = body.newName?.trim();
    if (!relativePath || !newName) return reply.code(400).send({ error: 'path and newName are required' });
    const oldPath = resolve(workspace.workspaceDir, relativePath);
    const newPath = resolve(dirname(oldPath), newName);
    try {
      await fs.rename(oldPath, newPath);
      return reply.code(204).send();
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post<{
    Body: { path?: string; newName?: string; taskId?: string; projectId?: string };
  }>('/api/workspace/copy', async (req, reply) => {
    const body = req.body ?? {};
    const workspace = await resolveWorkspaceForRead(body.taskId, body.projectId);
    if (!workspace.ok) return reply.code(workspace.status).send({ error: workspace.error });
    const relativePath = body.path?.trim();
    const newName = body.newName?.trim();
    if (!relativePath || !newName) return reply.code(400).send({ error: 'path and newName are required' });
    const srcPath = resolve(workspace.workspaceDir, relativePath);
    const destPath = resolve(dirname(srcPath), newName);
    try {
      await fs.copyFile(srcPath, destPath);
      return reply.code(204).send();
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

type WorkspaceResolution =
  | { ok: true; workspaceDir: string }
  | { ok: false; status: 400 | 404; error: string };

async function resolveWorkspaceForRead(taskId?: string, projectId?: string): Promise<WorkspaceResolution> {
  const normalizedTaskId = taskId?.trim();
  if (normalizedTaskId) {
    const task = taskStore.get(normalizedTaskId);
    if (!task) return { ok: false, status: 404, error: 'task not found' };
    return { ok: true, workspaceDir: await resolveTaskWorkspace(task) };
  }

  const normalizedProjectId = projectId?.trim();
  if (normalizedProjectId) {
    const project = projectStore.get(normalizedProjectId);
    if (!project) return { ok: false, status: 404, error: 'project not found' };
    return { ok: true, workspaceDir: resolve(project.path) };
  }

  return { ok: true, workspaceDir: resolve(config.workspaceDir) };
}

function parsePositiveInteger(raw?: string): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** 工作台全量预览允许的文本体积；与 read 工具分页上限分离。 */
const WORKBENCH_FULL_TEXT_MAX_BYTES = 8 * 1024 * 1024;

async function readWorkspaceFileForWorkbench(
  workspaceDir: string,
  requestedPath: string,
): Promise<WorkspaceReadResponse> {
  const root = resolve(workspaceDir);
  const raw = requestedPath.trim();
  if (!raw) throw new Error('path required');

  const abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  const relPosix = relative(root, abs).replace(/\\/g, '/');
  if (!relPosix || relPosix === '..' || relPosix.startsWith('../') || isAbsolute(relPosix)) {
    throw new Error('路径越界：' + requestedPath);
  }

  const st = await fs.stat(abs);
  if (st.isDirectory()) throw new Error('目录请在文件树中浏览');

  const name = basename(abs);
  const mimeType = inferMimeType(name);
  if ((mimeType ?? '').startsWith('image/')) {
    if (st.size > 20 * 1024 * 1024) throw new Error('图片过大，无法在工作台预览');
    const buf = await fs.readFile(abs);
    return {
      root: workspaceDir,
      path: requestedPath,
      type: 'image',
      content: buf.toString('base64'),
      mimeType: mimeType || 'application/octet-stream',
    };
  }

  if (st.size > WORKBENCH_FULL_TEXT_MAX_BYTES) {
    throw new Error('文件过大（>' + WORKBENCH_FULL_TEXT_MAX_BYTES + ' 字节），无法全量预览');
  }
  return {
    root: workspaceDir,
    path: requestedPath,
    type: 'text',
    content: await fs.readFile(abs, 'utf8'),
    truncated: false,
  };
}

async function normalizeWorkspaceReadOutput(
  output: unknown,
  workspaceDir: string,
  requestedPath: string,
): Promise<WorkspaceReadResponse> {
  if (!isRecord(output) || typeof output.type !== 'string') {
    throw new Error('read tool returned an unsupported response');
  }

  const path = normalizeWorkspacePath(requestedPath);
  if (output.type === 'directory') {
    const rawEntries = Array.isArray(output.entries) ? output.entries : [];
    const entries = rawEntries.filter((entry): entry is { path: string; type: 'file' | 'directory' } =>
      isRecord(entry) &&
      typeof entry.path === 'string' &&
      (entry.type === 'file' || entry.type === 'directory'));
    const enriched = await Promise.all(entries.map(async (entry) => {
      const name = entry.path.replace(/\/+$/g, '').split('/').pop() || entry.path;
      const entryPath = normalizeWorkspacePath(path === '.' ? entry.path : join(path, entry.path));
      const absPath = resolve(workspaceDir, entryPath);
      let size: number | undefined;
      let mimeType: string | undefined;
      try {
        const st = await fs.stat(absPath);
        if (entry.type === 'file') {
          size = st.size;
          mimeType = inferMimeType(name);
        }
      } catch {
        // 目录在读取期间变化时保留条目，但不伪造大小和 MIME。
      }
      return {
        name,
        path: entryPath,
        type: entry.type,
        ...(size !== undefined ? { size } : {}),
        ...(mimeType ? { mimeType } : {}),
      };
    }));
    return {
      root: workspaceDir,
      path,
      type: 'directory',
      entries: enriched,
      truncated: output.truncated === true,
      ...(typeof output.next === 'number' ? { next: output.next } : {}),
    };
  }

  if (output.type === 'full-text' || output.type === 'text-page') {
    return {
      root: workspaceDir,
      path,
      type: 'text',
      content: typeof output.content === 'string' ? output.content : '',
      ...(output.type === 'text-page' && typeof output.offset === 'number' ? { offset: output.offset } : {}),
      truncated: output.type === 'text-page' ? output.truncated === true : false,
      ...(typeof output.next === 'number' ? { next: output.next } : {}),
    };
  }

  if (output.type === 'image') {
    return {
      root: workspaceDir,
      path,
      type: 'image',
      content: typeof output.content === 'string' ? output.content : '',
      mimeType: typeof output.mime === 'string' ? output.mime : 'application/octet-stream',
    };
  }

  throw new Error('unsupported read result type: ' + output.type);
}

function normalizeWorkspacePath(input: string): string {
  const normalized = input.replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!normalized || normalized === '.') return '.';
  return normalized.replace(/^\.\//, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MIME_MAP: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', json: 'application/json', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv',
  html: 'text/html', css: 'text/css', js: 'text/javascript', ts: 'text/typescript',
  tsx: 'text/typescript', jsx: 'text/javascript', py: 'text/x-python', go: 'text/x-go', rs: 'text/x-rust',
  yaml: 'text/yaml', yml: 'text/yaml', sh: 'text/x-shellscript',
};

function inferMimeType(name: string): string | undefined {
  const ext = name.split('.').pop()?.toLowerCase();
  if (!ext || ext === name) return undefined;
  return MIME_MAP[ext];
}
