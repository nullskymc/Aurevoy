import type { ComponentType } from "react";
import { DataTableCard, type DataTableProps } from "./components/DataTableCard";
import { StatRowCard, type StatRowProps } from "./components/StatRowCard";
import { ChoiceCard, type ChoiceProps } from "./components/ChoiceCard";
import { CalculatorCard, type CalculatorProps } from "./components/CalculatorCard";
import { StackCard, type StackProps } from "./components/StackCard";

export type GenerativeUiComponentProps = {
  id: string;
  props: unknown;
  onChoiceSubmit?: (payload: { partId: string; actionId: string; selection: unknown }) => void;
};

export type GenerativeUiDefinition = {
  kind: string;
  /** 轻量运行时校验；失败返回 error 文案 */
  validate: (props: unknown) => { ok: true; data: unknown } | { ok: false; error: string };
  component: ComponentType<GenerativeUiComponentProps & { data: never }>;
};

function asObject(props: unknown): Record<string, unknown> | null {
  if (!props || typeof props !== "object" || Array.isArray(props)) return null;
  return props as Record<string, unknown>;
}

function validateDataTable(props: unknown): { ok: true; data: DataTableProps } | { ok: false; error: string } {
  const o = asObject(props);
  if (!o) return { ok: false, error: "props 必须是对象" };
  if (!Array.isArray(o.columns) || o.columns.length === 0) {
    return { ok: false, error: "需要 columns" };
  }
  if (!Array.isArray(o.rows)) return { ok: false, error: "需要 rows" };
  return {
    ok: true,
    data: {
      title: typeof o.title === "string" ? o.title : undefined,
      columns: o.columns.map(String),
      rows: o.rows as DataTableProps["rows"],
      features: Array.isArray(o.features) ? o.features.map(String) : ["sort", "copy"],
    },
  };
}

function validateStatRow(props: unknown): { ok: true; data: StatRowProps } | { ok: false; error: string } {
  const o = asObject(props);
  if (!o || !Array.isArray(o.items)) return { ok: false, error: "需要 items" };
  return {
    ok: true,
    data: {
      items: o.items as StatRowProps["items"],
    },
  };
}

function validateChoice(props: unknown): { ok: true; data: ChoiceProps } | { ok: false; error: string } {
  const o = asObject(props);
  if (!o || typeof o.prompt !== "string" || !Array.isArray(o.options)) {
    return { ok: false, error: "需要 prompt 与 options" };
  }
  return {
    ok: true,
    data: {
      prompt: o.prompt,
      multi: o.multi === true,
      options: o.options as ChoiceProps["options"],
    },
  };
}

function validateCalculator(props: unknown): { ok: true; data: CalculatorProps } | { ok: false; error: string } {
  const o = asObject(props);
  if (!o || !Array.isArray(o.fields) || typeof o.formula !== "string") {
    return { ok: false, error: "需要 fields 与 formula" };
  }
  return {
    ok: true,
    data: {
      title: typeof o.title === "string" ? o.title : undefined,
      formula: o.formula,
      fields: o.fields as CalculatorProps["fields"],
    },
  };
}

function validateStack(props: unknown): { ok: true; data: StackProps } | { ok: false; error: string } {
  const o = asObject(props);
  if (!o || !Array.isArray(o.children)) return { ok: false, error: "需要 children" };
  return {
    ok: true,
    data: {
      children: o.children as StackProps["children"],
    },
  };
}

// component 用宽松类型包装，避免每个卡片 props 泛型打架
type AnyCard = ComponentType<GenerativeUiComponentProps & { data: unknown }>;

export const generativeUiRegistry: Record<string, {
  validate: (props: unknown) => { ok: true; data: unknown } | { ok: false; error: string };
  component: AnyCard;
}> = {
  data_table: {
    validate: validateDataTable,
    component: DataTableCard as AnyCard,
  },
  stat_row: {
    validate: validateStatRow,
    component: StatRowCard as AnyCard,
  },
  choice: {
    validate: validateChoice,
    component: ChoiceCard as AnyCard,
  },
  calculator: {
    validate: validateCalculator,
    component: CalculatorCard as AnyCard,
  },
  stack: {
    validate: validateStack,
    component: StackCard as AnyCard,
  },
};
