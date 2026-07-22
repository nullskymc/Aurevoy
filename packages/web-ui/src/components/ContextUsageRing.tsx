type ContextUsageRingProps = {
  usedTokens: number;
  tokenBudget: number;
  label: string;
  unit: string;
  formatTokens: (value: number) => string;
};

/**
 * 将上下文占用比例绘制为紧凑圆环；完整数值仅保留在提示和无障碍文本中。
 */
export function ContextUsageRing({
  usedTokens,
  tokenBudget,
  label,
  unit,
  formatTokens,
}: ContextUsageRingProps) {
  // 预算异常时显示空环，避免 SVG 的 strokeDashoffset 出现无效值。
  const ratio = tokenBudget > 0 ? Math.min(Math.max(usedTokens / tokenBudget, 0), 1) : 0;
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - ratio);
  const details = `${label} ~${formatTokens(usedTokens)} / ${formatTokens(tokenBudget)} ${unit}`;
  const percentage = Math.round(ratio * 100);

  return (
    <div className="context-usage-ring" title={details} role="img" aria-label={details}>
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <circle className="context-usage-ring__track" cx="10" cy="10" r={radius} />
        <circle
          className="context-usage-ring__value"
          cx="10"
          cy="10"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <span className="context-usage-ring__tooltip" aria-hidden="true">
        {details} ({percentage}%)
      </span>
    </div>
  );
}
