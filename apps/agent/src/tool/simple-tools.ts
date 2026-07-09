import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { config } from '../config.js';
import { unifiedToolRegistry } from './unified-registry.js';

// ---- 路径安全工具 ----

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
    description:
      '向用户交付文件或链接。file_reference / image 会在对话中显示卡片，并默认在右侧工作台打开预览：' +
      'Markdown 渲染、HTML 沙箱预览、图片预览等。交付报告/HTML/Markdown 文档时优先用本工具。' +
      'link 类型仅展示可点击链接。',
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

  // present_ui — 对话内限定交互组件（白名单 kind，禁止可执行代码）
  unifiedToolRegistry.register({
    name: 'present_ui',
    description:
      '在对话中展示可交互的限定 UI 组件（非任意 HTML/JSX）。' +
      '用于数据表、指标卡、选项选择、简单计算器或 stack 组合布局。' +
      '传入相同 id 可更新已有组件（原地替换 props）。' +
      '复杂视觉报告请写 HTML 文件并用 attach_content，不要用本工具执行脚本。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['data_table', 'stat_row', 'choice', 'calculator', 'stack'],
          description:
            'data_table: 可排序/筛选表格；stat_row: 指标卡；choice: 用户选项；' +
            'calculator: 本地轻量计算；stack: 组合多个子组件',
        },
        props: {
          type: 'object',
          description:
            '组件属性。data_table: {title?, columns:string[], rows:(string|number|null)[][], features?:("sort"|"filter"|"copy"|"sum")[]}；' +
            'stat_row: {items:{label,value,hint?}[]}；choice: {prompt, options:{id,label}[], multi?}；' +
            'calculator: {title?, fields:{id,label,value:number}[], formula:string}；' +
            'stack: {children:{kind,props}[]}',
        },
        id: { type: 'string', description: '可选。已有组件 id，传入则更新该组件' },
        fallbackText: { type: 'string', description: '纯文本降级摘要（可选）' },
      },
      required: ['kind', 'props'],
      additionalProperties: false,
    },
    riskLevel: 'safe',
    source: { type: 'builtin' },
    async execute(args) {
      try {
        const kind = String(args.kind ?? '');
        const props = validatePresentUiProps(kind, args.props);
        const fallbackText =
          typeof args.fallbackText === 'string' && args.fallbackText.trim()
            ? args.fallbackText.trim().slice(0, 2000)
            : defaultFallbackText(kind, props);
        const id =
          typeof args.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(args.id.trim())
            ? args.id.trim()
            : undefined;
        return {
          contentBlock: {
            type: 'ui',
            id,
            kind,
            props,
            fallbackText,
            content: fallbackText,
          },
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
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
  {
    const roleCatalog = [
      'explore：工作区只读侦查',
      'research：联网+本地调研',
      'coder：读写改代码/文件',
      'shell：命令执行与诊断',
      'writer：文档与报告产出',
      'general：通用宽任务面（默认）',
    ].join('；');
    unifiedToolRegistry.register({
      name: 'delegate_task',
      description:
        '将独立子任务委托给专用子代理并行执行。' +
        `role 选型：${roleCatalog}。` +
        '子代理继承父任务 auto/plan 权限；tools 可覆盖角色默认工具白名单。' +
        '可同时发起多个 delegate_task 实现并行。子代理不能再委托。',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: '子任务的简要目标（一句话）' },
          prompt: { type: 'string', description: '给子代理的详细指令' },
          role: {
            type: 'string',
            enum: ['explore', 'research', 'coder', 'shell', 'writer', 'general'],
            description: '子代理角色，决定默认工具面与行为；缺省 general',
          },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description: '可选：覆盖角色默认工具白名单（权限仍继承父任务）',
          },
        },
        required: ['goal', 'prompt'],
        additionalProperties: false,
      },
      riskLevel: 'safe',
      executionPolicy: { parallelizable: true },
      source: { type: 'builtin' },
      async execute(args, context) {
        const { runSubTask } = await import('../agent/subagent.js');
        const { approvalConfigFromTask } = await import('../agent/approval.js');
        const { isSubagentRole } = await import('../agent/subagent-profiles.js');
        const { config } = await import('../config.js');
        const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
        if (!goal || !prompt) throw new Error('goal 和 prompt 必须是非空字符串');
        const role = isSubagentRole(args.role) ? args.role : undefined;
        const tools = Array.isArray(args.tools)
          ? (args.tools as unknown[]).filter((t): t is string => typeof t === 'string')
          : undefined;
        const level = config.autoMode.level === 'plan' ? 'plan' as const : 'auto' as const;
        const parentTask = context?.task;
        const approvalConfig = parentTask
          ? approvalConfigFromTask(parentTask, level)
          : { autoModeLevel: level, autoModePaused: false, planApproved: level === 'auto' };
        const result = await runSubTask({
          goal,
          prompt,
          role,
          allowedTools: tools,
          workspaceDir: context?.workspaceDir ?? process.cwd(),
          approvalConfig,
          parentTask: parentTask
            ? { id: parentTask.id, autoModeState: parentTask.autoModeState, goal: parentTask.goal }
            : undefined,
        });
        return {
          ok: result.ok,
          subTaskGoal: goal,
          role: result.role,
          content: result.content,
          toolCallCount: result.toolCallCount,
          iterations: result.iterations,
          error: result.error,
          note: result.ok
            ? `子代理(${result.role})完成，${result.iterations} 轮，${result.toolCallCount} 次工具调用（权限继承父任务 ${level}）。`
            : `子代理(${result.role})失败：${result.error ?? '未知错误'}`,
        };
      },
    });
  }
}

