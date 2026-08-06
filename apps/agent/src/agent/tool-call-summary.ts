import { browserToolTier, isBrowserMcpServerName } from '../tool/browser-permissions.js';

const SUMMARY_MAX_LENGTH = 96;

/** 只从安全、简短的定位参数中选择摘要目标，避免泄露密钥或整段正文。 */
const SAFE_TARGET_KEYS = [
  'query',
  'Query',
  'pattern',
  'path',
  'filePath',
  'TargetFile',
  'AbsolutePath',
  'url',
  'item_key',
  'itemKey',
  'collection_key',
  'collectionKey',
  'resource_id',
  'resourceId',
  'id',
] as const;

/**
 * 为跨进程工具事件生成稳定的人类可读摘要。
 *
 * 摘要属于后端契约，前端不需要了解每个 Effect/MCP 工具的参数 schema；
 * 未知工具至少回退到可识别的工具名，不再产生无上下文的“已完成一步”。
 */
export function buildToolCallSummary(toolName: string, args: unknown): string {
  const record = isRecord(args) ? args : {};
  const knownSummary = summarizeKnownTool(toolName, record);
  if (knownSummary) return truncateSummary(knownSummary);

  const target = firstSafeTarget(record);
  if (toolName.startsWith('mcp_')) {
    const { server, action } = splitMcpToolName(toolName);
    if (isBrowserMcpServerName(server)) {
      const browserTarget = firstStringArg(record, ['url', 'site', 'domain', 'ref', 'selector', 'element'])
        ?? target;
      const label = browserActionLabel(action);
      return truncateSummary(browserTarget ? `${label} · ${browserTarget}` : label);
    }
    const label = [displayMcpServer(server), humanizeMcpAction(action)].filter(Boolean).join(' · ');
    return truncateSummary(target ? `调用 ${label} · ${target}` : `调用 ${label || 'MCP 工具'}`);
  }

  const label = humanizeIdentifier(toolName) || '工具';
  return truncateSummary(target ? `运行 ${label} · ${target}` : `运行 ${label}`);
}

/** 浏览器审批摘要按动作分层，提交类只展示站点/定位字段，不回显表单值。 */
function browserActionLabel(action: string): string {
  const tier = browserToolTier({ name: action });
  const normalized = action.replace(/[-\s]+/g, '_').toLowerCase();
  if (tier === 'submit') return /click|fill|type|press|select|upload|submit|form/.test(normalized) ? '提交/交互页面' : '执行浏览器高风险操作';
  if (tier === 'login') return '登录浏览器站点';
  if (tier === 'download') return '下载网页文件';
  if (/screenshot|screen|snapshot/.test(normalized)) return '截图网页';
  if (/navigate|goto|open/.test(normalized)) return '导航到网页';
  return '读取网页';
}

