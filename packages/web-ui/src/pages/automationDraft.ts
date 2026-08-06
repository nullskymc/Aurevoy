import type { TaskBudget } from "@aurevoy/shared";

/** 自动化表单使用字符串承载空值，避免输入框出现 NaN；提交时再转成正整数预算。 */
export function parseBudgetLimit(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** 空预算表示沿用引擎默认限制，避免从历史对话隐式复制权限或额度。 */
export function budgetFromDraft(iterations: string, toolCalls: string): TaskBudget | undefined {
  const budget: TaskBudget = {
    maxIterations: parseBudgetLimit(iterations),
    maxToolCalls: parseBudgetLimit(toolCalls),
  };
  return budget.maxIterations === undefined && budget.maxToolCalls === undefined ? undefined : budget;
}
