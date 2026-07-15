import type { ComponentType } from "react";
import type { UiCanvasNode, UiCanvasProps } from "@aurevoy/shared";
import { CanvasCard } from "./components/CanvasCard";

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


function validateCanvas(props: unknown): { ok: true; data: UiCanvasProps } | { ok: false; error: string } {
  const o = asObject(props);
  if (!o) return { ok: false, error: "props 必须是对象" };

  // JS 模式和声明式模式二选一：前者交给 sandbox iframe，后者走基础原语渲染器。
  const hasCode = typeof o.html === "string" || typeof o.css === "string" || typeof o.script === "string";
  if (hasCode) {
    if (typeof o.html !== "string" || !o.html.trim() || typeof o.script !== "string" || !o.script.trim()) return { ok: false, error: "JS 模式需要 html + script" };
  } else {
    if (!Array.isArray(o.body) || o.body.length === 0) return { ok: false, error: "声明式模式需要非空 body 节点数组" };
    if (!o.body.every(isCanvasNode)) return { ok: false, error: "body 包含无效节点" };
  }

  const rawState = asObject(o.state) ?? {};
  return {
    ok: true,
    data: {
      title: typeof o.title === "string" ? o.title : undefined,
      description: typeof o.description === "string" ? o.description : undefined,
      state: rawState as UiCanvasProps["state"],
      body: Array.isArray(o.body) ? o.body as UiCanvasNode[] : undefined,
      html: typeof o.html === "string" ? o.html : undefined,
      css: typeof o.css === "string" ? o.css : undefined,
      script: typeof o.script === "string" ? o.script : undefined,
    },
  };
}

const CANVAS_NODE_TYPES = new Set([
  "section", "row", "column", "grid", "heading", "text", "badge", "divider", "spacer", "progress",
  "button", "input", "textarea", "select", "checkbox",
]);

function isCanvasNode(value: unknown, depth = 0): value is UiCanvasNode {
  if (depth > 6) return false;
  const node = asObject(value);
  if (!node || typeof node.type !== "string" || !CANVAS_NODE_TYPES.has(node.type)) return false;
  return node.children === undefined || (Array.isArray(node.children) && node.children.every((child) => isCanvasNode(child, depth + 1)));
}

// component 用宽松类型包装，避免每个卡片 props 泛型打架
type AnyCard = ComponentType<GenerativeUiComponentProps & { data: unknown }>;

export const generativeUiRegistry: Record<string, {
  validate: (props: unknown) => { ok: true; data: unknown } | { ok: false; error: string };
  component: AnyCard;
}> = {
  canvas: {
    validate: validateCanvas,
    component: CanvasCard as AnyCard,
  },
};
