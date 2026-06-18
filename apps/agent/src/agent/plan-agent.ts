/**
 * Plan Agent — 按需调用的规划引擎。
 *
 * 由 Default Agent（loop.ts）在判断任务复杂时调用：
 * 1. Scout 阶段 — 快读工作区，了解文件结构和约束
 * 2. LLM 生成结构化计划（JSON）
 * 3. 失败回退到启发式计划
 *
 * Plan Agent 是独立模块，与 subagent.ts 平级但不共享其实现。
 * Scout/LLM Plan 逻辑从 loop.ts 迁入，保持 loop.ts 精简。
 */

import { randomUUID } from 'node:crypto';
import type {
  GeneratedPlan,
  Message,
  ScoutReport,
} from '@aurevoy/shared';
import { getProvider, type AccumulatedToolCall } from '../llm/provider.js';
import { toolRegistry } from '../tools/registry.js';
import { config } from '../config.js';
import { taskEvents } from './events.js';

const SCOUT_TOOL_NAMES = new Set(['list_directory', 'read_file', 'search_files']);

export interface PlanAgentInput {
  taskId: string;
  goal: string;
  workspaceDir: string;
  signal: AbortSignal;
}

export interface PlanAgentOutput {
  /** 2-8 个有序执行步骤 */
  steps: GeneratedPlan['steps'];
  /** 侦查报告（LLM 路径时有值） */
  scoutReport?: ScoutReport;
  /** 计划来源 */
  source: 'llm' | 'heuristic';
  /** 预估迭代轮数 */
  estimatedIterations: number;
  /** 风险等级 */
  riskLevel: 'low' | 'medium' | 'high';
}

/**
 * 运行 Plan Agent：侦查 → LLM 生成计划 → 启发式兜底。
 */
export async function runPlanAgent(input: PlanAgentInput): Promise<PlanAgentOutput> {
  const { taskId, goal, workspaceDir, signal } = input;

  if (config.agent.llmPlanningEnabled) {
    try {
      taskEvents.publish({ type: 'scout_started', taskId });

      const scoutReport = await runScoutPhase(goal, workspaceDir, signal);

      if (scoutReport && !signal.aborted) {
        taskEvents.publish({ type: 'scout_report', taskId, report: scoutReport });
      }

      if (scoutReport && !signal.aborted) {
        const generated = await generatePlanViaLLM(goal, scoutReport, signal);
        if (generated && generated.steps.length > 0 && !signal.aborted) {
          return {
            steps: generated.steps,
            scoutReport,
            source: 'llm',
            estimatedIterations: generated.estimatedIterations,
            riskLevel: generated.riskLevel,
          };
        }
      }
    } catch {
      // LLM 规划失败，静默回退到启发式计划
    }
  }

  // 回退：正则启发式计划
  const descriptions = inferStructuredPlan(goal);
  if (descriptions.length === 0) {
    return {
      steps: [{ description: '正在执行任务…', verifiable: false, dependsOn: [] }],
      source: 'heuristic',
      estimatedIterations: 1,
      riskLevel: 'low',
    };
  }

  return {
    steps: descriptions.map((d) => ({ description: d, verifiable: false, dependsOn: [] })),
    source: 'heuristic',
    estimatedIterations: descriptions.length * 2,
    riskLevel: 'low',
  };
}

// ---- Scout Phase ----

