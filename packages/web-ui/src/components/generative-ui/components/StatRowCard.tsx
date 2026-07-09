import type { GenerativeUiComponentProps } from "../registry";

export type StatRowProps = {
  items: Array<{ label: string; value: string | number; hint?: string }>;
};

export function StatRowCard({ data }: GenerativeUiComponentProps & { data: StatRowProps }) {
  return (
    <div className="gen-ui-card gen-ui-stat-row">
      {data.items.map((item, i) => (
        <div key={`${item.label}-${i}`} className="gen-ui-stat-item">
          <span className="gen-ui-stat-label">{item.label}</span>
          <strong className="gen-ui-stat-value">{item.value}</strong>
          {item.hint && <em className="gen-ui-stat-hint">{item.hint}</em>}
        </div>
      ))}
    </div>
  );
}
