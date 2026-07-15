import type { SubagentRole } from '@aurevoy/shared';

/**
 * 内置子代理角色定义。
 *
 * 权限仍只继承父任务的 auto/plan；此处只定义「任务面」——角色说明 + 工具白名单。
 * 子代理默认禁止再委托（不含 delegate；同时屏蔽旧名 delegate_task），避免递归爆炸。
 */

export type { SubagentRole } from '@aurevoy/shared';

export interface SubagentProfile {
  role: SubagentRole;
  /** 短标签（日志 / 工具描述） */
  label: string;
  /** 给主 Agent 选型用的说明 */
  description: string;
  /** 默认工具白名单（能力面，非权限档） */
  tools: readonly string[];
  /** 追加进子代理 system prompt 的角色指令 */
  systemPromptAddon: string;
  /** 子 harness 超时（毫秒） */
  timeoutMs: number;
  /** 子 harness 最大模型轮次；到达后在当前工具批次结束处停止 */
  maxIterations: number;
  /** 结果截断字符数 */
  maxOutputChars: number;
}

/** 本地只读侦察共用工具 */
const READ_TOOLS = [
  'read',
  'grep',
  'glob',
  'list_directory',
  'get_current_time',
  'recall',
] as const;

/** 联网调研 */
const WEB_TOOLS = ['web_search', 'web_fetch'] as const;

/** 文件变更 */
const WRITE_TOOLS = [
  'write',
  'edit',
  'copy_file',
  'move_file',
  'rename_file',
  'delete_file',
] as const;

const PROFILES: Record<SubagentRole, SubagentProfile> = {
  explore: {
    role: 'explore',
    label: 'Explore',
    description:
      '工作区只读侦查：定位文件、搜索代码、梳理结构与依赖。适合并行扫多个目录或模块。',
    tools: [...READ_TOOLS, 'attach_content'],
    systemPromptAddon: [
      '角色：Explore（只读侦查员）',
      '- 只做信息收集与结构梳理，不要修改任何文件',
      '- 优先用 glob/grep/list_directory 缩小范围，再用 read 精读关键文件',
      '- 输出：关键路径、发现摘要、风险/缺口；必要时列出后续建议步骤',
    ].join('\n'),
    timeoutMs: 60_000,
    maxIterations: 12,
    maxOutputChars: 24_000,
  },

  research: {
    role: 'research',
    label: 'Research',
    description:
      '联网 + 本地调研：搜索资料、抓取页面，并结合工作区上下文做分析与摘要。',
    tools: [...READ_TOOLS, ...WEB_TOOLS, 'remember', 'attach_content'],
    systemPromptAddon: [
      '角色：Research（调研员）',
      '- 结合 web_search / web_fetch 与本地只读工具完成调研',
      '- 标注来源 URL；区分事实与推断',
      '- 重要结论可 remember；最终给出可执行摘要与引用列表',
      '- 不要修改工作区文件',
    ].join('\n'),
    timeoutMs: 90_000,
    maxIterations: 16,
    maxOutputChars: 32_000,
  },

  coder: {
    role: 'coder',
    label: 'Coder',
    description:
      '编码与改动：读代码、搜索、编辑/写入文件，必要时跑 bash 做检查或小范围命令。',
    tools: [
      ...READ_TOOLS,
      ...WRITE_TOOLS,
      'bash',
      'attach_content',
    ],
    systemPromptAddon: [
      '角色：Coder（编码执行者）',
      '- 先读再改：用 grep/glob/read 定位，再用 edit（优先）或 write 修改',
      '- 保持最小改动；说明改了哪些文件、为什么',
      '- 可用 bash 跑类型检查/测试/格式化，但避免破坏性命令（rm -rf、强制 push 等）',
      '- 完成后列出变更文件与验证方式',
    ].join('\n'),
    timeoutMs: 120_000,
    maxIterations: 24,
    maxOutputChars: 40_000,
  },

  shell: {
    role: 'shell',
    label: 'Shell',
    description:
      '命令与运行时诊断：执行脚本/构建/测试命令，结合读文件解读输出。',
    tools: [
      'bash',
      'read',
      'grep',
      'glob',
      'list_directory',
      'get_current_time',
      'write',
      'attach_content',
    ],
    systemPromptAddon: [
      '角色：Shell（命令执行与诊断）',
      '- 以 bash 为主收集运行时信息；用 read/grep 解读日志与配置',
      '- 命令失败时保留关键 stdout/stderr 摘要',
      '- 避免交互式/长时间挂起命令；避免破坏性操作',
      '- 输出：执行了什么、结果、结论与建议下一步',
    ].join('\n'),
    timeoutMs: 90_000,
    maxIterations: 16,
    maxOutputChars: 32_000,
  },

  writer: {
    role: 'writer',
    label: 'Writer',
    description:
      '文档与报告：整理材料、撰写 Markdown/报告，可创建 artifact 或 bundle 报告。',
    tools: [
      ...READ_TOOLS,
      ...WEB_TOOLS,
      'write',
      'edit',
      'create_artifact',
      'apply_artifact',
      'bundle_report',
      'attach_content',
    ],
    systemPromptAddon: [
      '角色：Writer（文档与报告）',
      '- 先用只读/检索工具收集材料，再组织结构并写入文档',
      '- 文风清晰、可扫读；需要时用 create_artifact / bundle_report 交付',
      '- 引用本地路径或 URL；不要编造未验证的事实',
    ].join('\n'),
    timeoutMs: 120_000,
    maxIterations: 20,
    maxOutputChars: 48_000,
  },

  general: {
    role: 'general',
    label: 'General',
    description:
      '通用宽任务面：读改文件、搜索、联网、bash、产物等大部分日常任务（不可再委托子代理）。',
    tools: [
      ...READ_TOOLS,
      ...WRITE_TOOLS,
      ...WEB_TOOLS,
      'bash',
      'create_artifact',
      'apply_artifact',
      'bundle_report',
      'attach_content',
      'remember',
    ],
    systemPromptAddon: [
      '角色：General（通用子代理）',
      '- 独立完成委托目标：可侦查、改文件、联网、执行命令、产出文档',
      '- 优先最小充分路径；完成后给出结果摘要与产物路径',
      '- 不要调用其他子代理；不要安装 skill 或跑全局维护任务',
    ].join('\n'),
    timeoutMs: 120_000,
    maxIterations: 24,
    maxOutputChars: 48_000,
  },
};