async function runScoutPhase(
  goal: string,
  workspaceDir: string,
  signal: AbortSignal,
): Promise<ScoutReport | null> {
  const startedAt = Date.now();
  const maxRounds = config.agent.maxScoutRounds;
  const scoutTools = toolRegistry.list().filter((t) => SCOUT_TOOL_NAMES.has(t.name));

  const messages: Message[] = [
    {
      id: randomUUID(),
      role: 'system',
      content:
        '你是 Aurevoy 的侦查 Agent。你的任务是快速了解工作区的文件结构和关键信息，' +
        '为后续的任务规划提供依据。\n\n' +
        '约束：\n' +
        '- 只能使用 list_directory、read_file、search_files 工具\n' +
        '- 不要修改任何文件，不要执行命令\n' +
        '- 不要做深入分析——这是快速侦查，不是执行任务\n' +
        '- 当你觉得已经掌握了足够信息来制定计划时，直接输出侦查报告，不再调用工具',
      createdAt: new Date().toISOString(),
    },
    {
      id: randomUUID(),
      role: 'user',
      content: `用户目标：${goal}\n工作区路径：${workspaceDir}\n\n请快速侦查工作区，然后输出一份侦查报告。`,
      createdAt: new Date().toISOString(),
    },
  ];

  let rounds = 0;
  for (; rounds < maxRounds; rounds++) {
    if (signal.aborted) return null;

    let textBuffer = '';
    let toolCalls: AccumulatedToolCall[] = [];

    try {
      const stream = getProvider().stream(messages, {
        tools: scoutTools.length > 0 ? scoutTools : undefined,
        toolChoice: 'auto',
        signal,
      });
      for await (const chunk of stream) {
        if (chunk.textDelta) textBuffer += chunk.textDelta;
        if (chunk.done) toolCalls = chunk.toolCallsSnapshot ?? [];
      }
    } catch {
      return null;
    }

    if (signal.aborted) return null;

    if (toolCalls.length === 0) {
      return parseScoutReport(textBuffer, rounds + 1, Date.now() - startedAt);
    }

    // 添加 assistant 消息
    const assistantMsg: Message = {
      id: randomUUID(),
      role: 'assistant',
      content: textBuffer,
      createdAt: new Date().toISOString(),
    };
    if (toolCalls.length > 0) {
      assistantMsg.toolCalls = toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));
    }
    messages.push(assistantMsg);

    // 执行工具（仅 scout 工具，无审批）
    for (const tc of toolCalls) {
      const name = tc.function.name;
      if (!SCOUT_TOOL_NAMES.has(name)) {
        messages.push({
          id: randomUUID(),
          role: 'tool',
          content: JSON.stringify({ error: `侦查阶段不允许使用工具：${name}` }),
          toolCallId: tc.id,
          createdAt: new Date().toISOString(),
        });
        continue;
      }

      let args: Record<string, unknown>;
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        messages.push({
          id: randomUUID(),
          role: 'tool',
          content: JSON.stringify({ error: '工具参数不是合法 JSON' }),
          toolCallId: tc.id,
          createdAt: new Date().toISOString(),
        });
        continue;
      }

      try {
        const result = await toolRegistry.invokeWithTimeout(
          { id: tc.id, toolName: name, args },
          { taskId: undefined, workspaceDir, abortSignal: signal },
          config.agent.toolTimeoutMs,
        );
        messages.push({
          id: randomUUID(),
          role: 'tool',
          content: JSON.stringify(result.ok ? result.output : { error: result.error }),
          toolCallId: tc.id,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        messages.push({
          id: randomUUID(),
          role: 'tool',
          content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          toolCallId: tc.id,
          createdAt: new Date().toISOString(),
        });
      }
    }
  }

  // 达到最大轮次，用已有文本生成报告
  return parseScoutReport(
    `侦查轮次达到上限 (${maxRounds})。基于已有信息的侦查摘要：\n${messages.slice(-3).map((m) => m.content).join('\n')}`,
    maxRounds,
    Date.now() - startedAt,
  );
}