function summarizeKnownTool(toolName: string, args: Record<string, unknown>): string | undefined {
  if (toolName === 'bash' || toolName === 'execute_command') {
    const command = stringArg(args, 'command');
    const commandArgs = Array.isArray(args.args) ? args.args.map(String).join(' ') : '';
    const fullCommand = [command, commandArgs].filter(Boolean).join(' ');
    return fullCommand ? `运行命令 · ${fullCommand}` : '运行命令';
  }
  if (toolName === 'web_search') {
    const query = stringArg(args, 'query') || stringArg(args, 'Query');
    return query ? `搜索网页 · ${query}` : '搜索网页';
  }
  if (toolName === 'web_fetch') {
    const url = stringArg(args, 'url');
    return url ? `浏览网页 · ${url}` : '浏览网页';
  }
  if (toolName === 'read' || toolName === 'read_file' || toolName === 'open_file') {
    const path = firstStringArg(args, ['path', 'filePath', 'AbsolutePath']);
    return path ? `读取文件 · ${path}` : '读取文件';
  }
  if (toolName === 'write' || toolName === 'write_file' || toolName === 'create_file' || toolName === 'append_file') {
    const path = firstStringArg(args, ['path', 'filePath', 'TargetFile']);
    return path ? `写入文件 · ${path}` : '写入文件';
  }
  if (toolName === 'edit' || toolName === 'edit_file' || toolName === 'apply_diff' || toolName === 'replace_lines' || toolName === 'edit_lines') {
    const path = firstStringArg(args, ['path', 'filePath', 'TargetFile']);
    return path ? `编辑文件 · ${path}` : '编辑文件';
  }
  if (toolName === 'grep' || toolName === 'search_grep' || toolName === 'search_files' || toolName === 'glob') {
    const pattern = firstStringArg(args, ['pattern', 'query']);
    return pattern ? `搜索文件 · ${pattern}` : '搜索文件';
  }
  if (toolName === 'list_directory') {
    const path = stringArg(args, 'path');
    return path ? `列出目录 · ${path}` : '列出目录';
  }
  if (toolName === 'copy_file' || toolName === 'move_file' || toolName === 'rename_file' || toolName === 'delete_file') {
    const path = firstStringArg(args, ['path', 'source', 'from']);
    const labels: Record<string, string> = {
      copy_file: '复制文件',
      move_file: '移动文件',
      rename_file: '重命名文件',
      delete_file: '删除文件',
    };
    return path ? `${labels[toolName]} · ${path}` : labels[toolName];
  }
  return undefined;
}

function splitMcpToolName(toolName: string): { server: string; action: string } {
  const withoutPrefix = toolName.slice('mcp_'.length);
  const separator = withoutPrefix.indexOf('_');
  if (separator < 0) return { server: withoutPrefix, action: '' };
  const server = withoutPrefix.slice(0, separator);
  let action = withoutPrefix.slice(separator + 1);
  if (action.startsWith(`${server}_`)) action = action.slice(server.length + 1);
  return { server, action };
}

function firstSafeTarget(args: Record<string, unknown>): string | undefined {
  return firstStringArg(args, SAFE_TARGET_KEYS);
}

function firstStringArg(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = stringArg(args, key);
    if (value) return value;
  }
  return undefined;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') return '';
  return value.trim();
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function displayMcpServer(value: string): string {
  const normalized = humanizeIdentifier(value);
  if (!normalized) return '';
  const knownBrands: Record<string, string> = {
    github: 'GitHub',
    gitlab: 'GitLab',
    notion: 'Notion',
    slack: 'Slack',
    zotero: 'Zotero',
  };
  return knownBrands[normalized.toLowerCase()]
    ?? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

/** 翻译常见 MCP 动作；不认识的 token 保留原文，确保自定义工具仍可辨认。 */
function humanizeMcpAction(value: string): string {
  const normalized = value.replace(/[-\s]+/g, '_').toLowerCase();
  const knownActions: Record<string, string> = {
    semantic_search: '语义搜索',
    get_item_metadata: '获取条目元数据',
    search_items: '搜索条目',
    get_item: '获取条目',
    list_items: '列出条目',
    create_item: '创建条目',
    update_item: '更新条目',
    delete_item: '删除条目',
  };
  if (knownActions[normalized]) return knownActions[normalized];

  const tokenLabels: Record<string, string> = {
    get: '获取',
    search: '搜索',
    list: '列出',
    create: '创建',
    update: '更新',
    edit: '编辑',
    delete: '删除',
    remove: '删除',
    fetch: '获取',
    read: '读取',
    write: '写入',
    item: '条目',
    items: '条目',
    metadata: '元数据',
    collection: '分类',
    collections: '分类',
  };
  return normalized
    .split('_')
    .filter(Boolean)
    .map((token) => tokenLabels[token] ?? token)
    .join(' ');
}

function truncateSummary(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > SUMMARY_MAX_LENGTH
    ? `${normalized.slice(0, SUMMARY_MAX_LENGTH - 1)}…`
    : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
