import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { config } from '../config.js';
import { unifiedToolRegistry } from './unified-registry.js';

// ---- 路径安全工具（从旧 tools/builtins.ts 迁移）----

function resolveInWorkspace(input: unknown, workspaceRoot: string, externalPaths?: string[]): string {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('path 必须是非空字符串');
  const target = isAbsolute(input) ? resolve(input) : resolve(workspaceRoot, input);
  if (isInsideExternalPath(target, externalPaths)) return target;
  const rel = relative(workspaceRoot, target);
  if (rel === '') return target;
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越界：只允许访问工作区目录内 (${workspaceRoot})`);
  }
  return target;
}

function isInsideExternalPath(target: string, externalPaths?: string[]): boolean {
  if (!externalPaths || externalPaths.length === 0) return false;
  const resolved = resolve(target);
  for (const ext of externalPaths) {
    const extResolved = resolve(ext);
    if (resolved === extResolved || resolved.startsWith(`${extResolved}/`)) return true;
  }
  return false;
}

function getTrustedDirs(): string[] {
  const home = homedir();
  const dirs = [resolve(home, '.aurevoy'), resolve(home, '.agents'), resolve(home, '.claude'), resolve(home, '.codex')];
  try { dirs.push(resolve(config.skills.builtinDir)); } catch { /* ignore */ }
  try {
    for (const sub of [config.skills.workspaceSubDir, config.skills.agentsWorkspaceSubDir, config.skills.claudeWorkspaceSubDir, config.skills.codexWorkspaceSubDir]) {
      dirs.push(resolve(config.workspaceDir, sub));
    }
  } catch { /* ignore */ }
  return dirs;
}

function isInsideTrustedDir(target: string): boolean {
  const resolved = resolve(target);
  for (const dir of getTrustedDirs()) {
    if (resolved === dir || resolved.startsWith(`${dir}/`)) return true;
  }
  return false;
}

async function realpathOrNearest(p: string): Promise<string> {
  let probe = resolve(p);
  for (;;) {
    try { return await fs.realpath(probe); }
    catch (err) { if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err; }
    const parent = join(probe, '..');
    if (parent === probe) throw new Error(`无法解析路径: ${p}`);
    probe = parent;
  }
}

async function assertRealPathInside(target: string, workspaceRoot: string, externalPaths?: string[]): Promise<void> {
  if (isInsideExternalPath(target, externalPaths)) return;
  if (isInsideTrustedDir(target)) return;
  await fs.mkdir(workspaceRoot, { recursive: true });
  const realRoot = await fs.realpath(workspaceRoot);
  const real = await realpathOrNearest(target);
  const rel = relative(realRoot, real);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new Error(`路径越界（符号链接指向工作区外）：只允许访问 ${workspaceRoot} 内`);
  }
}

function rootAndExternals(ctx?: { workspaceDir?: string; externalPaths?: string[] }) {
  return { root: ctx?.workspaceDir ?? resolve(config.workspaceDir), externalPaths: ctx?.externalPaths };
}

async function pathExists(path: string): Promise<boolean> {
  try { await fs.stat(path); return true; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; throw err; }
}

// ---- 基础工具 ----

export function registerSimpleTools(): void {

  // get_current_time
  unifiedToolRegistry.register({
    name: 'get_current_time',
    description: '获取当前的 ISO 时间戳',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    riskLevel: 'safe',
    source: { type: 'builtin' },
    async execute() {
      return { now: new Date().toISOString() };
    },
  });

  // list_directory
  unifiedToolRegistry.register({
    name: 'list_directory',
    description: '列出工作区内某个目录的条目（文件/子目录）。path 相对工作区根，缺省为根。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作区的目录路径，缺省为根目录' } },
      additionalProperties: false,
    },
    riskLevel: 'safe',
    source: { type: 'builtin' },
    async execute(args, context) {
      const { root, externalPaths: extPaths } = rootAndExternals(context);
      await fs.mkdir(root, { recursive: true });
      const dir = resolveInWorkspace((args.path as string | undefined) ?? '.', root, extPaths);
      await assertRealPathInside(dir, root, extPaths);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return {
        dir: relative(root, dir) || '.',
        entries: entries.filter((e) => e.name !== '.aurevoy-trash')
          .map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })),
      };
    },
  });

  // copy_file
  unifiedToolRegistry.register({
    name: 'copy_file',
    description: '在工作区内复制文件。目标存在时默认拒绝覆盖，除非 overwrite=true。',
    inputSchema: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string', description: '相对工作区的源文件路径' },
        targetPath: { type: 'string', description: '相对工作区的目标文件路径' },
        overwrite: { type: 'boolean', description: '是否覆盖已有目标文件，默认 false' },
      },
      required: ['sourcePath', 'targetPath'],
      additionalProperties: false,
    },
    riskLevel: 'caution',
    source: { type: 'builtin' },
    async execute(args, context) {
      const { root, externalPaths: extPaths } = rootAndExternals(context);
      const source = resolveInWorkspace(args.sourcePath, root, extPaths);
      const target = resolveInWorkspace(args.targetPath, root, extPaths);
      await assertRealPathInside(source, root, extPaths);
      await fs.mkdir(join(target, '..'), { recursive: true });
      await assertRealPathInside(target, root, extPaths);
      const sourceStat = await fs.stat(source);
      if (!sourceStat.isFile()) throw new Error('sourcePath 不是文件');
      if (args.overwrite !== true && await pathExists(target)) throw new Error('targetPath 已存在；如需覆盖请显式传 overwrite=true');
      await fs.copyFile(source, target);
      return { sourcePath: relative(root, source), targetPath: relative(root, target), bytesCopied: sourceStat.size };
    },
  });

  // move_file
  const moveFileTool = {
    name: 'move_file',
    description: '在工作区内移动或重命名文件。目标存在时默认拒绝覆盖，除非 overwrite=true。',
    inputSchema: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string', description: '相对工作区的源文件路径' },
        targetPath: { type: 'string', description: '相对工作区的目标文件路径' },
        overwrite: { type: 'boolean', description: '是否覆盖已有目标文件，默认 false' },
      },
      required: ['sourcePath', 'targetPath'],
      additionalProperties: false,
    },
    riskLevel: 'caution' as const,
    source: { type: 'builtin' as const },
    async execute(args: Record<string, unknown>, context?: { workspaceDir?: string; externalPaths?: string[] }) {
      const { root, externalPaths: extPaths } = rootAndExternals(context);
      const source = resolveInWorkspace(args.sourcePath, root, extPaths);
      const target = resolveInWorkspace(args.targetPath, root, extPaths);
      await assertRealPathInside(source, root, extPaths);
      await fs.mkdir(join(target, '..'), { recursive: true });
      await assertRealPathInside(target, root, extPaths);
      const sourceStat = await fs.stat(source);
      if (!sourceStat.isFile()) throw new Error('sourcePath 不是文件');
      if (args.overwrite !== true && await pathExists(target)) throw new Error('targetPath 已存在；如需覆盖请显式传 overwrite=true');
      await fs.rename(source, target);
      return { sourcePath: relative(root, source), targetPath: relative(root, target), bytesMoved: sourceStat.size };
    },
  };
  unifiedToolRegistry.register(moveFileTool);
  unifiedToolRegistry.register({
    ...moveFileTool,
    name: 'rename_file',
    description: 'move_file 的别名：在工作区内重命名文件。',
  });

  // delete_file
  unifiedToolRegistry.register({
    name: 'delete_file',
    description: '把工作区内文件移入工作区 .aurevoy-trash 回收区，不做永久删除。默认禁用，启用后仍需审批。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作区的待删除文件路径' } },
      required: ['path'],
      additionalProperties: false,
    },
    riskLevel: 'dangerous',
    source: { type: 'builtin' },
    async execute(args, context) {
      const { root, externalPaths: extPaths } = rootAndExternals(context);
      const file = resolveInWorkspace(args.path, root, extPaths);
      await assertRealPathInside(file, root, extPaths);
      const stat = await fs.stat(file);
      if (!stat.isFile()) throw new Error('path 不是文件');
      const trashDir = resolveInWorkspace('.aurevoy-trash', root, extPaths);
      await fs.mkdir(trashDir, { recursive: true });
      await assertRealPathInside(trashDir, root, extPaths);
      const trashName = `${Date.now()}-${relative(root, file).replace(/[/\\:]/g, '_')}`;
      const trashPath = join(trashDir, trashName);
      await fs.rename(file, trashPath);
      return { path: relative(root, file), trashedPath: relative(root, trashPath), bytesMoved: stat.size };
    },
  });
  unifiedToolRegistry.setEnabled('delete_file', false);

  // attach_content
  unifiedToolRegistry.register({
    name: 'attach_content',
    description: '在对话中附加文件引用、图片或超链接，使用户可以直观地访问文件或查看内容。通过此工具向用户展示文件位置、显示图片或提供重要链接。附加的内容会内联显示在对话消息中。',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['file_reference', 'image', 'link'], description: '内容类型：file_reference 文件路径引用 / image 内联显示图片 / link 超链接' },
        content: { type: 'string', description: '文件路径、图片路径或 URL' },
        name: { type: 'string', description: '显示名称（可选，缺省用文件名或 URL）' },
        mimeType: { type: 'string', description: 'MIME 类型（可选，自动推断时可不传）' },
        size: { type: 'number', description: '文件大小（可选，仅文件引用类型建议传）' },
      },
      required: ['type', 'content'],
      additionalProperties: false,
    },
    riskLevel: 'safe',
    source: { type: 'builtin' },
    async execute(args) {
      const type = args.type as string;
      if (!['file_reference', 'image', 'link'].includes(type)) {
        return { ok: false, error: `不支持的内容类型: ${type}` };
      }
      return {
        contentBlock: {
          type,
          content: String(args.content),
          name: typeof args.name === 'string' ? args.name : undefined,
          mimeType: typeof args.mimeType === 'string' ? args.mimeType : undefined,
          size: typeof args.size === 'number' ? args.size : undefined,
        },
      };
    },
  });

  // index_files
  unifiedToolRegistry.register({
    name: 'index_files',
    description: '索引指定目录中的代码/文档文件到知识库，支持语义搜索。对新增/变更文件做分块 + 向量化，已删除文件自动清理。需要先配置 embedding provider。',
    inputSchema: {
      type: 'object',
      properties: {
        dirs: { type: 'array', items: { type: 'string' }, description: '待索引目录列表（默认使用已配置目录）' },
        force: { type: 'boolean', description: '是否强制重新索引所有文件（默认 false，仅增量）' },
      },
      additionalProperties: false,
    },
    riskLevel: 'safe',
    source: { type: 'builtin' },
    async execute(args) {
      const { indexKbDirs } = await import('../knowledge-base/index.js');
      const dirs = Array.isArray(args.dirs) ? args.dirs.filter((d: unknown) => typeof d === 'string') : undefined;
      const force = args.force === true;
      const results = await indexKbDirs(dirs, force);
      const total = results.reduce((s: number, r: { indexed: number }) => s + r.indexed, 0);
      const totalChunks = results.reduce((s: number, r: { totalChunks: number }) => s + r.totalChunks, 0);
      const removed = results.reduce((s: number, r: { removed: number }) => s + r.removed, 0);
      return {
        indexed: total, totalChunks, removed, details: results,
        note: total > 0 ? `已索引 ${total} 个文件（${totalChunks} 个文本块）` : '无变更，全部跳过',
      };
    },
  });

  // recall
  unifiedToolRegistry.register({
    name: 'recall',
    description: '从知识库中语义搜索与当前任务相关的文件片段。使用向量相似度匹配，需要先配置 embedding provider 并索引文件。返回结果包含文件路径、内容片段和相关度评分。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词或自然语言描述' },
        topK: { type: 'number', description: '返回结果数（默认 5）' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    riskLevel: 'safe',
    source: { type: 'builtin' },
    async execute(args) {
      const { recallKb } = await import('../knowledge-base/index.js');
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) throw new Error('query 不能为空');
      const topK = typeof args.topK === 'number' && args.topK > 0 ? Math.min(args.topK, 20) : 5;
      const { results, citations } = await recallKb(query, topK);
      if (results.length === 0) {
        return {
          found: 0, results: [], citations: [],
          note: '未找到匹配结果。请先添加知识库目录并通过 index_files 工具索引文件，或检查 embedding provider 配置。',
        };
      }
      return {
        found: results.length,
        results: results.map((r: { filePath: string; content: string; score: number }) => ({
          file: r.filePath, snippet: r.content, score: Math.round(r.score * 100) / 100,
        })),
        citations,
        note: `找到 ${results.length} 个相关片段`,
      };
    },
  });

  // run_dreams
  unifiedToolRegistry.register({
    name: 'run_dreams',
    description: '执行记忆后台维护：补全向量索引、合并重复记忆、自动禁用低置信度记忆。通常在任务结束后自动触发，也可手动调用查看维护报告。',
    inputSchema: {
      type: 'object',
      properties: {
        backfillEmbeddings: { type: 'boolean', description: '是否补全缺失的向量索引（默认 true）' },
        dedupMerge: { type: 'boolean', description: '是否合并相似重复记忆（默认 true）' },
        lowConfidenceSweep: { type: 'boolean', description: '是否禁用低置信度记忆（默认 true）' },
      },
      additionalProperties: false,
    },
    riskLevel: 'safe',
    source: { type: 'builtin' },
    async execute(args) {
      const { runDreams } = await import('../memory/dreams.js');
      const options = {
        backfillEmbeddings: args.backfillEmbeddings !== false,
        dedupMerge: args.dedupMerge !== false,
        lowConfidenceSweep: args.lowConfidenceSweep !== false,
      };
      const report = await runDreams(options);
      return {
        ...report,
        note: report.errors.length > 0
          ? `维护完成（${report.durationMs}ms），${report.errors.length} 个错误`
          : `维护完成（${report.durationMs}ms），无错误`,
      };
    },
  });

  // delegate_task
  unifiedToolRegistry.register({
    name: 'delegate_task',
    description: '将独立子任务委托给另一个 Agent 执行。适用于同时搜索多个目录、并发读取多个文件、独立子分析。子代理默认只有只读权限，无权写入文件。可同时发起多个 delegate_task 调用实现并行子代理。',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '子任务的简要目标（一句话）' },
        prompt: { type: 'string', description: '给子代理的详细指令' },
        tools: { type: 'array', items: { type: 'string' }, description: '允许子代理使用的工具' },
      },
      required: ['goal', 'prompt'],
      additionalProperties: false,
    },
    riskLevel: 'safe',
    executionPolicy: { parallelizable: true },
    source: { type: 'builtin' },
    async execute(args, context) {
      const { runSubTask } = await import('../agent/subagent.js');
      const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      if (!goal || !prompt) throw new Error('goal 和 prompt 必须是非空字符串');
      const tools = Array.isArray(args.tools) ? (args.tools as unknown[]).filter((t): t is string => typeof t === 'string') : undefined;
      const result = await runSubTask({
        goal, prompt, allowedTools: tools,
        workspaceDir: context?.workspaceDir ?? process.cwd(),
      });
      return {
        ok: result.ok, subTaskGoal: goal, content: result.content,
        toolCallCount: result.toolCallCount, iterations: result.iterations, error: result.error,
        note: result.ok
          ? `子代理完成，${result.iterations} 轮，${result.toolCallCount} 次工具调用。`
          : `子代理失败：${result.error ?? '未知错误'}`,
      };
    },
  });
}
