import type React from "react";

export function SettingsGroup({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section className="settings-content-group">
      <h2>{title}</h2>
      <div className="settings-row-card">{children}</div>
    </section>
  );
}


export function SettingsChoiceGroup({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section className="settings-content-group">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function SettingsInfoRow({
  description,
  title,
  value,
}: {
  description: string;
  title: string;
  value?: string;
}) {
  return (
    <div className="settings-row">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      {value && <em>{value}</em>}
    </div>
  );
}

/** 卡片内说明行：与 settings-row 同结构，无右侧控件。 */
export function SettingsNoteRow({ description, title }: { description: string; title: string }) {
  return (
    <div className="settings-row settings-row-note">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    </div>
  );
}

export function SettingsBudgetField({
  hint,
  label,
  value,
  onChange,
}: {
  hint: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="settings-budget-field">
      <span className="settings-budget-field-label">{label}</span>
      <span className="settings-budget-field-control">
        <input
          className="settings-budget-input"
          type="number"
          min={1}
          value={value}
          onChange={(event) => onChange(Math.max(1, Number(event.currentTarget.value) || 1))}
        />
        <span className="settings-budget-field-hint">{hint}</span>
      </span>
    </label>
  );
}

export function SettingsActionRow({
  control,
  description,
  title,
}: {
  control: React.ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div className="settings-row">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <div className="settings-row-control">{control}</div>
    </div>
  );
}

export function SettingsSelectRow({
  description,
  options,
  title,
  value,
  onChange,
}: {
  description: string;
  options: Array<{ label: string; value: string }>;
  title: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="settings-row">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <select
        className="settings-select"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function SettingsSwitchRow({
  checked,
  description,
  title,
  onChange,
}: {
  checked: boolean;
  description: string;
  title: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-row settings-switch-row">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
    </label>
  );
}