function parseScoutReport(text: string, rounds: number, durationMs: number): ScoutReport {
  const keyFiles: ScoutReport['keyFiles'] = [];
  const fileMatch = text.matchAll(/[`'"]?([a-zA-Z0-9_\-./]+\.(?:ts|tsx|js|jsx|json|md|rs|toml|css|html|py|yaml|yml))[`'"]?/g);
  const seen = new Set<string>();
  for (const m of fileMatch) {
    const path = m[1];
    if (!seen.has(path)) {
      seen.add(path);
      keyFiles.push({ path, reason: '侦查发现' });
    }
  }

  const constraints: string[] = [];
  if (text.includes('package.json')) constraints.push('Node.js 项目');
  if (text.includes('Cargo.toml')) constraints.push('Rust 项目');
  if (text.includes('tsconfig.json')) constraints.push('TypeScript 项目');

  const firstLine = text.split('\n')[0]?.trim() ?? '';
  const summary = firstLine.length > 10 ? firstLine : text.slice(0, 200).trim();

  return {
    summary,
    keyFiles: keyFiles.slice(0, 20),
    techStack: constraints.length > 0 ? constraints : undefined,
    constraints: [],
    rounds,
    durationMs,
  };
}

// ---- LLM Plan Generation ----

async function generatePlanViaLLM(
  goal: string,
  scoutReport: ScoutReport,
  signal: AbortSignal,
): Promise<GeneratedPlan | null> {
  const keyFilesStr = scoutReport.keyFiles
    .map((f) => `- ${f.path}${f.reason ? ` (${f.reason})` : ''}`)
    .join('\n');
  const constraintsStr = scoutReport.constraints.length > 0
    ? scoutReport.constraints.map((c) => `- ${c}`).join('\n')
    : '（无特殊约束）';

  const planMessages: Message[] = [
    {
      id: randomUUID(),
      role: 'system',
      content:
        '你是 Aurevoy 的任务规划器。根据用户目标和侦查报告，将任务分解为 2-8 个有序执行步骤。\n\n' +
        '输出要求：\n' +
        '- 严格输出 JSON，不要加任何前缀或后缀文字\n' +
        '- 每个步骤描述清晰、可独立验证\n' +
        '- 如果步骤之间有依赖关系，在 dependsOn 中注明前置步骤序号（1-based）\n' +
        '- 如果步骤预期产生可预览产物，标记 verifiable=true\n\n' +
        'JSON 格式：\n' +
        '{\n' +
        '  "steps": [\n' +
        '    {\n' +
        '      "description": "步骤描述",\n' +
        '      "toolsExpected": ["tool_name"],\n' +
        '      "verifiable": true,\n' +
        '      "dependsOn": []\n' +
        '    }\n' +
        '  ],\n' +
        '  "estimatedIterations": 5,\n' +
        '  "riskLevel": "low"\n' +
        '}',
      createdAt: new Date().toISOString(),
    },
    {
      id: randomUUID(),
      role: 'user',
      content:
        `用户目标：${goal}\n\n` +
        `侦查报告：\n${scoutReport.summary}\n\n` +
        `关键文件：\n${keyFilesStr}\n\n` +
        `约束条件：\n${constraintsStr}\n\n` +
        `技术栈：${scoutReport.techStack?.join(', ') ?? '未识别'}\n\n` +
        `请输出 JSON 格式的执行计划。`,
      createdAt: new Date().toISOString(),
    },
  ];

  try {
    let textBuffer = '';
    const stream = getProvider().stream(planMessages, {
      toolChoice: 'none',
      signal,
      temperature: 0.3,
    });
    for await (const chunk of stream) {
      if (chunk.textDelta) textBuffer += chunk.textDelta;
    }

    if (signal.aborted || !textBuffer.trim()) return null;

    const jsonMatch = textBuffer.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.steps || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      return null;
    }

    const steps = parsed.steps.slice(0, 8).map((step: unknown) => {
      if (typeof step !== 'object' || step === null) return null;
      const s = step as Record<string, unknown>;
      return {
        description: typeof s.description === 'string' ? s.description : String(s.description ?? ''),
        toolsExpected: Array.isArray(s.toolsExpected)
          ? s.toolsExpected.filter((item): item is string => typeof item === 'string')
          : undefined,
        verifiable: typeof s.verifiable === 'boolean' ? s.verifiable : undefined,
        dependsOn: Array.isArray(s.dependsOn)
          ? s.dependsOn.map(String)
          : undefined,
      };
    }).filter(Boolean) as GeneratedPlan['steps'];

    if (steps.length === 0) return null;

    return {
      steps,
      estimatedIterations:
        typeof parsed.estimatedIterations === 'number' && parsed.estimatedIterations > 0
          ? Math.min(parsed.estimatedIterations, 50)
          : steps.length * 3,
      riskLevel:
        parsed.riskLevel === 'low' || parsed.riskLevel === 'medium' || parsed.riskLevel === 'high'
          ? parsed.riskLevel
          : 'medium',
    };
  } catch {
    return null;
  }
}

// ---- Heuristic Fallback ----

function inferStructuredPlan(goal: string): string[] {
  const text = goal.toLowerCase();
  const steps: string[] = [];
  if (/(整理|总结|summary|report|材料|资料|文件|docs?|markdown|md|todo|搜索|search)/i.test(goal)) {
    steps.push('扫描工作区材料');
    steps.push('阅读与提取关键信息');
  }
  if (/(网页|url|http|fetch|抓取|网站|页面)/i.test(goal)) {
    steps.push('抓取并清洗网页来源');
    steps.push('提取网页正文与链接');
  }
  if (/(运行|执行|命令|typecheck|build|test|npm|脚本|command)/i.test(goal)) {
    steps.push('确认命令执行边界');
    steps.push('运行命令并收集输出');
  }
  if (/(生成|写入|保存|artifact|报告|summary|markdown|md|翻译|输出)/i.test(goal)) {
    steps.push('生成可预览产物');
    steps.push('确认后保存结果');
  }
  const unique = [...new Set(steps)];
  if (unique.length < 2 || !text.trim()) return [];
  unique.push('汇总结果并说明后续建议');
  return unique.slice(0, 6);
}
