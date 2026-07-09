import { useState } from "react";
import type { GenerativeUiComponentProps } from "../registry";

export type ChoiceProps = {
  prompt: string;
  multi?: boolean;
  options: Array<{ id: string; label: string }>;
};

export function ChoiceCard({
  id,
  data,
  onChoiceSubmit,
}: GenerativeUiComponentProps & { data: ChoiceProps }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);

  function toggle(optionId: string): void {
    if (submitted) return;
    if (!data.multi) {
      setSelected([optionId]);
      return;
    }
    setSelected((prev) =>
      prev.includes(optionId) ? prev.filter((x) => x !== optionId) : [...prev, optionId],
    );
  }

  function submit(): void {
    if (submitted || selected.length === 0 || !onChoiceSubmit) return;
    setSubmitted(true);
    onChoiceSubmit({
      partId: id,
      actionId: "select",
      selection: data.multi ? selected : selected[0],
    });
  }

  return (
    <div className="gen-ui-card gen-ui-choice-card" data-submitted={submitted}>
      <p className="gen-ui-choice-prompt">{data.prompt}</p>
      <div className="gen-ui-choice-options">
        {data.options.map((opt) => {
          const active = selected.includes(opt.id);
          return (
            <button
              key={opt.id}
              type="button"
              className="gen-ui-choice-opt"
              data-active={active}
              disabled={submitted}
              onClick={() => toggle(opt.id)}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      <div className="gen-ui-card-actions">
        <button
          type="button"
          className="gen-ui-btn gen-ui-btn-primary"
          disabled={submitted || selected.length === 0 || !onChoiceSubmit}
          onClick={submit}
        >
          {submitted ? "已提交" : data.multi ? "确认选择" : "选择"}
        </button>
      </div>
    </div>
  );
}
