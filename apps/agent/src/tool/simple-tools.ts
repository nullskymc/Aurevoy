import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { config } from '../config.js';
import { unifiedToolRegistry } from './unified-registry.js';

// 对话内 UI 暂停开放：保留 canvas 实现以便后续恢复与渲染历史内容，但不向 Agent 注册该工具。
const ENABLE_PRESENT_UI_TOOL = false;

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

  // present_ui — 对话内 Agent 自由设计 UI（canvas 基础原语或 sandbox JS）
  // 暂停注册，避免模型与子代理进入尚在评估的 canvas 链路。
  if (ENABLE_PRESENT_UI_TOOL) unifiedToolRegistry.register({
    name: 'present_ui',
    description:
      '在对话中展示由 Agent 自由设计的交互 UI；canvas 支持安全基础原语或 sandbox 隔离的 HTML/CSS/JS。' +
      '传入相同 id 可更新已有组件（原地替换 props）。' +
      '需要对话内交互时直接使用本工具；只有用户明确要求可下载的长篇报告时才写 HTML 文件并用 attach_content。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['canvas'],
          description:
            'canvas: Agent 自由设计交互界面，可使用基础原语或 sandbox 隔离的 HTML/CSS/JS。',
        },
        props: {
          type: 'object',
          description:
            '组件属性。canvas 声明式模式为 {title?, description?, state?, body:UiNode[]}，JS 模式为 {title?, description?, state?, html, css?, script}；UiNode 支持 section/row/column/grid/' +
            'heading/text/badge/divider/spacer/progress/button/input/textarea/select/checkbox；' +
            '节点可用 stateKey、visibleWhen、style token 和 submit/set/toggle action；JS 模式用 aurevoy.emit(actionId,payload) 回传事件，不要直接调用 window.postMessage/parent.postMessage。',
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

}

// ---- present_ui 校验（白名单 props，防撑爆 UI）----

const UI_KINDS = new Set(['canvas']);
const MAX_CANVAS_DEPTH = 6;
const MAX_CANVAS_NODES = 80;

function validatePresentUiProps(kind: string, raw: unknown): Record<string, unknown> {
  if (!UI_KINDS.has(kind)) {
    throw new Error(`不支持的 UI kind: ${kind}。允许: ${[...UI_KINDS].join(', ')}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('props 必须是对象');
  }
  const props = raw as Record<string, unknown>;

  if (kind !== 'canvas') {
    throw new Error(`不支持的 UI kind: ${kind}`);
  }
  return validateCanvasProps(props);

}

function validateCanvasProps(props: Record<string, unknown>): Record<string, unknown> {
  const hasCode = typeof props.html === 'string' || typeof props.script === 'string' || typeof props.css === 'string';
  if (hasCode) {
    if (typeof props.html !== 'string' || !props.html.trim()) throw new Error('canvas JS 模式需要 html');
    if (typeof props.script !== 'string' || !props.script.trim()) throw new Error('canvas JS 模式需要 script');
    if (props.html.length > 80_000 || (typeof props.css === 'string' && props.css.length > 40_000) || props.script.length > 80_000) {
      throw new Error('canvas html/css/script 超出长度限制');
    }
  } else if (!Array.isArray(props.body) || props.body.length === 0) {
    throw new Error('canvas 需要非空 body，或提供 html + script');
  }
  const body = Array.isArray(props.body) ? props.body : [];
  const counter = { value: 0 };
  const stateRaw = props.state && typeof props.state === 'object' && !Array.isArray(props.state)
    ? props.state as Record<string, unknown>
    : {};
  const state: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(stateRaw).slice(0, 40)) {
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(key)) continue;
    state[key] = normalizeCanvasPrimitive(value);
  }
  return {
    title: typeof props.title === 'string' ? props.title.trim().slice(0, 160) : undefined,
    description: typeof props.description === 'string' ? props.description.trim().slice(0, 500) : undefined,
    state,
    body: body.map((node, index) => validateCanvasNode(node, `body[${index}]`, 0, counter)),
    html: typeof props.html === 'string' ? props.html : undefined,
    css: typeof props.css === 'string' ? props.css : undefined,
    script: typeof props.script === 'string' ? props.script : undefined,
  };
}

const CANVAS_NODE_TYPES = new Set([
  'section', 'row', 'column', 'grid', 'heading', 'text', 'badge', 'divider', 'spacer', 'progress',
  'button', 'input', 'textarea', 'select', 'checkbox',
]);
const CANVAS_TONES = new Set(['neutral', 'accent', 'success', 'warning', 'danger']);
const CANVAS_VARIANTS = new Set(['plain', 'soft', 'outline', 'solid']);
const CANVAS_ALIGNS = new Set(['start', 'center', 'end', 'stretch']);

function validateCanvasNode(
  raw: unknown,
  path: string,
  depth: number,
  counter: { value: number },
): Record<string, unknown> {
  if (depth > MAX_CANVAS_DEPTH) throw new Error(`canvas 节点嵌套不能超过 ${MAX_CANVAS_DEPTH} 层`);
  counter.value += 1;
  if (counter.value > MAX_CANVAS_NODES) throw new Error(`canvas 节点不能超过 ${MAX_CANVAS_NODES} 个`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path} 必须是对象`);
  const node = raw as Record<string, unknown>;
  const type = typeof node.type === 'string' ? node.type : '';
  if (!CANVAS_NODE_TYPES.has(type)) throw new Error(`${path}.type 不支持: ${type}`);

  const normalized: Record<string, unknown> = { type };
  if (typeof node.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(node.id)) normalized.id = node.id;
  if (typeof node.text === 'string') normalized.text = node.text.slice(0, 1000);
  if (typeof node.label === 'string') normalized.label = node.label.slice(0, 240);
  if (typeof node.placeholder === 'string') normalized.placeholder = node.placeholder.slice(0, 160);
  if (typeof node.stateKey === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(node.stateKey)) normalized.stateKey = node.stateKey;
  if (node.value !== undefined) normalized.value = normalizeCanvasPrimitive(node.value);

  if (Array.isArray(node.options)) {
    normalized.options = node.options.slice(0, 30).map((option, index) => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) throw new Error(`${path}.options[${index}] 必须是对象`);
      const record = option as Record<string, unknown>;
      return { label: String(record.label ?? '').slice(0, 120), value: String(record.value ?? '').slice(0, 120) };
    });
  }
  if (node.style && typeof node.style === 'object' && !Array.isArray(node.style)) {
    const style = node.style as Record<string, unknown>;
    normalized.style = {
      tone: typeof style.tone === 'string' && CANVAS_TONES.has(style.tone) ? style.tone : undefined,
      variant: typeof style.variant === 'string' && CANVAS_VARIANTS.has(style.variant) ? style.variant : undefined,
      width: style.width === 'full' || style.width === 'auto' ? style.width : undefined,
      columns: typeof style.columns === 'number' && style.columns >= 1 && style.columns <= 4 ? Math.floor(style.columns) : undefined,
      gap: typeof style.gap === 'number' && style.gap >= 0 && style.gap <= 4 ? Math.floor(style.gap) : undefined,
      padding: typeof style.padding === 'number' && style.padding >= 0 && style.padding <= 4 ? Math.floor(style.padding) : undefined,
      align: typeof style.align === 'string' && CANVAS_ALIGNS.has(style.align) ? style.align : undefined,
    };
  }
  if (node.visibleWhen && typeof node.visibleWhen === 'object' && !Array.isArray(node.visibleWhen)) {
    const condition = node.visibleWhen as Record<string, unknown>;
    if (typeof condition.stateKey === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(condition.stateKey)) {
      normalized.visibleWhen = { stateKey: condition.stateKey, equals: normalizeCanvasPrimitive(condition.equals) };
    }
  }
  if (node.action && typeof node.action === 'object' && !Array.isArray(node.action)) {
    const action = node.action as Record<string, unknown>;
    if (action.type === 'submit' || action.type === 'set' || action.type === 'toggle') {
      normalized.action = {
        type: action.type,
        id: typeof action.id === 'string' ? action.id.slice(0, 64) : undefined,
        stateKey: typeof action.stateKey === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(action.stateKey) ? action.stateKey : undefined,
        value: action.value === undefined ? undefined : normalizeCanvasPrimitive(action.value),
        includeState: action.includeState !== false,
      };
    }
  }
  if (Array.isArray(node.children)) {
    normalized.children = node.children.map((child, index) => validateCanvasNode(child, `${path}.children[${index}]`, depth + 1, counter));
  }
  return normalized;
}

function normalizeCanvasPrimitive(value: unknown): string | number | boolean | null {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value;
  return String(value ?? '').slice(0, 1000);
}

function defaultFallbackText(kind: string, props: Record<string, unknown>): string {
  if (kind === 'canvas') {
    const body = Array.isArray(props.body) ? props.body as unknown[] : [];
    return props.html
      ? `自定义 JS 交互界面${typeof props.title === 'string' ? `「${props.title}」` : ''}`
      : `交互界面${typeof props.title === 'string' ? `「${props.title}」` : ''}（${body.length} 个根节点）`;
  }
  return `UI: ${kind}`;
}