export const DEFAULT_SUBAGENT_ROLE: SubagentRole = 'general';

export function isSubagentRole(value: unknown): value is SubagentRole {
  return typeof value === 'string' && value in PROFILES;
}

export function getSubagentProfile(role: SubagentRole = DEFAULT_SUBAGENT_ROLE): SubagentProfile {
  return PROFILES[role] ?? PROFILES[DEFAULT_SUBAGENT_ROLE];
}

/** 主 Agent 选型用：角色列表摘要 */
export function listSubagentProfiles(): SubagentProfile[] {
  return (Object.keys(PROFILES) as SubagentRole[]).map((role) => PROFILES[role]);
}

/** 生成 delegate 工具可复用的角色目录。 */
export function formatSubagentRoleCatalogForTool(): string {
  return listSubagentProfiles()
    .map((p) => `- ${p.role}（${p.label}）：${p.description}`)
    .join('\n');
}

/**
 * 解析最终工具白名单：
 * - 显式 tools 优先（完全覆盖）
 * - 否则用角色默认集
 * - 始终剔除委托类工具，防止嵌套委托
 */
export function resolveSubagentTools(
  role: SubagentRole | undefined,
  explicitTools?: readonly string[],
): string[] {
  const profile = getSubagentProfile(role ?? DEFAULT_SUBAGENT_ROLE);
  const base = explicitTools && explicitTools.length > 0
    ? [...explicitTools]
    : [...profile.tools];
  const blocked = new Set(['delegate', 'delegate_task', 'ask_user', 'install_skill', 'run_dreams']);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of base) {
    if (!name || blocked.has(name) || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}
