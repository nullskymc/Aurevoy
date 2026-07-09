import { useMemo, useState } from "react";
import type { GenerativeUiComponentProps } from "../registry";

export type CalculatorProps = {
  title?: string;
  formula: string;
  fields: Array<{ id: string; label: string; value: number }>;
};

export function CalculatorCard({ data }: GenerativeUiComponentProps & { data: CalculatorProps }) {
  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(data.fields.map((f) => [f.id, f.value])),
  );

  const result = useMemo(() => evaluateFormula(data.formula, values), [data.formula, values]);

  return (
    <div className="gen-ui-card gen-ui-calc-card">
      <header className="gen-ui-card-head">
        <strong>{data.title || "计算器"}</strong>
        <code className="gen-ui-calc-formula">{data.formula}</code>
      </header>
      <div className="gen-ui-calc-fields">
        {data.fields.map((field) => (
          <label key={field.id} className="gen-ui-calc-field">
            <span>{field.label}</span>
            <input
              type="number"
              value={Number.isFinite(values[field.id]) ? values[field.id] : 0}
              onChange={(e) => {
                const n = Number(e.currentTarget.value);
                setValues((prev) => ({ ...prev, [field.id]: Number.isFinite(n) ? n : 0 }));
              }}
            />
          </label>
        ))}
      </div>
      <div className="gen-ui-calc-result" role="status">
        <span>结果</span>
        <strong>{result.ok ? formatNum(result.value) : "—"}</strong>
        {!result.ok && <em>{result.error}</em>}
      </div>
    </div>
  );
}

function evaluateFormula(
  formula: string,
  values: Record<string, number>,
): { ok: true; value: number } | { ok: false; error: string } {
  // 仅替换标识符为数字后，用 Function 在严格受限字符集下求值（已在服务端限制字符）
  if (!/^[a-zA-Z0-9_+\-*/().\s]+$/.test(formula)) {
    return { ok: false, error: "非法公式" };
  }
  let expr = formula;
  const ids = Object.keys(values).sort((a, b) => b.length - a.length);
  for (const id of ids) {
    expr = expr.replace(new RegExp(`\\b${id}\\b`, "g"), String(values[id] ?? 0));
  }
  if (/[a-zA-Z_]/.test(expr)) {
    return { ok: false, error: "未知变量" };
  }
  try {
    // eslint-disable-next-line no-new-func
    const value = Function(`"use strict"; return (${expr});`)() as unknown;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, error: "非数值结果" };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, error: "计算失败" };
  }
}

function formatNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}
