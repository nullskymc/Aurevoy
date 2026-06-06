import type { FormEvent } from "react";

interface GoalComposerProps {
  busy: boolean;
  goal: string;
  online: boolean | null;
  onGoalChange: (goal: string) => void;
  onSubmit: (event: FormEvent) => void;
  onUseSuggestion: (goal: string) => void;
}

const suggestions = [
  "帮我整理今天需要处理的事项，并按优先级排序",
  "调研一个主题，给我一份可执行的摘要和下一步",
  "把一个复杂目标拆成计划，并持续推进到完成",
];

export function GoalComposer({
  busy,
  goal,
  online,
  onGoalChange,
  onSubmit,
  onUseSuggestion,
}: GoalComposerProps) {
  const disabled = busy || online === false;

  return (
    <section className="goal-composer" aria-labelledby="goal-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Goal</p>
          <h2 id="goal-title">告诉 Aurevoy 你想完成什么</h2>
        </div>
        <span className="engine-indicator" data-online={String(online)}>
          {online === null ? "检测中" : online ? "引擎在线" : "引擎离线"}
        </span>
      </div>

      <form className="goal-form" onSubmit={onSubmit}>
        <textarea
          value={goal}
          onChange={(event) => onGoalChange(event.currentTarget.value)}
          placeholder="例如：帮我调研本周 AI 桌面 Agent 的产品趋势，并整理成一份行动清单。"
          rows={3}
        />
        <div className="goal-actions">
          <div className="suggestion-row" aria-label="建议目标">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="suggestion-chip"
                onClick={() => onUseSuggestion(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>
          <button className="primary-action" type="submit" disabled={disabled}>
            {busy ? "执行中" : "开始执行"}
          </button>
        </div>
      </form>
    </section>
  );
}
