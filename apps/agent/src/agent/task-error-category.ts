import type { TaskErrorCategory } from '@aurevoy/shared';

/** 将跨 provider / Node / 本地运行时的错误映射为用户可理解的恢复类别。 */
export function classifyTaskError(
  error: unknown,
  fallback: TaskErrorCategory = 'unknown',
): TaskErrorCategory {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const haystack = `${message}\n${code}`.toLowerCase();

  if (
    message.includes('未配置 LLM') ||
    message.includes('未选择模型') ||
    message.includes('未支持的 Provider') ||
    /api key|apikey|credential|凭证|配置/.test(haystack)
  ) return 'configuration';
  if (/aborted|aborterror|取消|cancelled|canceled/.test(haystack)) return 'cancelled';
  if (/budget|预算|max.?iterations|最大轮次|token limit|上下文上限/.test(haystack)) return 'budget';
  if (/timeout|timed out|etimedout|超时/.test(haystack)) return 'timeout';
  if (/eacces|eperm|permission|forbidden|unauthorized|权限|无权|拒绝访问/.test(haystack)) return 'permission';
  if (/parse|syntax|json|schema|解析|格式/.test(haystack)) return 'parse';
  if (
    /econnreset|econnrefused|enotfound|enetunreach|ehostunreach|fetch failed|network|socket|dns|http 4\d\d|http 5\d\d|连接失败|网络/.test(haystack)
  ) return 'network';
  if (/sqlite|database|session|harness|runtime|event loop|engine|引擎|数据库|会话树/.test(haystack)) return 'engine';
  return fallback;
}
