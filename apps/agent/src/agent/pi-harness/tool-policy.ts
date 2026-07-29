import type { ToolCall } from '@aurevoy/shared';

const PLAN_READ_ONLY_TOOLS = new Set([
  'read', 'open_file', 'read_file', 'list_directory', 'list_dir', 'glob', 'grep',
  'search_grep', 'search_files', 'web_search', 'web_fetch', 'http_fetch', 'recall',
  'get_current_time', 'load_skill', 'ask_user', 'update_plan',
]);

/** 计划阶段的运行时只读门禁，不能只依赖 system prompt。 */
export function planModeToolBlockReason(call: ToolCall): string | undefined {
  if (PLAN_READ_ONLY_TOOLS.has(call.toolName)) return undefined;

  // shell 是否只读无法靠工具名判断，交由现有单次审批链路裁决。
  if (call.toolName === 'bash') return undefined;
  if (call.toolName !== 'delegate') {
    return '计划模式仅允许只读侦查、检索、澄清和维护计划；请切换到 Agent 模式后再调用该工具。';
  }

  const role = typeof call.args.role === 'string' ? call.args.role : 'general';
  const tools = Array.isArray(call.args.tools)
    ? call.args.tools.filter((item): item is string => typeof item === 'string')
    : [];
  if (role !== 'explore' && role !== 'research') {
    return `计划模式仅允许 explore 或 research 子代理，当前角色为 ${role}。`;
  }
  const unsafeTool = tools.find((tool) => !PLAN_READ_ONLY_TOOLS.has(tool));
  return unsafeTool
    ? `计划模式不允许子代理使用 ${unsafeTool}；请仅委托只读侦查或调研。`
    : undefined;
}