// ---- present_ui 校验（白名单 props，防撑爆 UI）----

const UI_KINDS = new Set(['data_table', 'stat_row', 'choice', 'calculator', 'stack']);
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLS = 20;
const MAX_CELL_CHARS = 500;
const MAX_STACK_CHILDREN = 12;
const MAX_STACK_DEPTH = 3;

function validatePresentUiProps(kind: string, raw: unknown, depth = 0): Record<string, unknown> {
  if (!UI_KINDS.has(kind)) {
    throw new Error(`不支持的 UI kind: ${kind}。允许: ${[...UI_KINDS].join(', ')}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('props 必须是对象');
  }
  const props = raw as Record<string, unknown>;

  switch (kind) {
    case 'data_table':
      return validateDataTableProps(props);
    case 'stat_row':
      return validateStatRowProps(props);
    case 'choice':
      return validateChoiceProps(props);
    case 'calculator':
      return validateCalculatorProps(props);
    case 'stack':
      return validateStackProps(props, depth);
    default:
      throw new Error(`不支持的 UI kind: ${kind}`);
  }
}

function validateDataTableProps(props: Record<string, unknown>): Record<string, unknown> {
  const columns = props.columns;
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('data_table.props.columns 必须是非空字符串数组');
  }
  if (columns.length > MAX_TABLE_COLS) {
    throw new Error(`data_table 列数不能超过 ${MAX_TABLE_COLS}`);
  }
  const colStrs = columns.map((c, i) => {
    if (typeof c !== 'string' || !c.trim()) throw new Error(`columns[${i}] 必须是非空字符串`);
    return c.trim().slice(0, 80);
  });

  const rows = props.rows;
  if (!Array.isArray(rows)) throw new Error('data_table.props.rows 必须是数组');
  if (rows.length > MAX_TABLE_ROWS) {
    throw new Error(`data_table 行数不能超过 ${MAX_TABLE_ROWS}`);
  }
  const normalizedRows = rows.map((row, ri) => {
    if (!Array.isArray(row)) throw new Error(`rows[${ri}] 必须是数组`);
    return colStrs.map((_, ci) => normalizeCell(row[ci]));
  });

  const featuresRaw = props.features;
  let features: string[] | undefined;
  if (featuresRaw !== undefined) {
    if (!Array.isArray(featuresRaw)) throw new Error('features 必须是数组');
    const allowed = new Set(['sort', 'filter', 'copy', 'sum']);
    features = [...new Set(featuresRaw.map(String).filter((f) => allowed.has(f)))];
  }

  return {
    title: typeof props.title === 'string' ? props.title.trim().slice(0, 120) : undefined,
    columns: colStrs,
    rows: normalizedRows,
    features: features && features.length > 0 ? features : ['sort', 'copy'],
  };
}

function normalizeCell(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const s = String(value);
  return s.length > MAX_CELL_CHARS ? `${s.slice(0, MAX_CELL_CHARS)}…` : s;
}

function validateStatRowProps(props: Record<string, unknown>): Record<string, unknown> {
  const items = props.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('stat_row.props.items 必须是非空数组');
  }
  if (items.length > 12) throw new Error('stat_row items 不能超过 12 个');
  return {
    items: items.map((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`items[${i}] 必须是对象`);
      }
      const rec = item as Record<string, unknown>;
      if (typeof rec.label !== 'string' || typeof rec.value !== 'string' && typeof rec.value !== 'number') {
        throw new Error(`items[${i}] 需要 label 与 value`);
      }
      return {
        label: String(rec.label).slice(0, 80),
        value: typeof rec.value === 'number' ? rec.value : String(rec.value).slice(0, 120),
        hint: typeof rec.hint === 'string' ? rec.hint.slice(0, 120) : undefined,
      };
    }),
  };
}

function validateChoiceProps(props: Record<string, unknown>): Record<string, unknown> {
  if (typeof props.prompt !== 'string' || !props.prompt.trim()) {
    throw new Error('choice.props.prompt 必填');
  }
  const options = props.options;
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error('choice.props.options 必须是非空数组');
  }
  if (options.length > 20) throw new Error('choice options 不能超过 20 个');
  return {
    prompt: props.prompt.trim().slice(0, 500),
    multi: props.multi === true,
    options: options.map((opt, i) => {
      if (!opt || typeof opt !== 'object' || Array.isArray(opt)) {
        throw new Error(`options[${i}] 必须是对象`);
      }
      const rec = opt as Record<string, unknown>;
      const id = typeof rec.id === 'string' ? rec.id.trim() : '';
      const label = typeof rec.label === 'string' ? rec.label.trim() : '';
      if (!id || !label) throw new Error(`options[${i}] 需要 id 与 label`);
      return { id: id.slice(0, 64), label: label.slice(0, 120) };
    }),
  };
}

function validateCalculatorProps(props: Record<string, unknown>): Record<string, unknown> {
  const fields = props.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error('calculator.props.fields 必须是非空数组');
  }
  if (fields.length > 12) throw new Error('calculator fields 不能超过 12 个');
  if (typeof props.formula !== 'string' || !props.formula.trim()) {
    throw new Error('calculator.props.formula 必填');
  }
  const formula = props.formula.trim().slice(0, 200);
  if (!/^[a-zA-Z0-9_+\-*/().\s]+$/.test(formula)) {
    throw new Error('formula 仅允许字段 id 与 + - * / ( ) 数字空白');
  }
  return {
    title: typeof props.title === 'string' ? props.title.trim().slice(0, 120) : undefined,
    formula,
    fields: fields.map((f, i) => {
      if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Error(`fields[${i}] 必须是对象`);
      const rec = f as Record<string, unknown>;
      const id = typeof rec.id === 'string' ? rec.id.trim() : '';
      const label = typeof rec.label === 'string' ? rec.label.trim() : id;
      if (!id || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(id)) {
        throw new Error(`fields[${i}].id 必须是合法标识符`);
      }
      const value = typeof rec.value === 'number' && Number.isFinite(rec.value) ? rec.value : 0;
      return { id: id.slice(0, 32), label: label.slice(0, 80), value };
    }),
  };
}

function validateStackProps(props: Record<string, unknown>, depth: number): Record<string, unknown> {
  if (depth >= MAX_STACK_DEPTH) {
    throw new Error(`stack 嵌套不能超过 ${MAX_STACK_DEPTH} 层`);
  }
  const children = props.children;
  if (!Array.isArray(children) || children.length === 0) {
    throw new Error('stack.props.children 必须是非空数组');
  }
  if (children.length > MAX_STACK_CHILDREN) {
    throw new Error(`stack children 不能超过 ${MAX_STACK_CHILDREN}`);
  }
  return {
    children: children.map((child, i) => {
      if (!child || typeof child !== 'object' || Array.isArray(child)) {
        throw new Error(`children[${i}] 必须是对象`);
      }
      const rec = child as Record<string, unknown>;
      const kind = typeof rec.kind === 'string' ? rec.kind : '';
      if (kind === 'stack') {
        // 允许嵌套 stack，但计入 depth
      }
      return {
        kind,
        props: validatePresentUiProps(kind, rec.props, depth + 1),
      };
    }),
  };
}

function defaultFallbackText(kind: string, props: Record<string, unknown>): string {
  switch (kind) {
    case 'data_table': {
      const cols = props.columns as string[];
      const rows = props.rows as unknown[];
      return `表格「${typeof props.title === 'string' ? props.title : '数据'}」：${cols.length} 列 × ${rows.length} 行`;
    }
    case 'stat_row': {
      const items = props.items as Array<{ label: string; value: string | number }>;
      return items.map((it) => `${it.label}: ${it.value}`).join(' · ');
    }
    case 'choice':
      return `请选择：${String(props.prompt)}`;
    case 'calculator':
      return `计算器：${String(props.formula)}`;
    case 'stack': {
      const n = (props.children as unknown[]).length;
      return `组合 UI（${n} 块）`;
    }
    default:
      return `UI: ${kind}`;
  }
}
